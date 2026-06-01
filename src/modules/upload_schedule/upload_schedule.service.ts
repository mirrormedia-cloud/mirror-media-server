import type { FastifyRequest } from "fastify";
import { Op } from "sequelize";
import {
    OttPlatform,
    OttLibraryItem,
    UploadScheduleBatch,
    UploadScheduleItem,
    CalendarEvent,
} from "../../db/models";
import { sequelize } from "../../db";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import {
    generate_upload_schedule,
    GeneratedSlot,
    SlotInput,
} from "./schedule_generator";
import { regenerate_reminders, regenerate_reminders_for_event } from "../../services/notification/reminder.service";
import type {
    PreviewScheduleInput,
    CreateScheduleInput,
    ListSchedulesQueryInput,
    SupportedPlatform,
} from "./upload_schedule.dto";

function ts(value: any): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function date_only(value: any): string | null {
    if (!value) return null;
    if (typeof value === "string") return value.slice(0, 10);
    if (value instanceof Date) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, "0");
        const d = String(value.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }
    return null;
}

export function batch_dto(b: UploadScheduleBatch, extras: { items_count?: number; scheduled_count?: number } = {}) {
    return {
        id: b.id,
        ott_id: b.ott_id ?? null,
        name: b.name ?? null,
        scheduled: !!b.scheduled,
        platforms: b.platforms ?? [],
        frequency: b.frequency ?? null,
        release_count: b.release_count ?? 1,
        upload_times: b.upload_times ?? [],
        start_date: date_only((b as any).start_date),
        end_date: date_only((b as any).end_date),
        weekdays: b.weekdays ?? [],
        month_days: b.month_days ?? [],
        color: b.color ?? null,
        title_prefix: b.title_prefix ?? null,
        description: b.description ?? null,
        tags: b.tags ?? [],
        status: b.status ?? "draft",
        items_count: extras.items_count ?? null,
        scheduled_count: extras.scheduled_count ?? null,
        metadata: b.metadata ?? {},
        createdAt: ts((b as any).createdAt),
        updatedAt: ts((b as any).updatedAt),
        deletedAt: ts((b as any).deletedAt),
    };
}

export function item_dto(i: UploadScheduleItem, lib?: OttLibraryItem | null) {
    return {
        id: i.id,
        batch_id: i.batch_id ?? null,
        ott_id: i.ott_id ?? null,
        library_item_id: i.library_item_id ?? null,
        calendar_event_id: i.calendar_event_id ?? null,
        title: i.title ?? null,
        description: i.description ?? null,
        platforms: i.platforms ?? [],
        scheduledAt: ts((i as any).scheduled_at),
        color: i.color ?? null,
        status: i.status ?? "scheduled",
        upload_result: i.upload_result ?? {},
        error_message: i.error_message ?? null,
        metadata: i.metadata ?? {},
        library_item: lib ? {
            id: lib.id,
            title: lib.title ?? null,
            thumbnail_url: lib.thumbnail_url ?? null,
            file_name: lib.file_name ?? null,
            duration: lib.duration ?? null,
            save_type: lib.save_type ?? null,
            // R2 migration: status column is gone — row presence IS
            // the success signal.
            status: "completed" as const,
        } : null,
        createdAt: ts((i as any).createdAt),
        updatedAt: ts((i as any).updatedAt),
        deletedAt: ts((i as any).deletedAt),
    };
}

/**
 * Loads the user's library items in the order specified by `library_item_ids`
 * (Sequelize won't preserve IN-list order). Also runs the ownership +
 * status="completed" gate. Returns either an error envelope or a SlotInput[]
 * array ready for the generator.
 */
