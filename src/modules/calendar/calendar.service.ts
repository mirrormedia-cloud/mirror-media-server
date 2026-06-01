import type { FastifyRequest } from "fastify";
import { Op } from "sequelize";
import { CalendarEvent, UploadScheduleBatch, UploadScheduleItem } from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import { regenerate_reminders_for_event, regenerate_reminders } from "../../services/notification/reminder.service";
import type {
    CreateCalendarEventInput,
    UpdateCalendarEventInput,
    ListCalendarEventsInput,
} from "./calendar.dto";

function ts(value: any): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function calendar_event_dto(e: CalendarEvent) {
    return {
        id: e.id,
        title: e.title,
        description: e.description ?? null,
        startAt: ts((e as any).start_at),
        endAt: ts((e as any).end_at),
        all_day: !!(e as any).all_day,
        event_type: e.event_type ?? "custom",
        color: e.color ?? null,
        status: e.status ?? "scheduled",
        upload_schedule_item_id: e.upload_schedule_item_id ?? null,
        library_item_id: e.library_item_id ?? null,
        ott_id: e.ott_id ?? null,
        metadata: e.metadata ?? {},
        createdAt: ts((e as any).createdAt),
        updatedAt: ts((e as any).updatedAt),
        deletedAt: ts((e as any).deletedAt),
    };
}

export async function list_events(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");

    const q = (req.query ?? {}) as ListCalendarEventsInput;
    const where: any = { user_id };

    // start/end window — inclusive on both sides. Filter on start_at since it's
    // the indexed column. End-overlap precision isn't important for a calendar
    // grid (we re-fetch per visible range anyway).
    if (q.start || q.end) {
        where.start_at = {};
        if (q.start) where.start_at[Op.gte] = new Date(q.start);
        if (q.end) where.start_at[Op.lte] = new Date(q.end);
    }

    const types = q.event_types
        ? q.event_types.split(",").map(s => s.trim()).filter(Boolean)
        : q.event_type
            ? [q.event_type]
            : [];
    if (types.length > 0) where.event_type = types;

    const rows = await CalendarEvent.findAll({
        where,
        order: [["start_at", "ASC"]],
    });
    return success("Events fetched", rows.map(calendar_event_dto));
}

export async function get_event(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { event_id } = req.params as { event_id: string };
    const row = await CalendarEvent.findOne({ where: { id: event_id, user_id } as any });
    if (!row) return error(HttpStatus.NOT_FOUND, "Event not found");
    return success("Event fetched", calendar_event_dto(row));
}

export async function create_event(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const body = req.body as CreateCalendarEventInput;

    const row = await CalendarEvent.create({
        user_id,
        title: body.title,
        description: body.description ?? null,
        start_at: new Date(body.startAt),
        end_at: body.endAt ? new Date(body.endAt) : null,
        all_day: !!body.all_day,
        event_type: body.event_type ?? "custom",
        color: body.color ?? null,
        status: body.status ?? "scheduled",
        metadata: body.metadata ?? {},
    } as any);

    // Pre-compute the 2-day / 1-day / 5-hour / 1-hour reminders. Failures
    // here shouldn't block event creation — the cron will simply have no
    // rows for this event, which is recoverable later.
    try {
        await regenerate_reminders_for_event(row);
    } catch (err) {
        console.log("Error:- create_event regenerate_reminders", err);
    }

    return success("Event created", calendar_event_dto(row), HttpStatus.CREATED);
}

