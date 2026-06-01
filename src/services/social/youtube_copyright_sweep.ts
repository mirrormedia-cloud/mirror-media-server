/**
 * YouTube copyright sweep.
 *
 * Every CHECK_INTERVAL_MS we walk recently-uploaded YouTube rows and ask
 * the API whether they were rejected for copyright / Content-ID reasons.
 * If yes, we permanently delete the video on YouTube and mark the row
 * as 'failed' with a clear error_message, so the user sees what happened
 * on the Social Uploads page.
 *
 * Why a sweep and not a webhook: YouTube has no push notification for
 * Content-ID matches in the regular Data API — the only way to know is
 * to poll videos.list. Cost is 1 quota unit per call; cheap.
 *
 * Polling window: only check rows whose `published_at` is within the
 * last 30 days. Copyright claims on older content are rare and we don't
 * want to keep hammering the API forever. We also stamp
 * `upload_result.copyright_check_at` so we re-check at most once per
 * COOLDOWN_MS for any given row.
 */

import { Op } from "sequelize";
import { SocialAccount, SocialUpload } from "../../db/models";
import {
    check_youtube_video_copyright,
    delete_youtube_video,
} from "./youtube_upload.service";

import { register, run } from "../../cron/registry";

const CRON_ID = "youtube-copyright-sweep";
const CHECK_INTERVAL_MS = 5 * 60 * 1000;       // run every 5 min
const COOLDOWN_MS = 15 * 60 * 1000;            // don't recheck same row more often than this
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;    // ignore rows older than 30 days
let _interval: NodeJS.Timeout | null = null;