async function load_and_validate_items(
    user_id: string,
    ott_id: string,
    library_item_ids: string[],
): Promise<{ ok: true; slots: SlotInput[]; library_items: OttLibraryItem[] } | { ok: false; envelope: ReturnType<typeof error> }> {
    const rows = await OttLibraryItem.findAll({
        where: { id: library_item_ids, user_id, ott_id } as any,
    });
    if (rows.length !== library_item_ids.length) {
        return { ok: false, envelope: error(HttpStatus.NOT_FOUND, "One or more library items not found or not owned by you") };
    }
    // R2 migration: there's no `status` column anymore — a library
    // row exists ONLY when the R2 upload succeeded. We gate on
    // file_url instead, which is the explicit success signal.
    const not_completed = rows.filter(r => !r.file_url).map(r => r.title || r.id);
    if (not_completed.length > 0) {
        return {
            ok: false,
            envelope: error(
                HttpStatus.BAD_REQUEST,
                `Only items with a saved file can be scheduled. Not ready: ${not_completed.slice(0, 3).join(", ")}${not_completed.length > 3 ? "…" : ""}`,
            ),
        };
    }
    const by_id = new Map(rows.map(r => [r.id, r] as const));
    const slots: SlotInput[] = library_item_ids.map(id => {
        const r = by_id.get(id)!;
        return { library_item_id: r.id, title: r.title ?? r.file_name ?? null };
    });
    const library_items = library_item_ids.map(id => by_id.get(id)!);
    return { ok: true, slots, library_items };
}

async function assert_ott_owned(user_id: string, ott_id: string) {
    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    return ott ?? null;
}

function build_event_title(slot: GeneratedSlot, prefix: string | null | undefined, platforms: string[]): string {
    const head = (prefix ? `${prefix.trim()} ` : "");
    const file = slot.title ?? "Upload";
    const tail = platforms.length > 0 ? ` — ${platforms.join(", ")}` : "";
    return `${head}Upload: ${file}${tail}`.slice(0, 255);
}

export async function preview_schedule(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const body = req.body as PreviewScheduleInput;

    const ott = await assert_ott_owned(user_id, body.ott_id);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const loaded = await load_and_validate_items(user_id, body.ott_id, body.library_item_ids);
    if (!loaded.ok) return loaded.envelope;

    if (body.scheduled === false) {
        // Draft preview — emit one row per file with no scheduledAt so the UI
        // can still show the list.
        const items = loaded.slots.map(s => ({
            library_item_id: s.library_item_id,
            title: s.title,
            scheduledAt: null,
            platforms: body.platforms,
            color: body.color ?? null,
        }));
        return success("Schedule preview generated", {
            total_files: items.length,
            total_slots: 0,
            scheduled_count: 0,
            unscheduled_count: items.length,
            warnings: ["scheduled=false — items saved as drafts (no scheduledAt)"],
            items,
        });
    }

    const result = generate_upload_schedule({
        library_items: loaded.slots,
        frequency: body.frequency!,
        release_count: body.release_count ?? 1,
        upload_times: body.upload_times,
        start_date: body.start_date!,
        end_date: body.end_date ?? null,
        weekdays: body.weekdays,
        month_days: body.month_days,
    });

    const items = result.items.map(s => ({
        library_item_id: s.library_item_id,
        title: s.title,
        scheduledAt: s.scheduledAt,
        platforms: body.platforms,
        color: body.color ?? null,
    }));

    return success("Schedule preview generated", {
        total_files: result.total_files,
        total_slots: result.total_slots,
        scheduled_count: result.scheduled_count,
        unscheduled_count: result.unscheduled_count,
        warnings: result.warnings,
        items,
    });
}