export async function update_event(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { event_id } = req.params as { event_id: string };
    const body = req.body as UpdateCalendarEventInput;

    const row = await CalendarEvent.findOne({ where: { id: event_id, user_id } as any });
    if (!row) return error(HttpStatus.NOT_FOUND, "Event not found");

    // Cross-field guard: if either side of the window is being touched, make
    // sure the resulting endAt is still > startAt. We re-derive both from the
    // would-be next state instead of just from the patch.
    const next_start_iso = body.startAt ?? ts((row as any).start_at);
    const next_end_iso = body.endAt === undefined ? ts((row as any).end_at) : body.endAt;
    if (next_start_iso && next_end_iso) {
        const s = new Date(next_start_iso).getTime();
        const e = new Date(next_end_iso).getTime();
        if (Number.isFinite(s) && Number.isFinite(e) && e <= s) {
            return error(HttpStatus.BAD_REQUEST, "endAt must be after startAt");
        }
    }

    if (body.title !== undefined) (row as any).title = body.title;
    if (body.description !== undefined) (row as any).description = body.description;
    if (body.startAt !== undefined) (row as any).start_at = new Date(body.startAt);
    if (body.endAt !== undefined) (row as any).end_at = body.endAt ? new Date(body.endAt) : null;
    if (body.all_day !== undefined) (row as any).all_day = !!body.all_day;
    if (body.event_type !== undefined) (row as any).event_type = body.event_type;
    if (body.color !== undefined) (row as any).color = body.color;
    if (body.status !== undefined) (row as any).status = body.status;
    if (body.metadata !== undefined) (row as any).metadata = body.metadata;
    await row.save();

    // Re-arm pending reminders around the new start_at. Sent ones stay
    // immutable inside the helper. We don't filter on "did start_at
    // actually change?" — the helper is cheap and idempotent.
    try {
        await regenerate_reminders_for_event(row);
    } catch (err) {
        console.log("Error:- update_event regenerate_reminders", err);
    }

    return success("Event updated", calendar_event_dto(row));
}

export async function delete_event(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { event_id } = req.params as { event_id: string };
    const row = await CalendarEvent.findOne({ where: { id: event_id, user_id } as any });
    if (!row) return error(HttpStatus.NOT_FOUND, "Event not found");

    // Mark pending reminders skipped BEFORE the soft-delete so the cron
    // can't grab one during the gap.
    try {
        await regenerate_reminders({
            user_id: row.user_id!,
            calendar_event_id: row.id,
            start_at: new Date(row.start_at as any),
            cancelled: true,
        });
    } catch (err) {
        console.log("Error:- delete_event regenerate_reminders", err);
    }

    await row.destroy();
    return success("Event deleted", { id: event_id });
}

/**
 * Hard delete calendar content owned by the calling user.
 *
 * `scope` (body, default `'all'`):
 *   - `'all'`   — every calendar event + every upload schedule
 *                 (batches + items). Original behaviour.
 *   - `'media'` — ONLY the media side: upload schedules (batches +
 *                 items) AND the calendar events they spawned
 *                 (event_type='upload_schedule'). Manually-created
 *                 events (custom / release / reminder) stay put.
 *
 * The frontend confirms before calling this so we don't need a
 * server-side guard beyond the auth check.
 */
export async function clear_all(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");

    const body = (req.body ?? {}) as { scope?: unknown };
    const scope: "all" | "media" = body.scope === "media" ? "media" : "all";

    // Schedule items reference batches via batch_id and have no
    // CASCADE in the model definition — delete items first, then
    // their parent batches.
    const batch_rows = await UploadScheduleBatch.findAll({
        where: { user_id } as any,
        attributes: ["id"],
        raw: true,
    }) as unknown as Array<{ id: string }>;
    const batch_ids = batch_rows.map(b => b.id);

    let items_deleted = 0;
    if (batch_ids.length > 0) {
        items_deleted = await UploadScheduleItem.destroy({
            where: { batch_id: { [Op.in]: batch_ids } } as any,
            force: true,
        });
    }
    const batches_deleted = await UploadScheduleBatch.destroy({
        where: { user_id } as any,
        force: true,
    });

    // For `media` scope only the upload-schedule events go; everything
    // else the user typed by hand survives.
    const event_where: any = { user_id };
    if (scope === "media") event_where.event_type = "upload_schedule";
    const events_deleted = await CalendarEvent.destroy({
        where: event_where,
        force: true,
    });

    return success("Calendar cleared", {
        scope,
        events_deleted,
        batches_deleted,
        items_deleted,
    });
}
