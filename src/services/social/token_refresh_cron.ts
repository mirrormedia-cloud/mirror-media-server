/**
 * Proactive social token refresh.
 *
 * Every 5 minutes, find any SocialAccount whose access token expires
 * within the next 5–10 minutes (i.e. expires_at <= now + 10 min) and
 * refresh it using the stored refresh_token. The 10-minute lead is
 * chosen so the cron always catches a token before it actually expires:
 * with a 5-minute cadence, anything ≤ 10 min away will be refreshed on
 * either this tick or the next one, never after.
 *
 * Already-expired rows are also picked up so a token that expired while
 * the server was down (or while the cron was paused) gets healed on the
 * next tick instead of waiting for a manual click.
 *
 * If refresh fails (e.g. user revoked access on Google/Meta), the
 * existing helper marks the row status='expired' so the UI surfaces a
 * "Reconnect required" CTA rather than silently looping.
 */

import { Op } from "sequelize";
import { SocialAccount } from "../../db/models";
import { refresh_account_token } from "../../modules/social_media/social_media.service";
import { sendPushToUser } from "../notification/firebase-notification.service";
import { register, run } from "../../cron/registry";

const CRON_ID = "social-token-refresh";
const TICK_INTERVAL_MS = 5 * 60 * 1000;     // run every 5 minutes
const REFRESH_LEAD_MS = 10 * 60 * 1000;     // refresh tokens expiring within next 10 min
let _interval: NodeJS.Timeout | null = null;

function clog(step: string, data?: Record<string, any>) {
    console.log(`[token-refresh] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

/**
 * Fire the "reconnect your YouTube account soon" reminder for any
 * `social_accounts` row whose `reconnect_reminder_at` has passed. The
 * column is set to `connected_at + 6 days` on every successful
 * connect/refresh — so this fires only when the refresh chain has been
 * silent for ~6 days (~1 day before Google's 7-day refresh-token expiry).
 *
 * Cleared after firing so the user doesn't get the same reminder twice
 * for the same connection window.
 */
async function fire_reconnect_reminders(): Promise<{ sent: number }> {
    const now = new Date();
    const due = await SocialAccount.findAll({
        where: {
            platform: "youtube",
            status: "connected",
            reconnect_reminder_at: { [Op.lte]: now, [Op.ne]: null },
        } as any,
        limit: 100,
    });
    if (due.length === 0) return { sent: 0 };

    let sent = 0;
    for (const account of due) {
        try {
            const channel = (account as any).channel_name || (account as any).account_name || "your channel";
            await sendPushToUser({
                user_id: account.user_id!,
                title: "Reconnect YouTube Soon",
                body: `Your YouTube connection for ${channel} expires within a day. Reconnect to keep uploads working.`,
                type: "warning",
                module: "youtube",
                event_type: "youtube_reconnect_warning",
                related_id: account.id,
                redirect_url: "/dashboard/social-accounts",
                // Skip the 30-min dedup window — this fires at most once
                // per 6-day cycle anyway because we null the column below.
                skip_dedup: true,
            });
            // Clear the column so it doesn't re-fire on the next tick.
            // If the user successfully refreshes later, the refresh path
            // resets `reconnect_reminder_at` to a fresh +6 days.
            await account.update({ reconnect_reminder_at: null } as any);
            sent += 1;
            clog("reconnect_reminder_sent", { account_id: account.id, user_id: account.user_id });
        } catch (err: any) {
            clog("reconnect_reminder_failed", {
                account_id: account.id,
                error: err?.message ?? String(err),
            });
        }
    }
    return { sent };
}

async function refresh_due_tokens(): Promise<{ refreshed: number; failed: number }> {
    const cutoff = new Date(Date.now() + REFRESH_LEAD_MS);
    const due = await SocialAccount.findAll({
        where: {
            refresh_token: { [Op.not]: null },
            expires_at: { [Op.lte]: cutoff, [Op.not]: null },
            // Skip rows we've already given up on. The user must reconnect
            // to clear status='disconnected'; we still retry status='expired'
            // because some refresh failures are transient (network blips).
            status: { [Op.in]: ["connected", "expired"] },
        } as any,
        limit: 50,
    });
    if (due.length === 0) return { refreshed: 0, failed: 0 };

    let refreshed = 0;
    let failed = 0;
    for (const account of due) {
        try {
            clog("refreshing", {
                account_id: account.id,
                platform: account.platform,
                expires_at: (account as any).expires_at,
            });
            await refresh_account_token(account);
            refreshed += 1;
        } catch (err: any) {
            failed += 1;
            clog("refresh_failed", {
                account_id: account.id,
                platform: account.platform,
                error: err?.message ?? String(err),
            });
            try {
                await account.update({ status: "expired" } as any);
            } catch { /* ignore secondary failure */ }
        }
    }
    return { refreshed, failed };
}

async function token_refresh_tick(): Promise<string> {
    const r = await refresh_due_tokens();
    if (r.refreshed || r.failed) clog("tick_summary", r);
    // Separate sweep — runs every tick regardless of whether any tokens
    // needed refreshing. Failure isolated so a reminder hiccup doesn't
    // break the refresh path.
    let reminder_sent = 0;
    try {
        const rem = await fire_reconnect_reminders();
        reminder_sent = rem.sent;
        if (rem.sent) clog("reminder_summary", rem);
    } catch (err: any) {
        clog("reminder_error", { error: err?.message ?? String(err) });
    }
    return `refreshed=${r.refreshed} failed=${r.failed} reminders=${reminder_sent}`;
}

export function start_token_refresh_cron(): void {
    if (_interval) return;
    clog("started", { tick_ms: TICK_INTERVAL_MS, lead_ms: REFRESH_LEAD_MS });

    register({
        id: CRON_ID,
        label: "Social Token Refresh",
        description: "Proactively refreshes YouTube / Meta access tokens before they expire (within next 10 min) and fires reconnect reminders for stale connections.",
        interval_ms: TICK_INTERVAL_MS,
    }, token_refresh_tick);

    const tick = async () => {
        const r = await run(CRON_ID);
        if (!r.ok && !/connection manager was closed/i.test(r.summary)) {
            clog("tick_error", { error: r.summary });
        }
    };

    // Run once shortly after boot so any tokens that expired while the
    // server was down get refreshed without waiting a full minute.
    setTimeout(() => { void tick(); }, 5000);
    _interval = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
}

/**
 * Stop the cron — called from the process shutdown hook so leftover
 * timers from a hot-reload don't query a closed Sequelize pool.
 */
export function stop_token_refresh_cron(): void {
    if (_interval) { clearInterval(_interval); _interval = null; }
}