export async function create_schedule(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const body = req.body as CreateScheduleInput;

    const ott = await assert_ott_owned(user_id, body.ott_id);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const loaded = await load_and_validate_items(user_id, body.ott_id, body.library_item_ids);
    if (!loaded.ok) return loaded.envelope;

    // Generator output drives row creation. For drafts we still create one
    // upload_schedule_item per library item so the history is complete; the
    // calendar event step is skipped when scheduledAt is null.
    let generated_items: Array<{ library_item_id: string; title: string | null; scheduledAt: string | null }>;
    let warnings: string[] = [];
    let unscheduled_count = 0;
    let scheduled_count = 0;

    if (body.scheduled === false) {
        generated_items = loaded.slots.map(s => ({
            library_item_id: s.library_item_id,
            title: s.title,
            scheduledAt: null,
        }));
        unscheduled_count = generated_items.length;
    } else {
        const gen = generate_upload_schedule({
            library_items: loaded.slots,
            frequency: body.frequency!,
            release_count: body.release_count ?? 1,
            upload_times: body.upload_times,
            start_date: body.start_date!,
            end_date: body.end_date ?? null,
            weekdays: body.weekdays,
            month_days: body.month_days,
        });
        generated_items = gen.items;
        warnings = gen.warnings;
        scheduled_count = gen.scheduled_count;
        unscheduled_count = gen.unscheduled_count;
        // Unscheduled library items still get persisted as drafts so the user
        // can re-run the generator later with a longer range.
        for (const id of gen.unscheduled_library_item_ids) {
            const slot = loaded.slots.find(s => s.library_item_id === id);
            if (slot) generated_items.push({ library_item_id: id, title: slot.title, scheduledAt: null });
        }
    }

    const final_status = body.scheduled === false ? "draft" : "scheduled";
    const platforms = body.platforms as SupportedPlatform[];

    const result = await sequelize.transaction(async (tx) => {
        const batch = await UploadScheduleBatch.create({
            user_id,
            ott_id: body.ott_id,
            name: body.name ?? null,
            scheduled: body.scheduled !== false,
            platforms,
            frequency: body.frequency ?? null,
            release_count: body.release_count ?? 1,
            upload_times: body.upload_times ?? [],
            start_date: body.start_date ?? null,
            end_date: body.end_date ?? null,
            weekdays: body.weekdays ?? [],
            month_days: body.month_days ?? [],
            color: body.color ?? null,
            title_prefix: body.title_prefix ?? null,
            description: body.description ?? null,
            tags: body.tags ?? [],
            status: final_status,
            metadata: (body as any).metadata ?? {},
        } as any, { transaction: tx });

        const items: UploadScheduleItem[] = [];
        // When auto_details is on, ONLY fields the user explicitly typed
        // get persisted to the schedule item — empty fields stay null so
        // the cron's resolver knows to fill them from Gemini. With
        // auto_details off we keep the legacy behaviour (fall back to the
        // library item's filename / batch description) so the existing
        // non-AI flow still works without forcing the user to type a title.
        const auto = !!(body as any).auto_details;
        const md = ((body as any).manual_details ?? {}) as {
            title?: string; description?: string; caption?: string;
            tags?: string[]; hashtags?: string[];
        };
        // Token expansion — the user types `${number}` / `${index}` /
        // `${count}` in title / description / caption / tags / hashtags
        // and each per-item value gets its 1-based position substituted
        // in. Position is taken from the user's order in
        // `library_item_ids` (the frontend's drag-and-drop arranges this
        // array, so position 1 is whichever file is at the top).
        const total_count = body.library_item_ids.length;
        const expand_tokens = (s: string, position_1based: number) => s
            .replace(/\$\{number\}/g, String(position_1based))
            .replace(/\$\{index\}/g, String(position_1based - 1))
            .replace(/\$\{count\}/g, String(total_count))
            .replace(/\{number\}/g, String(position_1based))
            .replace(/\{index\}/g, String(position_1based - 1))
            .replace(/\{count\}/g, String(total_count));
        const expand_in_array = (arr: string[] | undefined, pos: number): string[] | undefined =>
            arr ? arr.map(v => expand_tokens(v, pos)) : arr;

        for (const g of generated_items) {
            const position_idx = body.library_item_ids.indexOf(g.library_item_id);
            const position = position_idx >= 0 ? position_idx + 1 : 1;
            const item_status = g.scheduledAt ? "scheduled" : "draft";
            const md_title = md.title?.trim() ? expand_tokens(md.title.trim(), position) : null;
            const md_desc  = md.description?.trim() ? expand_tokens(md.description.trim(), position) : null;
            const md_cap   = md.caption?.trim() ? expand_tokens(md.caption.trim(), position) : null;
            const md_tags  = expand_in_array(md.tags, position);
            const md_hash  = expand_in_array(md.hashtags, position);

            const item_title = auto
                ? (md_title || null)
                : (md_title || g.title);
            const item_description = auto
                ? (md_desc || null)
                : (md_desc || (body.description ? expand_tokens(body.description, position) : null));
            const item_caption = auto
                ? (md_cap || null)
                : (md_cap || null);
            const item_tags = auto
                ? (md_tags && md_tags.length > 0 ? md_tags : [])
                : (md_tags && md_tags.length > 0 ? md_tags : (body.tags ?? []).map(t => expand_tokens(t, position)));
            const item_hashtags = (md_hash && md_hash.length > 0) ? md_hash : [];

            const item = await UploadScheduleItem.create({
                user_id,
                batch_id: batch.id,
                ott_id: body.ott_id,
                library_item_id: g.library_item_id,
                calendar_event_id: null,
                title: item_title,
                description: item_description,
                caption: item_caption,
                platforms,
                scheduled_at: g.scheduledAt ? new Date(g.scheduledAt) : null,
                color: body.color ?? null,
                status: item_status,
                upload_result: {},
                error_message: null,
                metadata: {},
                auto_details: auto,
                tags: item_tags,
                hashtags: item_hashtags,
                analysis_result_ids: [],
                platform_details: (body as any).platform_details ?? {},
            } as any, { transaction: tx });

            if (g.scheduledAt) {
                const ev = await CalendarEvent.create({
                    user_id,
                    title: build_event_title(g as any, body.title_prefix ?? null, platforms),
                    description: body.description ?? null,
                    start_at: new Date(g.scheduledAt),
                    end_at: null,
                    all_day: false,
                    event_type: "upload_schedule",
                    color: body.color ?? null,
                    status: "scheduled",
                    upload_schedule_item_id: item.id,
                    library_item_id: g.library_item_id,
                    ott_id: body.ott_id,
                    metadata: { batch_id: batch.id, platforms },
                } as any, { transaction: tx });
                (item as any).calendar_event_id = ev.id;
                await item.save({ transaction: tx });
            }
            items.push(item);
        }
        return { batch, items };
    });

    // Post-transaction: generate reminders for every newly-created calendar
    // event. Done outside the transaction so an FCM-table hiccup can't roll
    // back the actual schedule. Best-effort per item.
    for (const item of result.items) {
        const eventId = (item as any).calendar_event_id as string | null | undefined;
        const scheduledAt = (item as any).scheduled_at as Date | null | undefined;
        if (!eventId || !scheduledAt) continue;
        try {
            await regenerate_reminders({
                user_id,
                calendar_event_id: eventId,
                start_at: new Date(scheduledAt as any),
            });
        } catch (err) {
            console.log("Error:- create_schedule regenerate_reminders", err);
        }
    }

    const lib_by_id = new Map(loaded.library_items.map(l => [l.id, l] as const));
    return success("Schedule created", {
        batch: batch_dto(result.batch, { items_count: result.items.length, scheduled_count }),
        items: result.items.map(i => item_dto(i, lib_by_id.get(i.library_item_id!) ?? null)),
        warnings,
        scheduled_count,
        unscheduled_count,
    }, HttpStatus.CREATED);
}

