/**
 * Auto Post cron — every minute, for each enabled AutoPostConfig, find
 * slots (date × post_time in the user's timezone) that are due and fire
 * them: generate an AI thought → post text to the Facebook Page.
 *
 * A slot is due when:
 *   - its date matches the frequency (every day / chosen weekdays /
 *     chosen days of month — day 31 on a 30-day month fires on the 30th),
 *   - slot_time <= now and now - slot_time <= GRACE_MS (a server restart
 *     within the grace window still catches up; older slots are skipped),
 *   - slot_time >= enabled_at (turning on at 14:00 won't back-fill 10:00).
 *
 * Idempotency: `run_auto_post` claims the slot via a unique
 * (user_id, slot_key) row before doing any work.
 */

import moment from "moment-timezone";
import { AutoPostConfig } from "../../db/models";
import { run_auto_post } from "../../modules/auto_post/auto_post.service";
import { sendPushToUser } from "../notification/firebase-notification.service";
import { register, run } from "../../cron/registry";

const CRON_ID = "auto-post-facebook";
const TICK_INTERVAL_MS = 60 * 1000;
const GRACE_MS = 15 * 60 * 1000;

function clog(step: string, data?: Record<string, any>) {
    console.log(`[auto-post-cron] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

function date_matches(cfg: AutoPostConfig, day: moment.Moment): boolean {
    switch (cfg.frequency) {
        case "every_week":
            return (cfg.weekdays ?? []).includes(day.day());
        case "every_month": {
            const dim = day.daysInMonth();
            return (cfg.month_days ?? []).some(d => Math.min(d, dim) === day.date());
        }
        default:
            return true;
    }
}

/** Slot keys ("YYYY-MM-DD HH:mm" in cfg.timezone) that are due right now. */
export function due_slots(cfg: AutoPostConfig, now_ms: number = Date.now()): string[] {
    const tz = cfg.timezone && moment.tz.zone(cfg.timezone) ? cfg.timezone : "UTC";
    const now = moment.tz(now_ms, tz);
    const enabled_ms = cfg.enabled_at ? new Date(cfg.enabled_at).getTime() : 0;
    const out: string[] = [];
    // Yesterday too, so a 23:55 slot still fires at 00:05.
    for (const day of [now.clone().subtract(1, "day"), now.clone()]) {
        if (!date_matches(cfg, day)) continue;
        const date = day.format("YYYY-MM-DD");
        for (const t of cfg.post_times ?? []) {
            const slot = moment.tz(`${date} ${t}`, "YYYY-MM-DD HH:mm", tz);
            const slot_ms = slot.valueOf();
            if (!slot.isValid() || slot_ms > now_ms) continue;
            if (now_ms - slot_ms > GRACE_MS) continue;
            // Allow slots in the same minute the switch was turned on.
            if (slot_ms < enabled_ms - 60_000) continue;
            out.push(`${date} ${t}`);
        }
    }
    return out;
}

async function auto_post_tick(): Promise<string> {
    const configs = await AutoPostConfig.findAll({ where: { enabled: true } as any });
    let posted = 0, failed = 0, skipped = 0;

    for (const cfg of configs) {
        for (const slot_key of due_slots(cfg)) {
            const log = await run_auto_post(cfg.user_id!, slot_key, cfg.social_account_id);
            if (!log) { skipped += 1; continue; }
            if (log.status === "posted") {
                posted += 1;
                clog("posted", { user_id: cfg.user_id, slot_key, post_id: log.platform_post_id });
            } else {
                failed += 1;
                clog("failed", { user_id: cfg.user_id, slot_key, error: log.error_message });
                try {
                    await sendPushToUser({
                        user_id: cfg.user_id!,
                        title: "Auto Post Failed",
                        body: `Facebook auto post (${slot_key}) failed: ${(log.error_message ?? "unknown error").slice(0, 160)}`,
                        type: "error",
                        module: "auto_post",
                        event_type: "auto_post_failed",
                        related_id: log.id,
                        redirect_url: "/dashboard/auto-post",
                    });
                } catch (e) { console.log("Error:- auto post push", e); }
            }
        }
    }
    return `configs=${configs.length} posted=${posted} failed=${failed} skipped=${skipped}`;
}

let _interval: NodeJS.Timeout | null = null;

export function start_auto_post_cron(): void {
    if (_interval) return;
    register({
        id: CRON_ID,
        label: "Facebook Auto Post",
        description: "Generates an AI thought (text + emoji + hashtags) and posts it to the linked Facebook Page at each user's configured Auto Post times.",
        interval_ms: TICK_INTERVAL_MS,
    }, auto_post_tick);

    const tick = async () => {
        const r = await run(CRON_ID);
        if (!r.ok && !/connection manager was closed|Already running/i.test(r.summary)) {
            clog("tick_error", { error: r.summary });
        }
    };
    setTimeout(() => { void tick(); }, 8000);
    _interval = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
    clog("started", { tick_ms: TICK_INTERVAL_MS });
}

export function stop_auto_post_cron(): void {
    if (_interval) { clearInterval(_interval); _interval = null; }
}
