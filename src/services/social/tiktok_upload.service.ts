/**
 * TikTok Content Posting API v2.
 *
 * Uses the "PULL_FROM_URL" source type — TikTok fetches the video directly
 * from the public R2 CDN URL, which means no byte-streaming from this
 * server and no temp files.
 *
 * Flow:
 *   1. POST /v2/post/publish/video/init/   → publish_id
 *   2. Poll  /v2/post/publish/status/fetch/ until status is PUBLISH_COMPLETE
 *
 * Scheduling: TikTok does not yet expose a native scheduled-publish API in
 * the Content Posting flow, so scheduled uploads are published immediately
 * (same as Instagram's deferred-container workaround).
 *
 * Env vars required:
 *   TIKTOK_CLIENT_KEY     — from TikTok Developer Portal
 *   TIKTOK_CLIENT_SECRET  — from TikTok Developer Portal
 */

import axios from "axios";
import type { SocialAccount } from "../../db/models";

const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";

// How long to wait between status-poll attempts.
const POLL_INTERVAL_MS = 5_000;
// Give up after 10 minutes of polling.
const POLL_TIMEOUT_MS  = 10 * 60 * 1_000;

function slog(step: string, data?: Record<string, any>) {
    console.log(`[tiktok-upload] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

export interface TikTokUploadOptions {
    account: SocialAccount;
    /** Public CDN URL TikTok will pull the video from. */
    file_url: string;
    /** Video title / caption (max 2200 chars on TikTok). */
    caption: string;
    /** Privacy level — defaults to SELF_ONLY for safety. */
    privacy_level?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";
    /** Whether to disable comments. */
    disable_comment?: boolean;
    /** Whether to disable duet. */
    disable_duet?: boolean;
    /** Whether to disable stitch. */
    disable_stitch?: boolean;
    /** Scheduled publish time (ISO 8601). Currently ignored — TikTok publishes immediately. */
    publish_at?: string | null;
}

export interface TikTokUploadResult {
    publish_id: string;
    /** Final TikTok share_url or null when the API didn't return one. */
    share_url: string | null;
    /** True when publish was confirmed PUBLISH_COMPLETE. */
    confirmed: boolean;
}

/**
 * Initialise a direct-post video upload. TikTok pulls the video from
 * `file_url` and creates the post on behalf of the connected creator.
 */
async function init_video_post(
    access_token: string,
    opts: {
        file_url: string;
        caption: string;
        privacy_level: string;
        disable_comment: boolean;
        disable_duet: boolean;
        disable_stitch: boolean;
    },
): Promise<string> {
    const body = {
        post_info: {
            title: opts.caption.slice(0, 2200),
            privacy_level: opts.privacy_level,
            disable_comment: opts.disable_comment,
            disable_duet: opts.disable_duet,
            disable_stitch: opts.disable_stitch,
        },
        source_info: {
            source: "PULL_FROM_URL",
            video_url: opts.file_url,
        },
    };

    const res = await axios.post(
        `${TIKTOK_API_BASE}/post/publish/video/init/`,
        body,
        {
            headers: {
                Authorization: `Bearer ${access_token}`,
                "Content-Type": "application/json; charset=UTF-8",
            },
        },
    );

    const publish_id = res.data?.data?.publish_id as string | undefined;
    if (!publish_id) {
        const msg = res.data?.error?.message ?? JSON.stringify(res.data);
        throw new Error(`TikTok init failed: ${msg}`);
    }
    return publish_id;
}

/**
 * Poll the publish status until PUBLISH_COMPLETE, FAILED, or timeout.
 * Returns the final share_url when available.
 */
async function poll_publish_status(
    access_token: string,
    publish_id: string,
): Promise<{ status: string; share_url: string | null }> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        const res = await axios.post(
            `${TIKTOK_API_BASE}/post/publish/status/fetch/`,
            { publish_id },
            {
                headers: {
                    Authorization: `Bearer ${access_token}`,
                    "Content-Type": "application/json; charset=UTF-8",
                },
            },
        );

        const data = res.data?.data ?? {};
        const status: string = data.status ?? "PROCESSING_UPLOAD";
        slog("poll_status", { publish_id, status });

        if (status === "PUBLISH_COMPLETE") {
            return { status, share_url: data.publicaly_available_post_id?.[0] ?? null };
        }
        if (status === "FAILED") {
            const reason = data.fail_reason ?? "unknown";
            throw new Error(`TikTok publish failed: ${reason}`);
        }
        // PROCESSING_UPLOAD / PROCESSING_DOWNLOAD / SENDING_TO_USER_INBOX → keep polling
    }

    throw new Error(`TikTok publish timed out after ${POLL_TIMEOUT_MS / 60_000} minutes`);
}

/**
 * Main entry point — called from social_upload.service.ts.
 */
export async function upload_video_to_tiktok(opts: TikTokUploadOptions): Promise<TikTokUploadResult> {
    const token = opts.account.access_token;
    if (!token) throw new Error("TikTok account has no access token. Reconnect the account.");

    const privacy_level = opts.privacy_level ?? "SELF_ONLY";

    slog("upload_start", {
        account_id: opts.account.id,
        privacy_level,
        caption_len: opts.caption.length,
    });

    const publish_id = await init_video_post(token, {
        file_url: opts.file_url,
        caption: opts.caption,
        privacy_level,
        disable_comment: opts.disable_comment ?? false,
        disable_duet: opts.disable_duet ?? false,
        disable_stitch: opts.disable_stitch ?? false,
    });

    slog("init_done", { publish_id });

    let share_url: string | null = null;
    let confirmed = false;

    try {
        const result = await poll_publish_status(token, publish_id);
        share_url = result.share_url;
        confirmed = result.status === "PUBLISH_COMPLETE";
        slog("publish_complete", { publish_id, share_url, confirmed });
    } catch (poll_err: any) {
        // A polling timeout is non-fatal — the init succeeded and TikTok
        // may still complete the publish asynchronously. We surface this
        // as a "partial success" so the UI shows the publish_id.
        slog("poll_failed_non_fatal", { publish_id, error: poll_err?.message });
    }

    return { publish_id, share_url, confirmed };
}
