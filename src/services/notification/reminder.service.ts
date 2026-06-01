/**
 * Calendar reminder generation + cron worker.
 *
 * Reminders are pre-computed (not generated on the fly) so the cron's hot
 * path is a single indexed query against `calendar_event_reminders`. When
 * an event's start_at changes, the caller must call `regenerate_reminders`;
 * pending rows get rewritten and already-sent rows stay put.
 */

import { Op } from "sequelize";
import {
    CalendarEvent,
    CalendarEventReminder,
} from "../../db/models";
import { sendPushToUser } from "./firebase-notification.service";

export type ReminderType =
    | "before_2_days"
    | "before_1_day"
    | "before_5_hours"
    | "before_1_hour";

const OFFSETS_MS: Record<ReminderType, number> = {
    before_2_days: 2 * 24 * 60 * 60 * 1000,
    before_1_day: 1 * 24 * 60 * 60 * 1000,
    before_5_hours: 5 * 60 * 60 * 1000,
    before_1_hour: 1 * 60 * 60 * 1000,
};

const REMINDER_TYPES: ReminderType[] = [
    "before_2_days",
    "before_1_day",
    "before_5_hours",
    "before_1_hour",
];

const EVENT_TYPE_TO_NOTIFICATION: Record<ReminderType, string> = {
    before_2_days: "calendar_reminder_2_days",
    before_1_day: "calendar_reminder_1_day",
    before_5_hours: "calendar_reminder_5_hours",
    before_1_hour: "calendar_reminder_1_hour",
};

function fmtTitle(rt: ReminderType): string {
    switch (rt) {
        case "before_2_days": return "Upcoming Schedule Reminder";
        case "before_1_day": return "Schedule Reminder";
        case "before_5_hours": return "Schedule Starts Soon";
        case "before_1_hour": return "Schedule Starts in 1 Hour";
    }
}

function fmtBody(rt: ReminderType, title: string): string {
    switch (rt) {
        case "before_2_days": return `Your scheduled upload "${title}" is planned in 2 days.`;
        case "before_1_day": return `Your scheduled upload "${title}" is planned tomorrow.`;
        case "before_5_hours": return `Your scheduled upload "${title}" starts in 5 hours.`;
        case "before_1_hour": return `Your scheduled upload "${title}" starts in 1 hour.`;
    }
}

/**
 * Idempotent reminder generation. Called from create/update event flows.
 *
 * - For a future reminder_time → upsert as pending.
 * - For a reminder_time already in the past → upsert as skipped (or, if a
 *   pending row exists, leave it; otherwise insert skipped so we don't
 *   create one only to drop it).
 * - Already-sent rows are NEVER touched — moving an event forward shouldn't
 *   un-send a reminder the user already received.
 */
export async function regenerate_reminders(params: {
    user_id: string;
    calendar_event_id: string;
    start_at: Date;
    /**
     * If the event was cancelled / deleted, pass `cancelled: true` —
     * pending rows get marked skipped, no new ones are created.
     */
    cancelled?: boolean;
}): Promise<void> {
    const { user_id, calendar_event_id, start_at, cancelled } = params;

    if (cancelled) {
        await CalendarEventReminder.update(
            { status: "skipped", updated_at: new Date() } as any,
            { where: { calendar_event_id, status: "pending" } as any }
        );
        return;
    }

    const now = Date.now();
    const eventTime = start_at.getTime();

    for (const rt of REMINDER_TYPES) {
        const reminder_time = new Date(eventTime - OFFSETS_MS[rt]);
        const isPast = reminder_time.getTime() <= now;

        const existing = await CalendarEventReminder.findOne({
            where: { calendar_event_id, reminder_type: rt } as any,
        });

        if (!existing) {
            await CalendarEventReminder.create({
                user_id,
                calendar_event_id,
                reminder_type: rt,
                reminder_time,
                status: isPast ? "skipped" : "pending",
            } as any);
            continue;
        }

        // Already-sent rows are immutable history.
        if (existing.status === "sent") continue;

        // Re-arm pending/failed/skipped rows around the new time.
        (existing as any).reminder_time = reminder_time;
        (existing as any).status = isPast ? "skipped" : "pending";
        (existing as any).updated_at = new Date();
        await existing.save();
    }
}

/** Same as above but takes the event row — convenience for hooks. */
export async function regenerate_reminders_for_event(ev: CalendarEvent): Promise<void> {
    if (!ev.user_id || !ev.id || !ev.start_at) return;
    // Only generate reminders for events we actually care about reminding
    // about. Custom events the user typed by hand get reminders too;
    // skip statuses that imply the event is past or moot.
    const skipStatus = ev.status === "completed" || ev.status === "cancelled" || ev.status === "uploaded";
    await regenerate_reminders({
        user_id: ev.user_id,
        calendar_event_id: ev.id,
        start_at: new Date(ev.start_at as any),
        cancelled: skipStatus,
    });
}

/**
 * Cron tick — finds pending reminders whose time has passed and pushes them.
 *
 * Window: we only look at rows within the last 10 minutes of their
 * reminder_time, so a long backend outage doesn't make us deliver
 * "starts in 1 hour" pushes 6 hours after the event already happened.
 */
const LOOKBACK_MS = 10 * 60 * 1000;

export async function tick_reminders(): Promise<{ processed: number; sent: number; skipped: number; failed: number }> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - LOOKBACK_MS);

    const due = await CalendarEventReminder.findAll({
        where: {
            status: "pending",
            reminder_time: { [Op.lte]: now, [Op.gte]: cutoff },
        } as any,
        limit: 200,
        order: [["reminder_time", "ASC"]],
    });

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const reminder of due) {
        const ev = await CalendarEvent.findOne({ where: { id: reminder.calendar_event_id } as any });

        if (!ev) {
            (reminder as any).status = "skipped";
            (reminder as any).error_message = "calendar event missing";
            (reminder as any).updated_at = new Date();
            await reminder.save();
            skipped++;
            continue;
        }

        // Cancelled / completed / uploaded events don't need reminders. We
        // mark skipped instead of deleting so the dashboard can still show
        // the reminder history if asked.
        if (ev.status === "cancelled" || ev.status === "completed" || ev.status === "uploaded") {
            (reminder as any).status = "skipped";
            (reminder as any).error_message = `event status ${ev.status}`;
            (reminder as any).updated_at = new Date();
            await reminder.save();
            skipped++;
            continue;
        }

        const rt = reminder.reminder_type as ReminderType;
        const eventTitle = ev.title || "your upload";

        try {
            const result = await sendPushToUser({
                user_id: ev.user_id!,
                title: fmtTitle(rt),
                body: fmtBody(rt, eventTitle),
                type: "reminder",
                module: "calendar",
                event_type: EVENT_TYPE_TO_NOTIFICATION[rt],
                related_id: ev.id,
                redirect_url: `/dashboard/calendar?event_id=${ev.id}`,
                // The unique constraint on calendar_event_reminders already
                // guarantees one-per-(event, type); the dedup window would
                // double-count adjoining reminder types as "duplicates".
                skip_dedup: true,
            });

            (reminder as any).status = "sent";
            (reminder as any).sent_at = new Date();
            (reminder as any).error_message = result.sent_push
                ? null
                : "no active devices — recorded in history only";
            (reminder as any).updated_at = new Date();
            await reminder.save();
            sent++;
        } catch (err: any) {
            (reminder as any).status = "failed";
            (reminder as any).error_message = err?.message?.slice(0, 500) ?? "unknown error";
            (reminder as any).updated_at = new Date();
            await reminder.save();
            failed++;
        }
    }

    return { processed: due.length, sent, skipped, failed };
}
