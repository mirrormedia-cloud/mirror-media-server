/**
 * Facebook Page video upload — port of yt-backend/src/app/services/upload.facebook.ts
 *
 * The Page Graph API accepts a multipart `source` field containing the
 * raw bytes of the video. Post-R2, we HTTPS-GET the library row's
 * `file_url` from the R2 CDN and pipe the response stream into the
 * form-data — no temp file, no Drive hop.
 *
 * Scheduling: Pages support `published=false` + `scheduled_publish_time`
 * (Unix seconds, must be 10 min – 6 months in the future). When the
 * caller provides `publish_at` we honour those constraints; otherwise
 * the post goes live immediately.
 */

import axios from "axios";
import FormData from "form-data";
import { SocialAccount } from "../../db/models";
import { get_url_stream } from "./url_stream";

const GRAPH_VERSION = "v18.0";
const GRAPH_URL = process.env.GRAPH_URL || `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface FacebookUploadInput {
    account: SocialAccount;
    /** Public R2 CDN URL of the library row. Streamed directly into the
     *  multipart body; no temp file. */
    file_url: string;
    /** Page-side title (optional, surfaced as the video title). */
    title?: string;
    /** Caption — combines description + tags + hashtags from the modal. */
    description: string;
    /** ISO 8601 — when set + at least 10 minutes ahead, FB schedules the publish. */
    publish_at?: string | null;
}

export interface FacebookUploadResult {
    file_id: string;
    /** Facebook video id (and the post id, which is the same value for video uploads). */
    video_id: string;
    scheduled: boolean;
    publish_at: string | null;
    raw: any;
}

function dlog(step: string, data?: Record<string, any>) {
    const safe = data ? Object.fromEntries(
        Object.entries(data).map(([k, v]) =>
            /access_token|secret|password|cookie|authorization/i.test(k)
                ? [k, typeof v === "string" ? `<redacted:${v.length}>` : "<redacted>"]
                : [k, v],
        ),
    ) : undefined;
    console.log(`[fb-upload] ${step}${safe ? " " + JSON.stringify(safe) : ""}`);
}

export async function upload_video_to_facebook(input: FacebookUploadInput): Promise<FacebookUploadResult> {
    const { account } = input;
    if (account.platform !== "facebook") {
        throw new Error(`SocialAccount ${account.id} is not a Facebook account (platform=${account.platform})`);
    }
    if (!account.page_id || !account.access_token) {
        throw new Error(`Facebook account ${account.id} is missing page_id or page access_token — reconnect required`);
    }

    // Validate / clamp the schedule time. FB requires:
    //   now + 10 minutes <= scheduled_publish_time <= now + 6 months
    let scheduled_publish_time: number | null = null;
    let scheduled = false;
    if (input.publish_at) {
        const target = new Date(input.publish_at).getTime();
        const now = Date.now();
        const min_ahead_ms = 10 * 60 * 1000;
        const max_ahead_ms = 6 * 30 * 24 * 60 * 60 * 1000;
        if (Number.isFinite(target) && target - now >= min_ahead_ms && target - now <= max_ahead_ms) {
            scheduled_publish_time = Math.floor(target / 1000);
            scheduled = true;
        } else {
            dlog("schedule_window_invalid", {
                requested: input.publish_at,
                must_be_between: "10 minutes and 6 months from now",
            });
            // Fall through and publish immediately rather than failing —
            // the social_upload row's status will reflect "uploaded" not
            // "scheduled" so the UI is honest.
        }
    }

    dlog("upload_started", {
        account_id: account.id,
        page_id: account.page_id,
        has_caption: !!input.description,
        scheduled,
        scheduled_publish_time,
    });

    if (!input.file_url) {
        throw new Error("Facebook upload requires file_url — library row has no R2 URL");
    }
    const { stream, content_type, file_size } = await get_url_stream(input.file_url);
    dlog("url_stream_open", { file_url: input.file_url, content_type, file_size });

    // Pick a filename WITH an extension that matches the actual MIME type.
    // FB's ingestion sniffs the filename suffix (not just Content-Type) — a
    // title like "Episode - 1" with no `.mp4` triggers code 352
    // "Unsupported Video Format" even when the bytes are a valid MP4.
    const ext_for_mime: Record<string, string> = {
        "video/mp4": "mp4",
        "video/quicktime": "mov",
        "video/x-matroska": "mkv",
        "video/webm": "webm",
        "video/x-msvideo": "avi",
    };
    const ext = ext_for_mime[(content_type || "").toLowerCase()] ?? "mp4";
    const safe_base = (input.title || "upload")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "upload";
    const filename = /\.[a-z0-9]{2,5}$/i.test(safe_base) ? safe_base : `${safe_base}.${ext}`;

    const form = new FormData();
    // Pass knownLength when Drive reported a size — FB's video endpoint is
    // happier with a real Content-Length than with chunked-encoded bodies.
    const append_opts: any = {
        filename,
        contentType: content_type || "video/mp4",
    };
    if (file_size != null && file_size > 0) append_opts.knownLength = file_size;
    form.append("source", stream as any, append_opts);
    if (input.title) form.append("title", input.title.slice(0, 255));
    form.append("description", input.description ?? "");
    form.append("access_token", account.access_token);
    if (scheduled && scheduled_publish_time != null) {
        form.append("published", "false");
        form.append("scheduled_publish_time", String(scheduled_publish_time));
    }

    let res;
    try {
        // form.getLengthSync() returns the multipart body's total length when
        // every part has a known length — only true here when Drive gave us
        // a file_size. Setting Content-Length avoids chunked transfer, which
        // FB's video ingestion sometimes rejects with a generic format error.
        let content_length: number | null = null;
        try { content_length = form.getLengthSync(); } catch { content_length = null; }
        const headers: Record<string, any> = { ...form.getHeaders() };
        if (content_length && content_length > 0) headers["Content-Length"] = content_length;
        res = await axios.post(`${GRAPH_URL}/${account.page_id}/videos`, form, {
            headers,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
        });
    } catch (err: any) {
        dlog("upload_failed", {
            account_id: account.id,
            page_id: account.page_id,
            error: err?.message ?? String(err),
            details: err?.response?.data ?? null,
        });
        throw err;
    }

    const video_id = res.data?.id;
    if (!video_id) {
        dlog("upload_no_video_id", { raw: res.data });
        throw new Error("Facebook upload returned no video id");
    }
    dlog("upload_success", { account_id: account.id, video_id, scheduled });

    return {
        file_id: input.file_url,
        video_id,
        scheduled,
        publish_at: scheduled ? new Date(scheduled_publish_time! * 1000).toISOString() : null,
        raw: res.data,
    };
}
