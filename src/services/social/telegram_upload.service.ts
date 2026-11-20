/**
 * Telegram Bot API — channel posting.
 *
 * Auth model: no OAuth. The user creates a bot via @BotFather, adds it as
 * an ADMIN of their channel (with "Post Messages" permission), and gives
 * us the bot token + channel username. We verify both up front and store
 * the token on the social_accounts row (`access_token`).
 *
 * Upload flow:
 *   1. sendVideo with `video = <R2 URL>` — Telegram downloads the file
 *      itself, so no bytes flow through this server. Telegram caps
 *      URL-sent files at ~20 MB and the URL must be publicly reachable.
 *   2. If Telegram refuses the URL (too large / can't fetch / bad type),
 *      fall back to a multipart upload streamed from R2 — the Bot API
 *      allows up to 50 MB this way.
 *
 * Caption = title only (Telegram caption limit is 1024 chars).
 *
 * The bot token is embedded in every request URL — never log URLs or
 * axios configs from this module.
 */

import axios from "axios";
import FormData from "form-data";
import type { SocialAccount } from "../../db/models";
import { get_url_stream } from "./url_stream";

const TELEGRAM_API = "https://api.telegram.org";
const CAPTION_MAX = 1024;
const MULTIPART_MAX_BYTES = 50 * 1024 * 1024;

function slog(step: string, data?: Record<string, any>) {
    console.log(`[telegram-upload] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

function api_url(token: string, method: string): string {
    return `${TELEGRAM_API}/bot${token}/${method}`;
}

/**
 * Error carrying Telegram's `description` as the message, plus a
 * sanitized `response` ({ status, data }) so the upload dispatcher's
 * 401/403 → "reconnect required" heuristic keeps working. The original
 * axios error is dropped because its `config.url` contains the token.
 */
export class TelegramApiError extends Error {
    response: { status: number | undefined; data: any };
    constructor(method: string, err: any) {
        const data = err?.response?.data;
        const description: string = data?.description ?? err?.message ?? "Unknown Telegram error";
        super(`Telegram ${method}: ${description}`);
        this.name = "TelegramApiError";
        this.response = {
            status: err?.response?.status,
            data: data ? { ok: data.ok, error_code: data.error_code, description: data.description } : undefined,
        };
    }
    get description(): string {
        return this.response.data?.description ?? this.message;
    }
}

async function call<T = any>(token: string, method: string, body: Record<string, any>): Promise<T> {
    try {
        const res = await axios.post(api_url(token, method), body, { timeout: 5 * 60 * 1000 });
        return res.data?.result as T;
    } catch (err: any) {
        throw new TelegramApiError(method, err);
    }
}

/**
 * Accepts "@name", "name", "t.me/name", "https://t.me/name" or a numeric
 * chat id ("-100123…" for private channels). Returns the chat_id string
 * Telegram expects.
 */
export function normalize_channel(input: string): string {
    let v = (input ?? "").trim();
    v = v.replace(/^https?:\/\//i, "").replace(/^(www\.)?(t|telegram)\.me\//i, "");
    v = v.split(/[/?#]/)[0] ?? "";
    if (/^-?\d+$/.test(v)) return v;
    v = v.replace(/^@+/, "");
    return v ? `@${v}` : "";
}

export interface TelegramVerifyResult {
    bot: { id: number; username: string; first_name: string };
    chat: { id: number; title: string | null; username: string | null; type: string };
    bot_status: string;
}

/**
 * Verify the token is valid, the channel exists, and the bot is an admin
 * that can post there. Throws an Error with a user-facing message.
 */
export async function verify_telegram_bot(bot_token: string, channel_input: string): Promise<TelegramVerifyResult> {
    const token = bot_token.trim();
    const chat_id = normalize_channel(channel_input);
    if (!chat_id) throw new Error("Enter a valid channel username, e.g. @mychannel");

    let bot: any;
    try {
        bot = await call(token, "getMe", {});
    } catch (err: any) {
        if (err?.response?.status === 401 || err?.response?.status === 404) {
            throw new Error("Invalid bot token. Copy the token from @BotFather and try again.");
        }
        throw err;
    }

    let chat: any;
    try {
        chat = await call(token, "getChat", { chat_id });
    } catch (err: any) {
        throw new Error(
            `Channel ${chat_id} not found or the bot can't see it. Add @${bot.username} to the channel as an admin, then retry.`,
        );
    }

    let member: any;
    try {
        member = await call(token, "getChatMember", { chat_id: chat.id, user_id: bot.id });
    } catch (err: any) {
        throw new Error(`Could not read the bot's role in ${chat_id}: ${err?.description ?? err?.message}`);
    }

    const status: string = member?.status ?? "unknown";
    const is_admin = status === "administrator" || status === "creator";
    if (!is_admin) {
        throw new Error(`@${bot.username} is not an admin of ${chat_id}. Make it an admin with "Post Messages" permission.`);
    }
    if (chat.type === "channel" && status === "administrator" && member?.can_post_messages === false) {
        throw new Error(`@${bot.username} is an admin of ${chat_id} but lacks the "Post Messages" permission.`);
    }

    slog("verified", { bot_username: bot.username, chat_id: chat.id, chat_type: chat.type, status });
    return {
        bot: { id: bot.id, username: bot.username, first_name: bot.first_name },
        chat: { id: chat.id, title: chat.title ?? null, username: chat.username ?? null, type: chat.type },
        bot_status: status,
    };
}