/**
 * Replace a draft schedule's contents — same payload contract as create.
 * Currently restricted to status === 'draft' so we don't have to think
 * about preserving / refunding already-uploaded items (that's a Scenario 2
 * concern). Items + linked calendar events are wiped and rebuilt from
 * the fresh payload; the batch row id is preserved.
 */
export async function update_schedule(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { batch_id } = req.params as { batch_id: string };
    const body = req.body as CreateScheduleInput;

    const batch = await UploadScheduleBatch.findOne({ where: { id: batch_id, user_id } as any });
    if (!batch) return error(HttpStatus.NOT_FOUND, "Schedule not found");
    if (batch.status !== "draft") {
        return error(HttpStatus.BAD_REQUEST, `Only drafts can be edited (current status: ${batch.status})`);
    }

    const ott = await assert_ott_owned(user_id, body.ott_id);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const loaded = await load_and_validate_items(user_id, body.ott_id, body.library_item_ids);
    if (!loaded.ok) return loaded.envelope;

    let generated_items: Array<{ library_item_id: string; title: string | null; scheduledAt: string | null }>;
    let warnings: string[] = [];
    let unscheduled_count = 0;
    let scheduled_count = 0;

    if (body.scheduled === false) {
        generated_items = loaded.slots.map(s => ({
            library_item_id: s.library_item_id,
            title: s.title,
            scheduledAt: null,
        }));
        unscheduled_count = generated_items.length;
    } else {
        const gen = generate_upload_schedule({
            library_items: loaded.slots,
            frequency: body.frequency!,
            release_count: body.release_count ?? 1,
            upload_times: body.upload_times,
            start_date: body.start_date!,
            end_date: body.end_date ?? null,
            weekdays: body.weekdays,
            month_days: body.month_days,
        });
        generated_items = gen.items;
        warnings = gen.warnings;
        scheduled_count = gen.scheduled_count;
        unscheduled_count = gen.unscheduled_count;
        for (const id of gen.unscheduled_library_item_ids) {
            const slot = loaded.slots.find(s => s.library_item_id === id);
            if (slot) generated_items.push({ library_item_id: id, title: slot.title, scheduledAt: null });
        }
    }

    const final_status = body.scheduled === false ? "draft" : "scheduled";
    const platforms = body.platforms as SupportedPlatform[];

    const result = await sequelize.transaction(async (tx) => {
        // Wipe linked calendar events first (paranoid soft-delete), then
        // items, then update the batch in place. Order matters because
        // we need the calendar_event_id list before the items are gone.
        const old_items = await UploadScheduleItem.findAll({
            where: { batch_id, user_id } as any,
            attributes: ["calendar_event_id"],
            raw: true,
            transaction: tx,
        });
        const event_ids = (old_items as any[])
            .map(i => i.calendar_event_id)
            .filter(Boolean) as string[];
        if (event_ids.length > 0) {
            await CalendarEvent.destroy({ where: { id: event_ids, user_id } as any, transaction: tx });
        }
        await UploadScheduleItem.destroy({ where: { batch_id, user_id } as any, transaction: tx });

        // Patch batch in place.
        (batch as any).ott_id = body.ott_id;
        (batch as any).name = body.name ?? null;
        (batch as any).scheduled = body.scheduled !== false;
        (batch as any).platforms = platforms;
        (batch as any).frequency = body.frequency ?? null;
        (batch as any).release_count = body.release_count ?? 1;
        (batch as any).upload_times = body.upload_times ?? [];
        (batch as any).start_date = body.start_date ?? null;
        (batch as any).end_date = body.end_date ?? null;
        (batch as any).weekdays = body.weekdays ?? [];
        (batch as any).month_days = body.month_days ?? [];
        (batch as any).color = body.color ?? null;
        (batch as any).title_prefix = body.title_prefix ?? null;
        (batch as any).description = body.description ?? null;
        (batch as any).tags = body.tags ?? [];
        (batch as any).status = final_status;
        (batch as any).metadata = (body as any).metadata ?? {};
        await batch.save({ transaction: tx });

        // Recreate items + events with the fresh payload.
        const items: UploadScheduleItem[] = [];
        // When auto_details is on, ONLY fields the user explicitly typed
        // get persisted to the schedule item — empty fields stay null so
        // the cron's resolver knows to fill them from Gemini. With
        // auto_details off we keep the legacy behaviour (fall back to the
        // library item's filename / batch description) so the existing
        // non-AI flow still works without forcing the user to type a title.
        const auto = !!(body as any).auto_details;
        const md = ((body as any).manual_details ?? {}) as {
            title?: string; description?: string; caption?: string;
            tags?: string[]; hashtags?: string[];
        };
        // Token expansion — the user types `${number}` / `${index}` /
        // `${count}` in title / description / caption / tags / hashtags
        // and each per-item value gets its 1-based position substituted
        // in. Position is taken from the user's order in
        // `library_item_ids` (the frontend's drag-and-drop arranges this
        // array, so position 1 is whichever file is at the top).
        const total_count = body.library_item_ids.length;
        const expand_tokens = (s: string, position_1based: number) => s
            .replace(/\$\{number\}/g, String(position_1based))
            .replace(/\$\{index\}/g, String(position_1based - 1))
            .replace(/\$\{count\}/g, String(total_count))
            .replace(/\{number\}/g, String(position_1based))
            .replace(/\{index\}/g, String(position_1based - 1))
            .replace(/\{count\}/g, String(total_count));
        const expand_in_array = (arr: string[] | undefined, pos: number): string[] | undefined =>
            arr ? arr.map(v => expand_tokens(v, pos)) : arr;

        for (const g of generated_items) {
            const position_idx = body.library_item_ids.indexOf(g.library_item_id);
            const position = position_idx >= 0 ? position_idx + 1 : 1;
            const item_status = g.scheduledAt ? "scheduled" : "draft";
            const md_title = md.title?.trim() ? expand_tokens(md.title.trim(), position) : null;
            const md_desc  = md.description?.trim() ? expand_tokens(md.description.trim(), position) : null;
            const md_cap   = md.caption?.trim() ? expand_tokens(md.caption.trim(), position) : null;
            const md_tags  = expand_in_array(md.tags, position);
            const md_hash  = expand_in_array(md.hashtags, position);

            const item_title = auto
                ? (md_title || null)
                : (md_title || g.title);
            const item_description = auto
                ? (md_desc || null)
                : (md_desc || (body.description ? expand_tokens(body.description, position) : null));
            const item_caption = auto
                ? (md_cap || null)
                : (md_cap || null);
            const item_tags = auto
                ? (md_tags && md_tags.length > 0 ? md_tags : [])
                : (md_tags && md_tags.length > 0 ? md_tags : (body.tags ?? []).map(t => expand_tokens(t, position)));
            const item_hashtags = (md_hash && md_hash.length > 0) ? md_hash : [];

            const item = await UploadScheduleItem.create({
                user_id,
                batch_id: batch.id,
                ott_id: body.ott_id,
                library_item_id: g.library_item_id,
                calendar_event_id: null,
                title: item_title,
                description: item_description,
                caption: item_caption,
                platforms,
                scheduled_at: g.scheduledAt ? new Date(g.scheduledAt) : null,
                color: body.color ?? null,
                status: item_status,
                upload_result: {},
                error_message: null,
                metadata: {},
                auto_details: auto,
                tags: item_tags,
                hashtags: item_hashtags,
                analysis_result_ids: [],
                platform_details: (body as any).platform_details ?? {},
            } as any, { transaction: tx });

            if (g.scheduledAt) {
                const ev = await CalendarEvent.create({
                    user_id,
                    title: build_event_title(g as any, body.title_prefix ?? null, platforms),
                    description: body.description ?? null,
                    start_at: new Date(g.scheduledAt),
                    end_at: null,
                    all_day: false,
                    event_type: "upload_schedule",
                    color: body.color ?? null,
                    status: "scheduled",
                    upload_schedule_item_id: item.id,
                    library_item_id: g.library_item_id,
                    ott_id: body.ott_id,
                    metadata: { batch_id: batch.id, platforms },
                } as any, { transaction: tx });
                (item as any).calendar_event_id = ev.id;
                await item.save({ transaction: tx });
            }
            items.push(item);
        }
        return { batch, items };
    });

    // Old reminders die with their old calendar event rows (the transaction
    // destroyed them). Generate fresh reminders for the new events.
    for (const item of result.items) {
        const eventId = (item as any).calendar_event_id as string | null | undefined;
        const scheduledAt = (item as any).scheduled_at as Date | null | undefined;
        if (!eventId || !scheduledAt) continue;
        try {
            await regenerate_reminders({
                user_id,
                calendar_event_id: eventId,
                start_at: new Date(scheduledAt as any),
            });
        } catch (err) {
            console.log("Error:- update_schedule regenerate_reminders", err);
        }
    }

    const lib_by_id = new Map(loaded.library_items.map(l => [l.id, l] as const));
    return success("Schedule updated", {
        batch: batch_dto(result.batch, { items_count: result.items.length, scheduled_count }),
        items: result.items.map(i => item_dto(i, lib_by_id.get(i.library_item_id!) ?? null)),
        warnings,
        scheduled_count,
        unscheduled_count,
    });
}