function clog(step: string, data?: Record<string, any>) {
    console.log(`[yt-copyright] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

export interface CopyrightCheckOutcome {
    upload_id: string;
    video_id: string | null;
    skipped: "cooldown" | "no_account" | "no_video_id" | null;
    has_issue: boolean;
    reason: string | null;
    summary: string | null;
    deleted: boolean;
    error: string | null;
}

/**
 * Run the copyright check + auto-delete logic for a single SocialUpload
 * row. Exported so the manual API endpoints can reuse it.
 *
 * `force=true` bypasses the 15-min per-row cooldown — use it for the
 * "Check now" button so the user gets an answer immediately.
 */
export async function check_and_handle_one(
    row: SocialUpload,
    opts: { force?: boolean } = {},
): Promise<CopyrightCheckOutcome> {
    const out: CopyrightCheckOutcome = {
        upload_id: row.id,
        video_id: row.platform_media_id ?? null,
        skipped: null,
        has_issue: false,
        reason: null,
        summary: null,
        deleted: false,
        error: null,
    };

    if (!opts.force) {
        const last_check_iso = (row.upload_result as any)?.copyright_check_at as string | undefined;
        if (last_check_iso) {
            const last = new Date(last_check_iso).getTime();
            if (Number.isFinite(last) && Date.now() - last < COOLDOWN_MS) {
                out.skipped = "cooldown";
                return out;
            }
        }
    }
    if (!row.social_account_id) { out.skipped = "no_account"; return out; }
    if (!row.platform_media_id)  { out.skipped = "no_video_id"; return out; }
    const account = await SocialAccount.findByPk(row.social_account_id);
    if (!account) { out.skipped = "no_account"; return out; }

    try {
        const verdict = await check_youtube_video_copyright(account, row.platform_media_id);
        out.has_issue = verdict.has_issue;
        out.reason = verdict.reason;
        out.summary = verdict.summary;

        if (verdict.has_issue) {
            clog("issue_detected", {
                upload_id: row.id,
                video_id: row.platform_media_id,
                reason: verdict.reason,
            });
            if (verdict.reason !== "not_found") {
                try {
                    await delete_youtube_video(account, row.platform_media_id);
                } catch (del_err: any) {
                    clog("delete_failed", {
                        upload_id: row.id,
                        video_id: row.platform_media_id,
                        error: del_err?.message,
                    });
                    await row.update({
                        error_message: `Copyright detected (${verdict.reason}); auto-delete failed: ${(del_err?.message ?? "unknown").slice(0, 200)}`,
                        upload_result: {
                            ...(row.upload_result ?? {}),
                            copyright_check_at: new Date().toISOString(),
                            copyright_verdict: verdict,
                            copyright_delete_error: del_err?.response?.data ?? del_err?.message ?? null,
                        },
                    } as any);
                    out.error = del_err?.message ?? String(del_err);
                    return out;
                }
            }
            await row.update({
                status: "failed",
                error_message: `Auto-deleted: ${verdict.summary ?? verdict.reason ?? "copyright issue"}`,
                media_url: null,
                upload_result: {
                    ...(row.upload_result ?? {}),
                    copyright_check_at: new Date().toISOString(),
                    copyright_verdict: verdict,
                    auto_deleted_at: new Date().toISOString(),
                },
            } as any);
            out.deleted = true;
        } else {
            await row.update({
                upload_result: {
                    ...(row.upload_result ?? {}),
                    copyright_check_at: new Date().toISOString(),
                },
            } as any);
        }
    } catch (err: any) {
        clog("check_failed", {
            upload_id: row.id,
            video_id: row.platform_media_id,
            error: err?.message,
        });
        await row.update({
            upload_result: {
                ...(row.upload_result ?? {}),
                copyright_check_at: new Date().toISOString(),
                copyright_check_error: err?.message ?? String(err),
            },
        } as any);
        out.error = err?.message ?? String(err);
    }
    return out;
}

/**
 * Find every YouTube row that's a candidate for a copyright check.
 * Used by both the cron sweep and the manual "Check now" endpoint —
 * `force` makes the manual call ignore the per-row cooldown.
 */
export async function sweep_youtube_copyright(opts: { force?: boolean; user_id?: string } = {}): Promise<{
    checked: number; deleted: number; clean: number; errors: number; skipped: number;
    outcomes: CopyrightCheckOutcome[];
}> {
    const window_start = new Date(Date.now() - WINDOW_MS);
    const where: any = {
        platform: "youtube",
        status: "uploaded",
        platform_media_id: { [Op.not]: null },
        published_at: { [Op.gte]: window_start },
    };
    if (opts.user_id) where.user_id = opts.user_id;

    const rows = await SocialUpload.findAll({
        where,
        order: [["published_at", "DESC"]],
        limit: 100,
    });

    let checked = 0, deleted = 0, clean = 0, errors = 0, skipped = 0;
    const outcomes: CopyrightCheckOutcome[] = [];
    for (const row of rows) {
        const out = await check_and_handle_one(row, opts.force ? { force: true } : {});
        outcomes.push(out);
        if (out.skipped) { skipped += 1; continue; }
        checked += 1;
        if (out.deleted) deleted += 1;
        else if (out.has_issue) errors += 1;
        else if (out.error) errors += 1;
        else clean += 1;
    }
    return { checked, deleted, clean, errors, skipped, outcomes };
}

async function sweep_once() {
    return sweep_youtube_copyright({ force: false });
}

async function sweep_tick(): Promise<string> {
    const r = await sweep_once();
    if (r.checked > 0 || r.deleted > 0 || r.errors > 0) {
        clog("tick_summary", r);
    }
    return `checked=${r.checked} clean=${r.clean} deleted=${r.deleted} errors=${r.errors} skipped=${r.skipped}`;
}

export function start_youtube_copyright_sweep(): void {
    if (_interval) return;
    clog("started", { interval_ms: CHECK_INTERVAL_MS, window_days: WINDOW_MS / (24 * 60 * 60 * 1000) });

    register({
        id: CRON_ID,
        label: "YouTube Copyright Sweep",
        description: "Polls YouTube for recently-uploaded videos (last 30 days) to detect Content-ID / copyright issues. Auto-deletes flagged videos and marks the upload row as failed.",
        interval_ms: CHECK_INTERVAL_MS,
    }, sweep_tick);

    const tick = async () => {
        const r = await run(CRON_ID);
        if (!r.ok && !/connection manager was closed/i.test(r.summary)) {
            clog("tick_error", { error: r.summary });
        }
    };

    // First sweep ~30s after boot, then on the regular cadence.
    setTimeout(() => { void tick(); }, 30_000);
    _interval = setInterval(() => { void tick(); }, CHECK_INTERVAL_MS);
}

export function stop_youtube_copyright_sweep(): void {
    if (_interval) { clearInterval(_interval); _interval = null; }
}