// ── Upload ─────────────────────────────────────────────────────────────

export interface TelegramUploadOptions {
    account: SocialAccount;
    /** R2 presigned / public URL. */
    file_url: string;
    /** Post caption — the title only. */
    caption: string;
    media_kind?: "video" | "image";
    mime_type?: string | null;
    file_name?: string | null;
}

export interface TelegramUploadResult {
    message_id: number;
    chat_id: number | string;
    post_url: string | null;
    method: "url" | "multipart";
}

/** Telegram errors that mean "I couldn't use that URL" → retry as multipart. */
function is_url_rejection(err: any): boolean {
    const d = String(err?.description ?? err?.message ?? "").toLowerCase();
    return /failed to get http url content|wrong file identifier\/http url|wrong type of the web page content|wrong remote file|http url|too big|failed to get/.test(d);
}

function build_post_url(account: SocialAccount, message_id: number): string | null {
    const username = (account.metadata as any)?.chat_username ?? null;
    if (username) return `https://t.me/${username}/${message_id}`;
    // Private channel: t.me/c/<id without -100>/<msg>
    const id = String(account.account_id ?? "");
    if (id.startsWith("-100")) return `https://t.me/c/${id.slice(4)}/${message_id}`;
    return null;
}

export async function upload_video_to_telegram(opts: TelegramUploadOptions): Promise<TelegramUploadResult> {
    const token = opts.account.access_token;
    const chat_id = opts.account.account_id;
    if (!token) throw new Error("Telegram account has no bot token. Reconnect Telegram.");
    if (!chat_id) throw new Error("Telegram account has no channel id. Reconnect Telegram.");

    const is_image = opts.media_kind === "image";
    const method = is_image ? "sendPhoto" : "sendVideo";
    const field = is_image ? "photo" : "video";
    const caption = (opts.caption ?? "").trim().slice(0, CAPTION_MAX);

    slog("upload_start", { account_id: opts.account.id, chat_id, method, caption_len: caption.length });

    // ── Attempt 1: hand Telegram the R2 URL directly ───────────────────
    try {
        const msg: any = await call(token, method, {
            chat_id,
            [field]: opts.file_url,
            ...(caption ? { caption } : {}),
            ...(is_image ? {} : { supports_streaming: true }),
        });
        slog("upload_done", { via: "url", message_id: msg?.message_id });
        return {
            message_id: msg.message_id,
            chat_id: msg?.chat?.id ?? chat_id,
            post_url: build_post_url(opts.account, msg.message_id),
            method: "url",
        };
    } catch (err: any) {
        if (!is_url_rejection(err)) throw err;
        slog("url_rejected_fallback_multipart", { description: err?.description });
    }

    // ── Attempt 2: stream bytes from R2 as multipart/form-data ─────────
    const src = await get_url_stream(opts.file_url);
    if (src.file_size != null && src.file_size > MULTIPART_MAX_BYTES) {
        (src.stream as any).destroy?.();
        const mb = (src.file_size / (1024 * 1024)).toFixed(1);
        throw new Error(`File is ${mb} MB — Telegram bots can upload at most 50 MB.`);
    }

    const ext = is_image ? "jpg" : "mp4";
    const filename = opts.file_name || `upload.${ext}`;
    const content_type = opts.mime_type || src.content_type || (is_image ? "image/jpeg" : "video/mp4");

    const form = new FormData();
    form.append("chat_id", String(chat_id));
    if (caption) form.append("caption", caption);
    if (!is_image) form.append("supports_streaming", "true");
    form.append(field, src.stream as any, {
        filename,
        contentType: content_type,
        ...(src.file_size != null ? { knownLength: src.file_size } : {}),
    });

    try {
        const res = await axios.post(api_url(token, method), form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 15 * 60 * 1000,
        });
        const msg = res.data?.result;
        slog("upload_done", { via: "multipart", message_id: msg?.message_id });
        return {
            message_id: msg.message_id,
            chat_id: msg?.chat?.id ?? chat_id,
            post_url: build_post_url(opts.account, msg.message_id),
            method: "multipart",
        };
    } catch (err: any) {
        if (err?.response?.status === 413) {
            throw new Error("File too large for Telegram (bots can upload at most 50 MB).");
        }
        throw new TelegramApiError(method, err);
    }
}