export async function list_schedules(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const q = (req.query ?? {}) as ListSchedulesQueryInput;

    const where: any = { user_id };
    if (q.ott_id) where.ott_id = q.ott_id;
    if (q.status) where.status = q.status;

    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const offset = (page - 1) * limit;

    const { rows, count } = await UploadScheduleBatch.findAndCountAll({
        where,
        order: [["createdAt", "DESC"]],
        limit,
        offset,
    });

    // Aggregate item counts in one query — N+1 would hurt the schedules page.
    const batch_ids = rows.map(r => r.id);
    const counts_by_batch = new Map<string, { total: number; scheduled: number }>();
    if (batch_ids.length > 0) {
        const items = await UploadScheduleItem.findAll({
            where: { batch_id: batch_ids } as any,
            attributes: ["batch_id", "status"],
            raw: true,
        });
        for (const i of items as any[]) {
            const key = i.batch_id as string;
            const cur = counts_by_batch.get(key) ?? { total: 0, scheduled: 0 };
            cur.total += 1;
            if (i.status === "scheduled") cur.scheduled += 1;
            counts_by_batch.set(key, cur);
        }
    }

    // Resolve OTT names so the list view can show a label without a join.
    const ott_ids = Array.from(new Set(rows.map(r => r.ott_id).filter(Boolean))) as string[];
    const otts = ott_ids.length > 0
        ? await OttPlatform.findAll({ where: { id: ott_ids, user_id } as any, attributes: ["id", "name"] })
        : [];
    const ott_name_by_id = new Map(otts.map(o => [o.id, o.name] as const));

    return success("Schedules fetched", {
        total: count,
        page,
        limit,
        batches: rows.map(b => ({
            ...batch_dto(b, counts_by_batch.get(b.id) ? {
                items_count: counts_by_batch.get(b.id)!.total,
                scheduled_count: counts_by_batch.get(b.id)!.scheduled,
            } : {}),
            ott_name: b.ott_id ? (ott_name_by_id.get(b.ott_id) ?? null) : null,
        })),
    });
}

