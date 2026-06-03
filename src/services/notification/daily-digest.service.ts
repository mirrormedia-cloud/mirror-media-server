/**
 * Daily digest service.
 *
 * Aggregates today's calendar events, scheduled uploads, and failed social
 * uploads for a user, then formats and sends a concise WhatsApp summary.
 */

import moment from "moment-timezone";
import { Op } from "sequelize";
import {
    User,
    UserProfile,
    UserNotificationSettings,
    CalendarEvent,
    SocialUpload,
    UploadScheduleItem,
} from "../../db/models";
import { sendWhatsappTextMessage } from "../../utils/whatsapp/send.message";
import { config } from "../../config";

const TZ = (config as any).app?.timezone || "Asia/Kolkata";
const DIGEST_TIME_HOUR = 8; // 8 AM in TZ

// ─── Types ─────────────────────────────────────────────────────────────────

interface DigestData {
    user_id: string;
    first_name: string;
    whatsapp_number: string;
    today_events: Array<{ title: string; start_at: Date; all_day: boolean; event_type: string }>;
    scheduled_uploads: Array<{ title: string | null; platforms: string[]; scheduled_at: Date | null }>;
    failed_uploads: Array<{ title: string | null; platform: string; error_message: string | null }>;
    upcoming_events_count: number;
}

// ─── Time helpers ──────────────────────────────────────────────────────────

export function is_digest_time(): boolean {
    const now = moment().tz(TZ);
    return now.hour() === DIGEST_TIME_HOUR && now.minute() === 0;
}

function today_range(): { start: Date; end: Date } {
    const start = moment().tz(TZ).startOf("day").toDate();
    const end = moment().tz(TZ).endOf("day").toDate();
    return { start, end };
}

// ─── Data fetching ─────────────────────────────────────────────────────────

async function fetch_digest_data(user_id: string, first_name: string, whatsapp_number: string): Promise<DigestData> {
    const { start, end } = today_range();
    const tomorrow_end = moment().tz(TZ).add(7, "days").endOf("day").toDate();

    const [today_events, scheduled_uploads, failed_uploads, upcoming_events_count] = await Promise.all([
        // Today's calendar events
        CalendarEvent.findAll({
            where: {
                user_id,
                start_at: { [Op.between]: [start, end] },
                status: { [Op.notIn]: ["cancelled"] },
            } as any,
            attributes: ["title", "start_at", "all_day", "event_type"],
            order: [["start_at", "ASC"]],
            raw: true,
        }),

        // Today's scheduled uploads
        UploadScheduleItem.findAll({
            where: {
                user_id,
                scheduled_at: { [Op.between]: [start, end] },
                status: { [Op.in]: ["scheduled", "draft"] },
            } as any,
            attributes: ["title", "platforms", "scheduled_at"],
            order: [["scheduled_at", "ASC"]],
            raw: true,
        }),

        // Failed social uploads in the last 24 hours
        SocialUpload.findAll({
            where: {
                user_id,
                status: "failed",
                updated_at: { [Op.gte]: moment().tz(TZ).subtract(24, "hours").toDate() },
            } as any,
            attributes: ["title", "platform", "error_message"],
            limit: 5,
            order: [["updated_at", "DESC"]],
            raw: true,
        }),

        // Upcoming events count (next 7 days, excluding today)
        CalendarEvent.count({
            where: {
                user_id,
                start_at: { [Op.between]: [end, tomorrow_end] },
                status: { [Op.notIn]: ["cancelled"] },
            } as any,
        }),
    ]);

    return {
        user_id,
        first_name,
        whatsapp_number,
        today_events: today_events as any[],
        scheduled_uploads: scheduled_uploads as any[],
        failed_uploads: failed_uploads as any[],
        upcoming_events_count,
    };
}

// ─── Message formatting ────────────────────────────────────────────────────

const PLATFORM_EMOJI: Record<string, string> = {
    youtube: "▶️",
    facebook: "📘",
    instagram: "📸",
};

const EVENT_TYPE_EMOJI: Record<string, string> = {
    content_release: "🚀",
    reminder: "🔔",
    meeting: "🤝",
    task: "✅",
    campaign: "📣",
    maintenance: "🔧",
    upload_schedule: "📤",
    custom: "📌",
};

function fmt_time(date: Date, all_day: boolean): string {
    if (all_day) return "All day";
    return moment(date).tz(TZ).format("h:mm A");
}

function fmt_platforms(platforms: string[]): string {
    return platforms
        .map(p => `${PLATFORM_EMOJI[p] ?? "📱"} ${p.charAt(0).toUpperCase() + p.slice(1)}`)
        .join(", ");
}

