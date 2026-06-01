/**
 * Scenario-2 auto-publisher.
 *
 * Two responsibilities, run sequentially every minute:
 *
 *   A) Fire calendar schedule slots whose time has come.
 *      `UploadScheduleItem` rows with status='scheduled' and
 *      `scheduled_at <= now` get pushed to social via the existing
 *      bridge (`upload_schedule_item` → `create_upload`). One social
 *      upload row is created per platform on the parent batch.
 *
 *   B) Publish Instagram containers we deliberately deferred.
 *      The IG upload service can't natively schedule — when the user
 *      asks for a future publish we create the container and stop. This
 *      sweep finds those `social_uploads` rows (status='scheduled',
 *      platform='instagram', has creation_id, scheduled_at past) and
 *      calls /media_publish on the now-ready container.
 *
 * Idempotency: phase A skips slots that already have at least one
 * `social_uploads` row (so a slow run won't double-publish if the cron
 * fires twice). Phase B sets status='uploaded' immediately on success
 * — re-runs after that are no-ops.
 */

import { Op } from "sequelize";
import {
    SocialAccount,
    SocialUpload,
    UploadScheduleItem,
    UploadScheduleBatch,
} from "../../db/models";
import { upload_schedule_item } from "../../modules/social_upload/social_upload.service";
import { publish_existing_instagram_container } from "./instagram_upload.service";
import { sendPushToUser } from "../notification/firebase-notification.service";
import { register, run } from "../../cron/registry";

const CRON_ID = "auto-publish";
const TICK_INTERVAL_MS = 60 * 1000;
/**
 * Maximum slots to actually fire per tick. With the tick at 60 s, this
 * spreads out a backlog (e.g. after a restart) across multiple ticks
 * instead of slamming every overdue slot through one tick. Earlier
 * `scheduled_at` items still go first because the query is ordered ASC.
 *
 * The previous version had no limit + a 60 s lookahead, which is what
 * caused the symptom of "two slots at 8 AM and 5 PM both firing after
 * 8 AM one by one" when the cron picked up an unexpectedly large
 * batch in a single tick.
 */
const MAX_FIRES_PER_TICK = 3;