export async function get_schedule(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { batch_id } = req.params as { batch_id: string };

    const batch = await UploadScheduleBatch.findOne({ where: { id: batch_id, user_id } as any });
    if (!batch) return error(HttpStatus.NOT_FOUND, "Schedule not found");

    const items = await UploadScheduleItem.findAll({
        where: { batch_id, user_id } as any,
        order: [["scheduled_at", "ASC"], ["createdAt", "ASC"]],
    });

    const lib_ids = Array.from(new Set(items.map(i => i.library_item_id).filter(Boolean))) as string[];
    const libs = lib_ids.length > 0
        ? await OttLibraryItem.findAll({ where: { id: lib_ids, user_id } as any })
        : [];
    const lib_by_id = new Map(libs.map(l => [l.id, l] as const));

    const ott = batch.ott_id
        ? await OttPlatform.findOne({ where: { id: batch.ott_id, user_id } as any, attributes: ["id", "name"] })
        : null;

    const scheduled_count = items.filter(i => i.status === "scheduled").length;
    return success("Schedule fetched", {
        batch: { ...batch_dto(batch, { items_count: items.length, scheduled_count }), ott_name: ott?.name ?? null },
        items: items.map(i => item_dto(i, lib_by_id.get(i.library_item_id!) ?? null)),
    });
}

