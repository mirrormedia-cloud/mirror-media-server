import type { FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import moment from "moment-timezone";
import { AutoPostConfig, AutoPostLog, SocialAccount } from "../../db/models";
import type { AutoPostFrequency } from "../../db/models/social/auto_post_config";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import { is_platform_allowed_for_user } from "../../shared/platform_access";
import { generate_thought_post, post_text_to_facebook } from "../../services/social/auto_post_generator.service";

const FREQUENCIES: AutoPostFrequency[] = ["every_day", "every_week", "every_month"];
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_POSTS_PER_DAY = 10;

// ── helpers ──────────────────────────────────────────────────────────────

function config_dto(c: AutoPostConfig) {
    return {
        id: c.id,
        enabled: !!c.enabled,
        social_account_id: c.social_account_id ?? null,
        frequency: c.frequency ?? "every_day",
        post_times: c.post_times ?? [],
        weekdays: c.weekdays ?? [],
        month_days: c.month_days ?? [],
        timezone: c.timezone ?? "UTC",
        auto_generate: true,
        enabled_at: c.enabled_at ?? null,
        updatedAt: (c as any).updatedAt,
    };
}

function log_dto(l: AutoPostLog) {
    return {
        id: l.id,
        slot_key: l.slot_key,
        content: l.content ?? null,
        status: l.status,
        platform_post_id: l.platform_post_id ?? null,
        post_url: l.platform_post_id ? `https://www.facebook.com/${l.platform_post_id}` : null,
        error_message: l.error_message ?? null,
        posted_at: l.posted_at ?? null,
        createdAt: (l as any).createdAt,
    };
}

async function connected_fb_accounts(user_id: string) {
    return SocialAccount.findAll({
        where: { user_id, platform: "facebook", status: "connected" } as any,
        order: [["createdAt", "ASC"]],
    });
}

/** The configured page if still connected, else the first connected FB page. */
export async function resolve_fb_account(user_id: string, preferred_id: string | null | undefined) {
    const accounts = await connected_fb_accounts(user_id);
    return accounts.find(a => a.id === preferred_id) ?? accounts[0] ?? null;
}

async function get_or_create_config(user_id: string) {
    const [row] = await AutoPostConfig.findOrCreate({
        where: { user_id } as any,
        defaults: { user_id, enabled: false, frequency: "every_day", post_times: ["10:00"], timezone: "UTC" } as any,
    });
    return row;
}

/**
 * Generate an AI thought and publish it to Facebook, recording the attempt
 * under `slot_key`. Returns null when the slot was already claimed (unique
 * index) — the caller treats that as "skipped".
 */
export async function run_auto_post(user_id: string, slot_key: string, preferred_account_id: string | null | undefined) {
    let log: AutoPostLog;
    try {
        log = await AutoPostLog.create({ user_id, slot_key, status: "pending" } as any);
    } catch (err: any) {
        if (err?.name === "SequelizeUniqueConstraintError") return null;
        throw err;
    }

    try {
        const account = await resolve_fb_account(user_id, preferred_account_id);
        if (!account) throw new Error("No connected Facebook Page — connect Facebook in Social Accounts");

        const recent = await AutoPostLog.findAll({
            where: { user_id, status: "posted" } as any,
            order: [["createdAt", "DESC"]],
            limit: 8,
            attributes: ["content"],
        });
        const thought = await generate_thought_post(recent.map(r => r.content ?? ""));
        await log.update({ content: thought.message, social_account_id: account.id } as any);

        const { post_id } = await post_text_to_facebook(account, thought.message);
        await log.update({ status: "posted", platform_post_id: post_id, posted_at: new Date(), error_message: null } as any);
    } catch (err: any) {
        await log.update({ status: "failed", error_message: String(err?.message ?? err).slice(0, 500) } as any);
    }
    return log;
}

// ── handlers ─────────────────────────────────────────────────────────────

export async function get_auto_post(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");

    const [config, accounts, logs] = await Promise.all([
        get_or_create_config(user_id),
        connected_fb_accounts(user_id),
        AutoPostLog.findAll({ where: { user_id } as any, order: [["createdAt", "DESC"]], limit: 30 }),
    ]);
    return success("Auto post settings", {
        config: config_dto(config),
        facebook_accounts: accounts.map(a => ({ id: a.id, page_id: a.page_id, page_name: a.page_name ?? a.account_name })),
        facebook_connected: accounts.length > 0,
        logs: logs.map(log_dto),
    });
}

interface SaveBody {
    enabled?: boolean;
    social_account_id?: string | null;
    frequency?: AutoPostFrequency;
    post_times?: string[];
    weekdays?: number[];
    month_days?: number[];
    timezone?: string;
}

export async function save_auto_post(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const body = (req.body ?? {}) as SaveBody;
    const config = await get_or_create_config(user_id);

    const patch: Record<string, any> = {};

    if (body.frequency !== undefined) {
        if (!FREQUENCIES.includes(body.frequency)) return error(HttpStatus.BAD_REQUEST, "Invalid frequency", "frequency");
        patch.frequency = body.frequency;
    }
    if (body.post_times !== undefined) {
        const times = Array.isArray(body.post_times) ? body.post_times : [];
        if (times.length < 1 || times.length > MAX_POSTS_PER_DAY) {
            return error(HttpStatus.BAD_REQUEST, `Post count must be between 1 and ${MAX_POSTS_PER_DAY}`, "post_times");
        }
        if (times.some(t => !HHMM_RE.test(t))) return error(HttpStatus.BAD_REQUEST, "Post times must be HH:MM (24h)", "post_times");
        patch.post_times = Array.from(new Set(times)).sort();
    }
    if (body.weekdays !== undefined) {
        patch.weekdays = Array.from(new Set((body.weekdays ?? []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))).sort();
    }
    if (body.month_days !== undefined) {
        patch.month_days = Array.from(new Set((body.month_days ?? []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 31))).sort((a, b) => a - b);
    }
    if (body.timezone !== undefined) {
        if (!moment.tz.zone(body.timezone)) return error(HttpStatus.BAD_REQUEST, "Invalid timezone", "timezone");
        patch.timezone = body.timezone;
    }
    if (body.social_account_id !== undefined) {
        if (body.social_account_id) {
            const acc = await SocialAccount.findOne({ where: { id: body.social_account_id, user_id, platform: "facebook" } as any });
            if (!acc) return error(HttpStatus.BAD_REQUEST, "Facebook Page not found", "social_account_id");
        }
        patch.social_account_id = body.social_account_id || null;
    }

    const next_frequency = patch.frequency ?? config.frequency;
    const next_weekdays: number[] = patch.weekdays ?? config.weekdays ?? [];
    const next_month_days: number[] = patch.month_days ?? config.month_days ?? [];
    const will_enable = body.enabled ?? config.enabled;

    if (will_enable) {
        if (next_frequency === "every_week" && next_weekdays.length === 0) {
            return error(HttpStatus.BAD_REQUEST, "Pick at least one weekday", "weekdays");
        }
        if (next_frequency === "every_month" && next_month_days.length === 0) {
            return error(HttpStatus.BAD_REQUEST, "Pick at least one day of month", "month_days");
        }
    }

    if (body.enabled !== undefined) {
        if (body.enabled) {
            if (!(await is_platform_allowed_for_user(user_id, "facebook"))) {
                return error(HttpStatus.FORBIDDEN, "Facebook is not available for this account");
            }
            const account = await resolve_fb_account(user_id, patch.social_account_id ?? config.social_account_id);
            if (!account) return error(HttpStatus.BAD_REQUEST, "Connect a Facebook Page before turning on Auto Post", "enabled");
            if (!config.enabled) patch.enabled_at = new Date();
        }
        patch.enabled = !!body.enabled;
    }

    await config.update(patch);
    return success("Auto post settings saved", config_dto(config));
}

/** Generate a sample thought without posting — powers the "Preview" button. */
export async function preview_auto_post(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    try {
        const thought = await generate_thought_post();
        return success("Preview generated", { message: thought.message, topic: thought.topic });
    } catch (err: any) {
        return error(HttpStatus.SERVICE_UNAVAILABLE, err?.message ?? "AI generation failed");
    }
}

/** Generate + publish immediately (outside the schedule). */
export async function post_now_auto_post(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    if (!(await is_platform_allowed_for_user(user_id, "facebook"))) {
        return error(HttpStatus.FORBIDDEN, "Facebook is not available for this account");
    }
    const config = await get_or_create_config(user_id);
    const account = await resolve_fb_account(user_id, config.social_account_id);
    if (!account) return error(HttpStatus.BAD_REQUEST, "Connect a Facebook Page first");

    const log = await run_auto_post(user_id, `manual:${randomUUID()}`, config.social_account_id);
    if (!log) return error(HttpStatus.CONFLICT, "Post already in progress");
    if (log.status !== "posted") return error(HttpStatus.BAD_GATEWAY, log.error_message ?? "Post failed", undefined, { log: log_dto(log) });
    return success("Posted to Facebook", log_dto(log));
}