function build_message(d: DigestData): string {
    const date_str = moment().tz(TZ).format("dddd, D MMMM YYYY");
    const lines: string[] = [];

    lines.push(`🌅 *Good Morning, ${d.first_name}!*`);
    lines.push(`_${date_str}_`);
    lines.push("");

    // ── Today's Events ───────────────────────────────────────────────────
    if (d.today_events.length === 0) {
        lines.push("📅 *Today's Events*");
        lines.push("  No events scheduled for today.");
    } else {
        lines.push(`📅 *Today's Events (${d.today_events.length})*`);
        for (const ev of d.today_events) {
            const emoji = EVENT_TYPE_EMOJI[ev.event_type] ?? "📌";
            const time = fmt_time(ev.start_at, ev.all_day);
            lines.push(`  ${emoji} ${time} — ${ev.title}`);
        }
    }

    lines.push("");

    // ── Scheduled Uploads ────────────────────────────────────────────────
    if (d.scheduled_uploads.length === 0) {
        lines.push("📤 *Scheduled Uploads*");
        lines.push("  Nothing scheduled to upload today.");
    } else {
        lines.push(`📤 *Scheduled Uploads (${d.scheduled_uploads.length})*`);
        for (const up of d.scheduled_uploads) {
            const time = up.scheduled_at ? moment(up.scheduled_at).tz(TZ).format("h:mm A") : "—";
            const platforms = fmt_platforms(up.platforms ?? []);
            const title = up.title?.trim() || "Untitled";
            lines.push(`  • ${time} — ${title}`);
            lines.push(`    ${platforms}`);
        }
    }

    lines.push("");

    // ── Failed Uploads ───────────────────────────────────────────────────
    if (d.failed_uploads.length > 0) {
        lines.push(`⚠️ *Failed Uploads (${d.failed_uploads.length})*`);
        for (const f of d.failed_uploads) {
            const emoji = PLATFORM_EMOJI[f.platform] ?? "📱";
            const title = f.title?.trim() || "Untitled";
            lines.push(`  ${emoji} ${f.platform} — "${title}"`);
        }
        lines.push("");
    }

    // ── Upcoming ─────────────────────────────────────────────────────────
    if (d.upcoming_events_count > 0) {
        lines.push(`📆 *Upcoming (next 7 days):* ${d.upcoming_events_count} event${d.upcoming_events_count !== 1 ? "s" : ""}`);
        lines.push("");
    }

    // ── Status line ──────────────────────────────────────────────────────
    if (d.failed_uploads.length === 0 && d.today_events.length === 0 && d.scheduled_uploads.length === 0) {
        lines.push("✨ *A quiet day — enjoy the breathing room!*");
    } else if (d.failed_uploads.length > 0) {
        lines.push(`🔴 *Action needed:* ${d.failed_uploads.length} failed upload${d.failed_uploads.length !== 1 ? "s" : ""} require attention.`);
    } else {
        lines.push("✅ *All systems go — have a great day!*");
    }

    lines.push("");
    lines.push("— _Mirror Media Cloud_");

    return lines.join("\n");
}

// ─── Public: run one digest tick ──────────────────────────────────────────

export async function send_daily_digests(): Promise<{ sent: number; skipped: number; failed: number }> {
    // Find all users with WhatsApp enabled and a valid number
    const settings = await UserNotificationSettings.findAll({
        where: { whatsapp_enabled: true } as any,
        attributes: ["user_id"],
        raw: true,
    });

    if (settings.length === 0) return { sent: 0, skipped: 0, failed: 0 };

    const user_ids = settings.map((s: any) => s.user_id);

    const profiles = await UserProfile.findAll({
        where: {
            user_id: { [Op.in]: user_ids },
            whatsapp_country_code: { [Op.ne]: null },
            whatsapp_no: { [Op.ne]: null },
        } as any,
        attributes: ["user_id", "first_name", "whatsapp_country_code", "whatsapp_no"],
        raw: true,
    });

    let sent = 0, skipped = 0, failed = 0;

    for (const profile of profiles as any[]) {
        const code = String(profile.whatsapp_country_code ?? "").replace(/[^0-9]/g, "");
        const number = String(profile.whatsapp_no ?? "").replace(/[^0-9]/g, "");
        if (!code || !number) { skipped++; continue; }

        const whatsapp_number = code + number;
        const first_name = profile.first_name || "there";

        try {
            const data = await fetch_digest_data(profile.user_id, first_name, whatsapp_number);
            const message = build_message(data);
            const result = await sendWhatsappTextMessage(whatsapp_number, message);
            if (result.status) { sent++; } else { failed++; }
        } catch (err) {
            console.log(`[daily-digest] error for user ${profile.user_id}:`, err);
            failed++;
        }
    }

    return { sent, skipped, failed };
}
