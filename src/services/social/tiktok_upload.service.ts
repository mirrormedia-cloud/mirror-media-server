/**
 * TikTok Content Posting API v2 — FILE_UPLOAD mode.
 *
 * PULL_FROM_URL requires TikTok to verify domain ownership of the CDN URL,
 * which is not possible with Cloudflare R2's domain. FILE_UPLOAD streams the
 * bytes from R2 through this server to TikTok's upload endpoint instead,
 * removing the domain-verification requirement entirely.
 *
 * Flow:
 *   1. HEAD  file_url                          → get Content-Length
 *   2. POST  /v2/post/publish/video/init/      → publish_id + upload_url + chunk_size
 *   3. PUT   upload_url (chunked or single)    → upload bytes streamed from R2
 *   4. Poll  /v2/post/publish/status/fetch/   → wait for PUBLISH_COMPLETE
 *
 * Env vars required:
 *   TIKTOK_CLIENT_KEY     — from TikTok Developer Portal
 *   TIKTOK_CLIENT_SECRET  — from TikTok Developer Portal
 */

import axios from "axios";
import type { SocialAccount } from "../../db/models";

const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS  = 15 * 60 * 1_000;   // 15 min — large files take time

function slog(step: string, data?: Record<string, any>) {
    console.log(`[tiktok-upload] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

function log_axios_error(step: string, err: any) {
    console.error(`[tiktok-upload] ERROR at ${step}`, JSON.stringify({
        message:     err?.message,
        http_status: err?.response?.status,
        headers:     err?.response?.headers,
        data:        err?.response?.data,
        request_url: err?.config?.url,
        request_method: err?.config?.method,
        request_headers: err?.config?.headers,
    }, null, 2));
}

export interface TikTokUploadOptions {
    account: SocialAccount;
    /** R2 presigned / public URL to stream the video from. */
    file_url: string;
    /** Caption / title (max 2200 chars). */
    caption: string;
    privacy_level?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";
    disable_comment?: boolean;
    disable_duet?: boolean;
    disable_stitch?: boolean;
    publish_at?: string | null;
    /**
     * When true, uses /v2/post/publish/inbox/video/init/ (video.upload scope).
     * Required for unaudited/sandbox apps. Video lands in user's TikTok inbox
     * as a draft — user must complete posting inside the TikTok app.
     *
     * When false (default), uses /v2/post/publish/video/init/ (video.publish scope).
     * Posts directly to feed. Requires TikTok audit approval of the app.
     *
     * Set TIKTOK_INBOX_MODE=true in .env for sandbox/development.
     */
    inbox_mode?: boolean;
}

export interface TikTokUploadResult {
    publish_id: string;
    share_url: string | null;
    confirmed: boolean;
}

// ── Step 1: download file from R2 ─────────────────────────────────────
// Presigned R2 URLs are signed for GET only — a HEAD request returns 403.
// We download the full file first, then use buffer.length for the TikTok
// FILE_UPLOAD init (which requires the exact byte count up front).

async function download_from_r2(url: string): Promise<Buffer> {
    slog("downloading_from_r2", { url: url.split("?")[0] });   // log path only, not the signed params
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 10 * 60 * 1_000,
        });
        const buf = Buffer.from(res.data as ArrayBuffer);
        slog("download_complete", { size_bytes: buf.length });
        return buf;
    } catch (err: any) {
        log_axios_error("download_from_r2", err);
        throw err;
    }
}

// ── Step 1b: creator info pre-check ───────────────────────────────────
// TikTok requires this call before init to verify the account can publish
// and to retrieve available privacy levels.

async function query_creator_info(access_token: string): Promise<{
    creator_available: boolean;
    privacy_level_options: string[];
}> {
    slog("query_creator_info");
    let res: any;
    try {
        res = await axios.post(
            `${TIKTOK_API_BASE}/post/publish/creator_info/query/`,
            {},
            {
                headers: {
                    Authorization: `Bearer ${access_token}`,
                    "Content-Type": "application/json; charset=UTF-8",
                },
            },
        );
        slog("creator_info_response", { status: res.status, data: res.data });
    } catch (err: any) {
        log_axios_error("query_creator_info", err);
        throw err;
    }

    const data = res.data?.data ?? {};
    return {
        creator_available: data.creator_available ?? false,
        privacy_level_options: data.privacy_level_options ?? [],
    };
}

// ── Step 2: init upload ────────────────────────────────────────────────

interface InitResult {
    publish_id: string;
    upload_url: string;
    chunk_size: number;
    total_chunk_count: number;
}

async function init_file_upload(
    access_token: string,
    opts: {
        file_size: number;
        caption: string;
        privacy_level: string;
        disable_comment: boolean;
        disable_duet: boolean;
        disable_stitch: boolean;
        inbox_mode: boolean;
    },
): Promise<InitResult> {
    // TikTok chunk rules:
    //   • Files ≤ 64 MB  → single chunk (chunk_size = file_size, count = 1)
    //   • Files > 64 MB  → 10 MB chunks (within the 5–64 MB per-chunk range)
    const MULTI_CHUNK_SIZE = 10 * 1024 * 1024;  // 10 MB
    const MAX_SINGLE_CHUNK = 64 * 1024 * 1024;  // 64 MB
    const chunk_size        = opts.file_size <= MAX_SINGLE_CHUNK ? opts.file_size : MULTI_CHUNK_SIZE;
    const total_chunk_count = Math.ceil(opts.file_size / chunk_size);

    const body = {
        post_info: {
            title: opts.caption.slice(0, 2200),
            privacy_level: opts.privacy_level,
            disable_comment: opts.disable_comment,
            disable_duet: opts.disable_duet,
            disable_stitch: opts.disable_stitch,
        },
        source_info: {
            source: "FILE_UPLOAD",
            video_size: opts.file_size,
            chunk_size,
            total_chunk_count,
        },
    };

    slog("init_request", { file_size: opts.file_size, chunk_size, total_chunk_count });

    let res: any;
    try {
        const init_endpoint = opts.inbox_mode
            ? `${TIKTOK_API_BASE}/post/publish/inbox/video/init/`
            : `${TIKTOK_API_BASE}/post/publish/video/init/`;
        slog("init_endpoint", { inbox_mode: opts.inbox_mode, url: init_endpoint });
        res = await axios.post(
            init_endpoint,
            body,
            {
                headers: {
                    Authorization: `Bearer ${access_token}`,
                    "Content-Type": "application/json; charset=UTF-8",
                },
            },
        );
        slog("init_response", { status: res.status, data: res.data });
    } catch (err: any) {
        log_axios_error("init_file_upload", err);
        throw err;
    }

    const data = res.data?.data;
    if (!data?.publish_id || !data?.upload_url) {
        const errBody = res.data?.error ?? res.data;
        slog("init_missing_fields", { response: res.data });
        throw new Error(`TikTok init failed: ${JSON.stringify(errBody)}`);
    }

    return {
        publish_id: data.publish_id,
        upload_url: data.upload_url,
        chunk_size: body.source_info.chunk_size,
        total_chunk_count: body.source_info.total_chunk_count,
    };
}

// ── Step 3: stream upload ──────────────────────────────────────────────

/**
 * Download the video from R2 and upload it to TikTok's upload_url in
 * chunks. Each chunk is a plain PUT with a Content-Range header.
 *
 * For single-chunk videos (< 10 MB) this is one PUT. For larger videos
 * each 10 MB slice is sent sequentially.
 */
async function stream_upload_to_tiktok(opts: {
    buffer: Buffer;
    upload_url: string;
    chunk_size: number;
    total_chunk_count: number;
}): Promise<void> {
    const buffer = opts.buffer;
    const total = buffer.length;

    for (let i = 0; i < opts.total_chunk_count; i++) {
        const start = i * opts.chunk_size;
        const end   = Math.min(start + opts.chunk_size - 1, total - 1);
        const chunk = buffer.subarray(start, end + 1);

        slog("uploading_chunk", { chunk: i + 1, of: opts.total_chunk_count, start, end, size: chunk.length });

        try {
            const put_res = await axios.put(opts.upload_url, chunk, {
                headers: {
                    "Content-Type": "video/mp4",
                    "Content-Range": `bytes ${start}-${end}/${total}`,
                    "Content-Length": String(chunk.length),
                },
                timeout: 10 * 60 * 1_000,
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            });
            slog("chunk_uploaded", { chunk: i + 1, of: opts.total_chunk_count, status: put_res.status, data: put_res.data });
        } catch (err: any) {
            log_axios_error(`stream_upload chunk ${i + 1}/${opts.total_chunk_count}`, err);
            throw err;
        }
    }
}

// ── Step 4: poll status ────────────────────────────────────────────────

async function poll_publish_status(
    access_token: string,
    publish_id: string,
): Promise<{ status: string; share_url: string | null }> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        let res: any;
        try {
            res = await axios.post(
                `${TIKTOK_API_BASE}/post/publish/status/fetch/`,
                { publish_id },
                {
                    headers: {
                        Authorization: `Bearer ${access_token}`,
                        "Content-Type": "application/json; charset=UTF-8",
                    },
                },
            );
        } catch (err: any) {
            log_axios_error("poll_publish_status", err);
            throw err;
        }

        const data = res.data?.data ?? {};
        const status: string = data.status ?? "PROCESSING_UPLOAD";
        slog("poll_status", { publish_id, status, raw: res.data });

        if (status === "PUBLISH_COMPLETE") {
            return { status, share_url: data.publicaly_available_post_id?.[0] ?? null };
        }
        // Inbox mode terminal state — video delivered to user's TikTok inbox as a draft
        if (status === "SEND_TO_USER_INBOX") {
            return { status, share_url: null };
        }
        if (status === "FAILED") {
            const reason = data.fail_reason ?? "unknown";
            throw new Error(`TikTok publish failed: ${reason}`);
        }
    }

    throw new Error(`TikTok publish timed out after ${POLL_TIMEOUT_MS / 60_000} minutes`);
}

// ── Main entry point ───────────────────────────────────────────────────

export async function upload_video_to_tiktok(opts: TikTokUploadOptions): Promise<TikTokUploadResult> {
    const token = opts.account.access_token;
    if (!token) throw new Error("TikTok account has no access token. Reconnect the account.");

    const privacy_level = opts.privacy_level ?? "SELF_ONLY";

    slog("upload_start", { account_id: opts.account.id, privacy_level, caption_len: opts.caption.length });

    // Step 1a — creator info pre-check (non-fatal; unaudited apps may return false).
    const creator = await query_creator_info(token);
    slog("creator_info", { creator_available: creator.creator_available, privacy_options: creator.privacy_level_options });
    if (!creator.creator_available) {
        slog("creator_unavailable_warning", { note: "creator_available=false; proceeding anyway — TikTok will reject if truly ineligible" });
    }

    // Step 1b — download file (GET only; R2 presigned URLs reject HEAD).
    const buffer = await download_from_r2(opts.file_url);
    const file_size = buffer.length;
    slog("file_size_resolved", { file_size });

    const inbox_mode = opts.inbox_mode ?? (process.env.TIKTOK_INBOX_MODE === "true");

    // Step 2 — init and get upload_url.
    const init = await init_file_upload(token, {
        file_size,
        caption: opts.caption,
        privacy_level,
        disable_comment: opts.disable_comment ?? false,
        disable_duet: opts.disable_duet ?? false,
        disable_stitch: opts.disable_stitch ?? false,
        inbox_mode,
    });
    slog("init_done", { publish_id: init.publish_id, chunks: init.total_chunk_count });

    // Step 3 — upload buffer to TikTok.
    await stream_upload_to_tiktok({
        buffer,
        upload_url: init.upload_url,
        chunk_size: init.chunk_size,
        total_chunk_count: init.total_chunk_count,
    });
    slog("stream_upload_done", { publish_id: init.publish_id });

    // Step 4 — poll until published (non-fatal on timeout).
    let share_url: string | null = null;
    let confirmed = false;
    try {
        const result = await poll_publish_status(token, init.publish_id);
        share_url = result.share_url;
        confirmed = result.status === "PUBLISH_COMPLETE" || result.status === "SEND_TO_USER_INBOX";
        slog("publish_complete", { publish_id: init.publish_id, share_url, confirmed });
    } catch (poll_err: any) {
        slog("poll_failed_non_fatal", { publish_id: init.publish_id, error: poll_err?.message });
    }

    return { publish_id: init.publish_id, share_url, confirmed };
}