export async function cancel_schedule(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { batch_id } = req.params as { batch_id: string };

    const batch = await UploadScheduleBatch.findOne({ where: { id: batch_id, user_id } as any });
    if (!batch) return error(HttpStatus.NOT_FOUND, "Schedule not found");

    let cancelled_event_ids: string[] = [];
    await sequelize.transaction(async (tx) => {
        (batch as any).status = "cancelled";
        await batch.save({ transaction: tx });

        // Only flip not-yet-uploaded items so historical results stay intact.
        await UploadScheduleItem.update(
            { status: "cancelled" } as any,
            { where: { batch_id, user_id, status: ["scheduled", "draft"] } as any, transaction: tx },
        );

        const items = await UploadScheduleItem.findAll({
            where: { batch_id, user_id } as any,
            attributes: ["calendar_event_id"],
            raw: true,
        });
        cancelled_event_ids = (items as any[])
            .map(i => i.calendar_event_id)
            .filter(Boolean) as string[];
        if (cancelled_event_ids.length > 0) {
            await CalendarEvent.update(
                { status: "cancelled" } as any,
                { where: { id: cancelled_event_ids, user_id } as any, transaction: tx },
            );
        }
    });

    // Skip any pending reminders for the events we just cancelled — pass
    // `cancelled: true` so the helper just marks them skipped instead of
    // recomputing reminder times.
    for (const eventId of cancelled_event_ids) {
        try {
            await regenerate_reminders({
                user_id,
                calendar_event_id: eventId,
                start_at: new Date(),
                cancelled: true,
            });
        } catch (err) {
            console.log("Error:- cancel_schedule regenerate_reminders", err);
        }
    }

    return success("Schedule cancelled", { id: batch_id });
}

