/**
 * Calendar reminder cron.
 *
 * Ticks every minute. Each tick:
 *   1. Selects pending rows in calendar_event_reminders whose reminder_time
 *      has passed within the last 10 minutes.
 *   2. Skips reminders whose underlying event was cancelled/completed/uploaded.
 *   3. Pushes via sendPushToUser → all of the user's active sessions get it.
 *   4. Marks the row sent / failed / skipped so a subsequent tick doesn't
 *      double-fire.
 *
 * Rows older than 10 minutes are intentionally NOT picked up — a long outage
 * shouldn't cause "starts in 1 hour" pushes to fire after the event already
 * happened. They stay `pending` forever, but a separate cleanup job (or the
 * cancel/delete hooks) eventually flip them.
 */

import { tick_reminders } from "../services/notification/reminder.service";
import { register, run } from "./registry";

const CRON_ID = "calendar-reminders";
const TICK_INTERVAL_MS = 60 * 1000;
let _interval: NodeJS.Timeout | null = null;

function clog(step: string, data?: Record<string, any>) {
    console.log(`[reminder-worker] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

async function reminder_tick(): Promise<string> {
    const r = await tick_reminders();
    if (r.processed > 0) clog("tick_summary", r);
    return `processed=${r.processed} sent=${r.sent} skipped=${r.skipped} failed=${r.failed}`;
}

export function start_reminder_worker(): void {
    if (_interval) return;
    clog("started", { tick_ms: TICK_INTERVAL_MS });

    register({
        id: CRON_ID,
        label: "Calendar Reminders",
        description: "Fires push notifications for calendar event reminders (2d / 1d / 5h / 1h) whose scheduled time has arrived.",
        interval_ms: TICK_INTERVAL_MS,
    }, reminder_tick);

    const tick = async () => {
        const r = await run(CRON_ID);
        if (!r.ok && !/connection manager was closed/i.test(r.summary)) {
            // Shutdown race: a tick that started just before SIGINT can hit
            // a closed Sequelize pool. Suppress that specific message only.
            clog("tick_error", { error: r.summary });
        }
    };

    // First tick shortly after boot so reminders that came due while the
    // server was down get caught (within the 10-minute lookback).
    setTimeout(() => { void tick(); }, 10_000);
    _interval = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
}

export function stop_reminder_worker(): void {
    if (_interval) { clearInterval(_interval); _interval = null; }
}