function clog(step: string, data?: Record<string, any>) {
    console.log(`[social-cron] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

/**
 * Phase A — find calendar schedule items whose time has STRICTLY passed
 * (no lookahead), and that haven't already been pushed.
 *
 * Two layers of defence so a future slot can never accidentally fire:
 *   1. SQL filter `scheduled_at <= now`. NULL rows are filtered out
 *      implicitly (NULL <= x evaluates to NULL → excluded).
 *   2. In-memory re-check after the query. Sequelize / driver edge
 *      cases can't slip a future slot through this.
 *
 * The per-tick MAX_FIRES_PER_TICK cap also ensures we never fire two
 * "should be hours apart" slots back-to-back if both somehow look due
 * at the same moment.
 */
async function fire_due_schedule_items() {
    const now = new Date();

    const candidates = await UploadScheduleItem.findAll({
        where: {
            status: "scheduled",
            scheduled_at: { [Op.lte]: now },
        } as any,
        order: [["scheduled_at", "ASC"]],
        limit: 100,
    });

    // Defensive in-memory filter — guarantees scheduled_at is non-null
    // AND actually <= now, regardless of any quirk in how the query was
    // compiled. This is the line that prevents a 5 PM slot from being
    // fired at 8 AM if anything upstream is mis-typed.
    const now_ms = now.getTime();
    const due_items = candidates.filter((c) => {
        const sa = (c as any).scheduled_at as Date | null | undefined;
        if (!sa) return false;
        const sa_ms = (sa instanceof Date ? sa : new Date(sa)).getTime();
        return Number.isFinite(sa_ms) && sa_ms <= now_ms;
    });

    if (due_items.length === 0) return { fired: 0, skipped: 0 };

    if (due_items.length > MAX_FIRES_PER_TICK) {
        clog("tick_capped", {
            due_total: due_items.length,
            firing_this_tick: MAX_FIRES_PER_TICK,
            tail_will_fire_next_ticks: due_items.length - MAX_FIRES_PER_TICK,
        });
    }
    // Renamed from `batch` to `tick_batch` so the inner per-slot loop
    // can keep using its own `batch` variable (the parent
    // UploadScheduleBatch row).
    const tick_batch = due_items.slice(0, MAX_FIRES_PER_TICK);

    let fired = 0;
    let skipped = 0;
    for (const item of tick_batch) {
        // Skip if any social_upload already exists for this slot — keeps
        // the cron idempotent across restarts and tick overlap.
        const already = await SocialUpload.count({
            where: { schedule_item_id: item.id } as any,
        });
        if (already > 0) {
            skipped += 1;
            continue;
        }

        const batch = (item as any).batch_id
            ? await UploadScheduleBatch.findByPk((item as any).batch_id)
            : null;
        const platforms = (batch?.platforms ?? item.platforms ?? []) as string[];
        const library_item_id = (item as any).library_item_id as string | null;
        if (!library_item_id || platforms.length === 0) {
            // Mark cancelled so we don't keep retrying a row that can't
            // possibly succeed. Surface a clear error_message via the
            // schedule item's metadata so the schedules page shows it.
            await item.update({
                status: "cancelled",
                metadata: { ...(item.metadata as any), cron_skipped: !library_item_id ? "no library_item_id" : "no platforms" },
            } as any);
            skipped += 1;
            continue;
        }

        const scheduled_at_iso = (() => {
            const sa = (item as any).scheduled_at;
            if (!sa) return null;
            const d = sa instanceof Date ? sa : new Date(sa);
            return Number.isFinite(d.getTime()) ? d.toISOString() : null;
        })();
        const overdue_ms = scheduled_at_iso
            ? now_ms - new Date(scheduled_at_iso).getTime()
            : 0;
        clog("fire_slot", {
            schedule_item_id: item.id,
            library_item_id,
            platforms,
            auto_details: !!(item as any).auto_details,
            scheduled_at: scheduled_at_iso,
            now: now.toISOString(),
            overdue_seconds: Math.round(overdue_ms / 1000),
        });

        // Delegate to the same bridge handler the manual "Upload Now"
        // button uses. That handler reads `auto_details`, `title`,
        // `description`, `caption`, `tags`, `hashtags`, and
        // `platform_details` from the saved schedule item and builds the
        // correct synthetic body — including `manual_details` so
        // create_upload's resolve_details runs the analysis with manual
        // overrides applied per-field. Building the body in two places
        // got us into trouble: the previous hand-rolled version dropped
        // auto_details and stripped the user's intent at fire time.
        const synthetic_req = {
            userId: item.user_id,
            params: { schedule_item_id: item.id },
            // upload_schedule_item only reads userId + params — body is
            // ignored — but we set it for parity with the HTTP shape.
            body: {},
        } as any;

        try {
            const result: any = await upload_schedule_item(synthetic_req);
            // Bridge returns the standard envelope; on validation /
            // ownership / "no library_item_id" errors it returns an
            // `error` envelope WITHOUT throwing.
            if (result?.error) {
                clog("slot_bridge_rejected", { schedule_item_id: item.id, message: result.error.message });
                await item.update({
                    status: "failed",
                    error_message: (result.error.message ?? "Bridge rejected").slice(0, 500),
                } as any);
                continue;
            }
            const uploads = result?.data?.uploads ?? [];
            const ok = uploads.filter((u: any) => u.status === "uploaded" || u.status === "scheduled").length;
            const failed = uploads.filter((u: any) => u.status === "failed").length;
            await item.update({
                status: ok > 0 ? "uploaded" : "failed",
                error_message: failed > 0 ? `${failed} platform(s) failed — see Social Media → Recent uploads` : null,
            } as any);
            clog("slot_done", { schedule_item_id: item.id, ok, failed });
            fired += 1;
        } catch (err: any) {
            clog("slot_failed", { schedule_item_id: item.id, error: err?.message ?? String(err) });
            await item.update({
                status: "failed",
                error_message: (err?.message ?? "Auto-push failed").slice(0, 500),
            } as any);
            // The whole slot fell over before any platform tried — fire the
            // scheduled_upload_failed alert. The per-platform path inside
            // upload_schedule_item handles partials; this branch only runs
            // when the bridge itself threw.
            const file_name = (item as any).title ?? "Your scheduled upload";
            const reason = ((err?.message as string | undefined) ?? "an unknown error").slice(0, 200);
            try {
                await sendPushToUser({
                    user_id: item.user_id!,
                    title: "Scheduled Upload Failed",
                    body: `${file_name} was not uploaded because ${reason}.`,
                    type: "error",
                    module: "schedule",
                    event_type: "scheduled_upload_failed",
                    related_id: item.id,
                    redirect_url: "/dashboard/schedules",
                });
            } catch (notify_err) { console.log("Error:- cron push scheduled_upload_failed", notify_err); }
        }
    }
    return { fired, skipped };
}

/**
 * Phase B — publish IG containers held for scheduled time.
 */
async function publish_due_ig_containers() {
    const due = await SocialUpload.findAll({
        where: {
            platform: "instagram",
            status: "scheduled",
            platform_media_id: { [Op.not]: null },
            scheduled_at: { [Op.lte]: new Date() } as any,
        } as any,
        order: [["scheduled_at", "ASC"]],
        limit: 50,
    });
    if (due.length === 0) return { published: 0, failed: 0 };

    let published = 0;
    let failed = 0;
    for (const u of due) {
        if (!u.social_account_id || !u.platform_media_id) continue;
        const account = await SocialAccount.findByPk(u.social_account_id);
        if (!account) {
            await u.update({
                status: "failed",
                error_message: "Linked Instagram account no longer exists.",
            } as any);
            failed += 1;
            continue;
        }
        try {
            clog("ig_publish_due", { upload_id: u.id, creation_id: u.platform_media_id });
            const { media_id, raw } = await publish_existing_instagram_container(account, u.platform_media_id);
            await u.update({
                status: "uploaded",
                platform_post_id: media_id ?? u.platform_media_id,
                media_url: media_id ? `https://www.instagram.com/p/${media_id}/` : u.media_url,
                published_at: new Date(),
                upload_result: { ...(u.upload_result ?? {}), instagram_publish: raw },
                error_message: null,
            } as any);
            published += 1;
        } catch (err: any) {
            clog("ig_publish_failed", { upload_id: u.id, error: err?.message ?? String(err) });
            await u.update({
                status: "failed",
                error_message: (err?.message ?? "Publish failed").slice(0, 500),
            } as any);
            failed += 1;
        }
    }
    return { published, failed };
}