export async function delete_schedule(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { batch_id } = req.params as { batch_id: string };

    const batch = await UploadScheduleBatch.findOne({ where: { id: batch_id, user_id } as any });
    if (!batch) return error(HttpStatus.NOT_FOUND, "Schedule not found");

    let deleted_event_ids: string[] = [];
    await sequelize.transaction(async (tx) => {
        // Linked calendar events first — paranoid soft delete leaves rows
        // recoverable but invisible to subsequent queries.
        const items = await UploadScheduleItem.findAll({
            where: { batch_id, user_id } as any,
            attributes: ["calendar_event_id"],
            raw: true,
        });
        deleted_event_ids = (items as any[])
            .map(i => i.calendar_event_id)
            .filter(Boolean) as string[];
        if (deleted_event_ids.length > 0) {
            await CalendarEvent.destroy({ where: { id: deleted_event_ids, user_id } as any, transaction: tx });
        }
        // Items cascade via FK on batch destroy, but we destroy explicitly so
        // the paranoid timestamp is set on each row consistently.
        await UploadScheduleItem.destroy({ where: { batch_id, user_id } as any, transaction: tx });
        await batch.destroy({ transaction: tx });
    });

    // Drop pending reminders so the cron doesn't try to load a destroyed
    // event. CASCADE on the FK would clean them eventually but marking
    // skipped immediately is cleaner.
    for (const eventId of deleted_event_ids) {
        try {
            await regenerate_reminders({
                user_id,
                calendar_event_id: eventId,
                start_at: new Date(),
                cancelled: true,
            });
        } catch (err) {
            console.log("Error:- delete_schedule regenerate_reminders", err);
        }
    }

    return success("Schedule deleted", { id: batch_id });
}

/**
 * Returns a map of library_item_id → next scheduled_at (and batch info) so
 * the library grid can render schedule badges. Only considers items that are
 * still in 'scheduled' state and have a future scheduled_at.
 */
export async function get_library_schedule_status(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const q = (req.query ?? {}) as { ott_id?: string };

    const where: any = { user_id, status: "scheduled" };
    if (q.ott_id) where.ott_id = q.ott_id;

    const items = await UploadScheduleItem.findAll({
        where,
        attributes: ["library_item_id", "scheduled_at", "batch_id", "platforms", "status"],
        order: [["scheduled_at", "ASC"]],
        raw: true,
    });

    const next_by_lib = new Map<string, any>();
    for (const i of items as any[]) {
        if (!i.library_item_id) continue;
        if (!next_by_lib.has(i.library_item_id)) {
            next_by_lib.set(i.library_item_id, {
                library_item_id: i.library_item_id,
                next_scheduledAt: ts(i.scheduled_at),
                batch_id: i.batch_id,
                platforms: i.platforms ?? [],
                status: i.status,
            });
        }
    }

    return success("Library schedule status fetched", {
        items: Array.from(next_by_lib.values()),
    });
}
