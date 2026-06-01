/**
 * Dashboard overview — single endpoint that gathers real counts from
 * existing modules (OTT / Library / Schedules / Social Uploads).
 *
 *   GET /api/dashboard/overview
 *
 * NO new tables introduced. Every query reads existing rows scoped by
 * the JWT's `user_id`. NO live platform API calls — analytics live in
 * their own endpoint and shouldn't slow this down.
 *
 * Resilience: each section's query is wrapped in try/catch so a single
 * broken table doesn't 500 the whole dashboard. Empty results are
 * always valid — the UI handles them with empty states.
 */

import type { FastifyRequest } from "fastify";
import { Op, QueryTypes } from "sequelize";
import { sequelize } from "../../db";
import {
    OttPlatform,
    OttLibraryItem,
    UploadScheduleItem,
    SocialUpload,
    SocialAccount,
} from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";

function dlog(step: string, data?: Record<string, any>) {
    console.log(`[dashboard] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

// ── Section: OTT counts ────────────────────────────────────────────────

async function ott_summary(user_id: string) {
    try {
        const total = await OttPlatform.count({ where: { user_id } as any });
        // No `is_active` column in the model — counting non-deleted as active.
        return { total_otts: total, active_otts: total };
    } catch (err: any) {
        dlog("ott_summary_failed", { error: err?.message });
        return { total_otts: 0, active_otts: 0 };
    }
}

// ── Section: Library status ────────────────────────────────────────────

async function library_summary(user_id: string) {
    // Post-R2 there is no status column — a row exists if and only if
    // the R2 upload succeeded. So `completed = file_url IS NOT NULL`,
    // `failed = file_url IS NULL` (covers folder placeholders that
    // never got bytes), and the in-flight buckets are always zero.
    const empty = { completed: 0, failed: 0, total: 0 };
    try {
        const rows = await sequelize.query<{ has_url: boolean; cnt: string }>(
            `SELECT (file_url IS NOT NULL) AS has_url, COUNT(*)::text AS cnt
             FROM ott_library_items
             WHERE user_id = :user_id
               AND "deletedAt" IS NULL
               AND save_type != 'folder_placeholder'
             GROUP BY (file_url IS NOT NULL)`,
            { type: QueryTypes.SELECT, replacements: { user_id } },
        );
        const counts = { ...empty };
        for (const r of rows) {
            const n = Number(r.cnt) || 0;
            counts.total += n;
            if (r.has_url) counts.completed += n;
            else counts.failed += n;
        }
        return counts;
    } catch (err: any) {
        dlog("library_summary_failed", { error: err?.message });
        return empty;
    }
}

// ── Section: Social uploads per platform ───────────────────────────────

async function social_summary(user_id: string) {
    const empty_platform = { uploaded: 0, scheduled: 0, failed: 0 };
    const result = {
        youtube: { ...empty_platform },
        facebook: { ...empty_platform },
        instagram: { ...empty_platform },
        total_uploaded: 0,
        total_failed: 0,
        total_scheduled: 0,
    };
    try {
        const rows = await sequelize.query<{ platform: string; status: string; cnt: string }>(
            `SELECT platform, status, COUNT(*)::text AS cnt
             FROM social_uploads
             WHERE user_id = :user_id
             GROUP BY platform, status`,
            { type: QueryTypes.SELECT, replacements: { user_id } },
        );
        for (const r of rows) {
            const n = Number(r.cnt) || 0;
            const bucket = r.status === "uploaded" ? "uploaded"
                : r.status === "scheduled" ? "scheduled"
                : r.status === "failed" ? "failed"
                : null;
            if (!bucket) continue;
            const plat = (result as any)[r.platform];
            if (plat) {
                plat[bucket] += n;
                if (bucket === "uploaded") result.total_uploaded += n;
                else if (bucket === "scheduled") result.total_scheduled += n;
                else result.total_failed += n;
            }
        }
        return result;
    } catch (err: any) {
        dlog("social_summary_failed", { error: err?.message });
        return result;
    }
}

// ── Section: Schedules ────────────────────────────────────────────────

async function schedule_summary(user_id: string) {
    try {
        const today_start = new Date(); today_start.setHours(0, 0, 0, 0);
        const today_end = new Date(); today_end.setHours(23, 59, 59, 999);

        const today_count = await UploadScheduleItem.count({
            where: { user_id, scheduled_at: { [Op.between]: [today_start, today_end] } } as any,
        });
        const upcoming_count = await UploadScheduleItem.count({
            where: { user_id, scheduled_at: { [Op.gt]: new Date() }, status: "scheduled" } as any,
        });
        return { today_schedules: today_count, upcoming_schedules: upcoming_count };
    } catch (err: any) {
        dlog("schedule_summary_failed", { error: err?.message });
        return { today_schedules: 0, upcoming_schedules: 0 };
    }
}

async function upcoming_schedule_items(user_id: string, limit = 5) {
    try {
        const rows = await UploadScheduleItem.findAll({
            where: { user_id, scheduled_at: { [Op.gt]: new Date() }, status: "scheduled" } as any,
            order: [["scheduled_at", "ASC"]],
            limit,
            attributes: ["id", "title", "scheduled_at", "platforms", "status"],
        });
        return rows.map(r => ({
            id: r.id,
            title: (r as any).title ?? "(untitled)",
            scheduledAt: (r as any).scheduled_at ?? null,
            platforms: (r as any).platforms ?? [],
            status: r.status ?? null,
        }));
    } catch (err: any) {
        dlog("upcoming_schedule_items_failed", { error: err?.message });
        return [];
    }
}

// ── Section: Failed / needs attention ─────────────────────────────────

async function failed_items(user_id: string, limit = 10) {
    try {
        // Post-R2 the `status` column was removed from ott_library_items
        // — a library row exists only when R2 succeeded, so there are no
        // library failures to surface anymore. Only social uploads still
        // have a status machine; keep that half of the union.
        const social_rows = await SocialUpload.findAll({
            where: { user_id, status: "failed" } as any,
            order: [["updatedAt", "DESC"]],
            limit,
            attributes: ["id", "title", "platform", "error_message", "updatedAt"],
        });

        const merged = social_rows.map(r => ({
            id: r.id,
            module: "social" as const,
            title: (r as any).title ?? "(untitled)",
            error_message: (r as any).error_message ?? null,
            meta: { platform: r.platform ?? null },
            updatedAt: (r as any).updatedAt ?? null,
        }));
        merged.sort((a, b) => (b.updatedAt?.getTime?.() ?? 0) - (a.updatedAt?.getTime?.() ?? 0));
        return merged.slice(0, limit);
    } catch (err: any) {
        dlog("failed_items_failed", { error: err?.message });
        return [];
    }
}

// ── Section: Recent activity ──────────────────────────────────────────

async function recent_activity(user_id: string, limit = 12) {
    try {
        // Pull latest updated rows from library + social + schedules.
        // No dedicated activity log table — we synthesise from updated_at
        // timestamps. Cheap, no extra tables.
        const lib_rows = await OttLibraryItem.findAll({
            where: { user_id } as any,
            order: [["updatedAt", "DESC"]],
            limit,
            attributes: ["id", "title", "file_name", "updatedAt"],
        });
        const social_rows = await SocialUpload.findAll({
            where: { user_id } as any,
            order: [["updatedAt", "DESC"]],
            limit,
            attributes: ["id", "title", "platform", "status", "updatedAt"],
        });
        const schedule_rows = await UploadScheduleItem.findAll({
            where: { user_id } as any,
            order: [["updatedAt", "DESC"]],
            limit,
            attributes: ["id", "title", "platforms", "status", "updatedAt"],
        });

        const merged = [
            ...lib_rows.map(r => ({
                id: r.id,
                module: "library" as const,
                title: (r as any).title ?? (r as any).file_name ?? "(untitled)",
                // status column was removed in the R2 migration —
                // a library row exists only when the upload
                // succeeded, so it's always effectively "completed".
                status: "completed" as const,
                meta: null as any,
                updatedAt: (r as any).updatedAt ?? null,
            })),
            ...social_rows.map(r => ({
                id: r.id,
                module: "social" as const,
                title: (r as any).title ?? "(untitled)",
                status: r.status ?? null,
                meta: { platform: r.platform ?? null },
                updatedAt: (r as any).updatedAt ?? null,
            })),
            ...schedule_rows.map(r => ({
                id: r.id,
                module: "schedule" as const,
                title: (r as any).title ?? "(untitled)",
                status: r.status ?? null,
                meta: { platforms: (r as any).platforms ?? [] },
                updatedAt: (r as any).updatedAt ?? null,
            })),
        ];
        merged.sort((a, b) => (b.updatedAt?.getTime?.() ?? 0) - (a.updatedAt?.getTime?.() ?? 0));
        return merged.slice(0, limit);
    } catch (err: any) {
        dlog("recent_activity_failed", { error: err?.message });
        return [];
    }
}

// ── Section: System health ────────────────────────────────────────────

async function system_health(user_id: string) {
    try {
        // Token health by platform — a row in `expired` status flags the
        // platform as "needs attention". The user reconnects from the
        // social-media page.
        const accounts = await SocialAccount.findAll({
            where: { user_id } as any,
            attributes: ["platform", "status"],
        });
        const tokens = { connected: 0, expired: 0 };
        const per_platform: Record<string, "connected" | "expired" | "missing"> = {
            youtube: "missing", facebook: "missing", instagram: "missing",
        };
        for (const a of accounts) {
            const p = (a as any).platform as string;
            const s = (a as any).status as string;
            if (s === "expired") {
                tokens.expired += 1;
                if (per_platform[p] !== "connected") per_platform[p] = "expired";
            } else {
                tokens.connected += 1;
                per_platform[p] = "connected";
            }
        }

        // Social upload activity — the only queue left after Drive went
        // away. Library uploads land in R2 synchronously and have no
        // in-flight state for the dashboard to surface.
        const social_active = await SocialUpload.count({
            where: { user_id, status: { [Op.in]: ["uploading", "scheduled"] } } as any,
        });
        const social_failed_total = await SocialUpload.count({
            where: { user_id, status: "failed" } as any,
        });

        return {
            tokens,
            per_platform_token_status: per_platform,
            social_queue: { active: social_active, failed: social_failed_total },
        };
    } catch (err: any) {
        dlog("system_health_failed", { error: err?.message });
        return {
            tokens: { connected: 0, expired: 0 },
            per_platform_token_status: { youtube: "missing", facebook: "missing", instagram: "missing" },
            social_queue: { active: 0, failed: 0 },
        };
    }
}

// ── Top OTTs by library count ─────────────────────────────────────────

async function top_otts(user_id: string, limit = 5) {
    try {
        const rows = await sequelize.query<{ ott_id: string; cnt: string }>(
            `SELECT ott_id, COUNT(*)::text AS cnt
             FROM ott_library_items
             WHERE user_id = :user_id AND "deletedAt" IS NULL AND ott_id IS NOT NULL
             GROUP BY ott_id
             ORDER BY COUNT(*) DESC
             LIMIT ${limit}`,
            { type: QueryTypes.SELECT, replacements: { user_id } },
        );
        if (rows.length === 0) return [];
        const otts = await OttPlatform.findAll({
            where: { id: { [Op.in]: rows.map(r => r.ott_id) }, user_id } as any,
            attributes: ["id", "name"],
        });
        const name_by_id = new Map(otts.map(o => [o.id, (o as any).name]));
        return rows.map(r => ({
            ott_id: r.ott_id,
            name: name_by_id.get(r.ott_id) ?? "(unknown)",
            library_count: Number(r.cnt) || 0,
        }));
    } catch (err: any) {
        dlog("top_otts_failed", { error: err?.message });
        return [];
    }
}

// ── Orchestrator ──────────────────────────────────────────────────────

export async function get_dashboard_overview(req: FastifyRequest) {
    const user_id = (req as any).userId as string | undefined;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");

    // Run independent sections in parallel — Promise.all is safe because
    // each section already swallows its own errors and returns a default
    // shape. So a single broken section degrades to zeros, the rest
    // render normally.
    const [
        ott, library, social, schedules, upcoming, failed, activity, health, top,
    ] = await Promise.all([
        ott_summary(user_id),
        library_summary(user_id),
        social_summary(user_id),
        schedule_summary(user_id),
        upcoming_schedule_items(user_id, 5),
        failed_items(user_id, 10),
        recent_activity(user_id, 15),
        system_health(user_id),
        top_otts(user_id, 5),
    ]);

    return success("dashboard overview", {
        fetched_at: new Date().toISOString(),
        summary: {
            total_otts: ott.total_otts,
            active_otts: ott.active_otts,
            total_library_items: library.total,
            completed_library_items: library.completed,
            failed_library_items: library.failed,
            today_schedules: schedules.today_schedules,
            upcoming_schedules: schedules.upcoming_schedules,
            social_uploaded: social.total_uploaded,
            social_failed: social.total_failed,
            social_scheduled: social.total_scheduled,
        },
        library_status: {
            completed: library.completed,
            failed: library.failed,
        },
        social_status: {
            youtube: social.youtube,
            facebook: social.facebook,
            instagram: social.instagram,
        },
        recent_activity: activity,
        recent_failed_items: failed,
        upcoming_schedules: upcoming,
        top_otts: top,
        system_health: health,
    });
}
