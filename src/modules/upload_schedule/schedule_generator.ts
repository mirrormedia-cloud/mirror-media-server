import type { Frequency } from "./upload_schedule.dto";

export interface SlotInput {
    library_item_id: string;
    title: string | null;
}

export interface GeneratedSlot {
    library_item_id: string;
    title: string | null;
    /** ISO datetime in UTC. Built from local Y/M/D + HH:MM in the server's
     *  timezone (Date constructor with separate args). For now we treat that
     *  as "user wall-clock"; per-user timezones would slot in here later. */
    scheduledAt: string;
}

export interface GenerateScheduleArgs {
    library_items: SlotInput[];
    frequency: Frequency;
    /** How many uploads to fit per scheduled day. Slot count per day is min(release_count, upload_times.length). */
    release_count: number;
    /** ["10:00", "18:00"] — HH:MM */
    upload_times: string[];
    /** YYYY-MM-DD */
    start_date: string;
    /** YYYY-MM-DD — required for custom_range, optional cap for the others. */
    end_date?: string | null;
    /** [0..6] — Sunday=0. Required for every_week. */
    weekdays?: number[];
    /** [1..31]. Required for every_month. */
    month_days?: number[];
}

export interface GenerateScheduleResult {
    items: GeneratedSlot[];
    /** Items that didn't fit because the date range / rules ran out. */
    unscheduled_library_item_ids: string[];
    total_files: number;
    total_slots: number;
    scheduled_count: number;
    unscheduled_count: number;
    warnings: string[];
}

/** Hard cap so a misconfigured every_day with no end_date can't iterate forever. */
const MAX_DAYS = 365 * 3;

function parse_date_only(d: string): Date {
    const parts = d.split("-").map(Number);
    const y = parts[0] ?? 1970;
    const m = parts[1] ?? 1;
    const day = parts[2] ?? 1;
    return new Date(y, m - 1, day, 0, 0, 0, 0);
}

function add_days(d: Date, days: number): Date {
    const next = new Date(d.getTime());
    next.setDate(next.getDate() + days);
    return next;
}

function combine(date: Date, time_hhmm: string): string {
    const parts = time_hhmm.split(":").map(Number);
    const hh = parts[0] ?? 0;
    const mm = parts[1] ?? 0;
    const dt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm, 0, 0);
    return dt.toISOString();
}

/**
 * Yields the dates eligible for upload under the given frequency, in
 * chronological order. Stops when the date range is exhausted OR when we've
 * yielded enough dates to consume every library item (signaled via `cap`).
 */
function* iterate_dates(args: GenerateScheduleArgs, cap: number): Generator<Date> {
    const start = parse_date_only(args.start_date);
    const end = args.end_date ? parse_date_only(args.end_date) : null;
    let cursor = start;
    let yielded = 0;

    for (let i = 0; i < MAX_DAYS && yielded < cap; i += 1) {
        if (end && cursor.getTime() > end.getTime()) return;

        let include = false;
        if (args.frequency === "every_day" || args.frequency === "custom_range") {
            include = true;
        } else if (args.frequency === "every_week") {
            const wd = cursor.getDay();
            include = (args.weekdays ?? []).includes(wd);
        } else if (args.frequency === "every_month") {
            const dom = cursor.getDate();
            include = (args.month_days ?? []).includes(dom);
        }

        if (include) {
            yield cursor;
            yielded += 1;
        }
        cursor = add_days(cursor, 1);
    }
}

export function generate_upload_schedule(args: GenerateScheduleArgs): GenerateScheduleResult {
    const warnings: string[] = [];
    const slots_per_day = Math.max(1, Math.min(args.release_count, args.upload_times.length));
    if (slots_per_day !== args.release_count) {
        warnings.push(
            `release_count (${args.release_count}) trimmed to upload_times length (${args.upload_times.length}) — only ${slots_per_day} slot(s)/day will be used`,
        );
    }

    const total_files = args.library_items.length;
    const days_needed = Math.ceil(total_files / slots_per_day);

    const items: GeneratedSlot[] = [];
    let item_idx = 0;

    for (const date of iterate_dates(args, days_needed)) {
        for (let s = 0; s < slots_per_day && item_idx < total_files; s += 1) {
            const lib = args.library_items[item_idx];
            const time = args.upload_times[s];
            if (!lib || !time) break;
            items.push({
                library_item_id: lib.library_item_id,
                title: lib.title,
                scheduledAt: combine(date, time),
            });
            item_idx += 1;
        }
        if (item_idx >= total_files) break;
    }

    const unscheduled = args.library_items.slice(item_idx);
    if (unscheduled.length > 0) {
        warnings.push(
            `Date range too short — ${unscheduled.length} item(s) could not be scheduled`,
        );
    }

    return {
        items,
        unscheduled_library_item_ids: unscheduled.map(u => u.library_item_id),
        total_files,
        total_slots: items.length,
        scheduled_count: items.length,
        unscheduled_count: unscheduled.length,
        warnings,
    };
}