let _interval: NodeJS.Timeout | null = null;

/**
 * Boot-time entry point. Schedules the cron to tick every TICK_INTERVAL_MS.
 * Returns immediately; ticks fire in the background.
 */
async function auto_publish_tick(): Promise<string> {
    const a = await fire_due_schedule_items();
    const b = await publish_due_ig_containers();
    if (a.fired || a.skipped || b.published || b.failed) {
        clog("tick_summary", {
            schedule_fired: a.fired,
            schedule_skipped: a.skipped,
            ig_published: b.published,
            ig_failed: b.failed,
        });
    }
    return `fired=${a.fired} skipped=${a.skipped} ig_published=${b.published} ig_failed=${b.failed}`;
}

export function start_auto_publish_cron(): void {
    if (_interval) return;   // already running
    clog("started", { tick_ms: TICK_INTERVAL_MS });

    register({
        id: CRON_ID,
        label: "Auto-Publish Scheduler",
        description: "Fires calendar schedule items whose time has passed (max 3 per tick) and publishes Instagram containers held for scheduled release.",
        interval_ms: TICK_INTERVAL_MS,
    }, auto_publish_tick);

    const tick = async () => {
        const r = await run(CRON_ID);
        if (!r.ok && !/connection manager was closed/i.test(r.summary)) {
            clog("tick_error", { error: r.summary });
        }
    };

    // Fire once shortly after boot so the user doesn't wait a full minute
    // for the first sweep, then on the regular interval.
    setTimeout(() => { void tick(); }, 5000);
    _interval = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
}

export function stop_auto_publish_cron(): void {
    if (_interval) { clearInterval(_interval); _interval = null; }
}

