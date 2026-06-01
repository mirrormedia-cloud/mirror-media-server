/**
 * Instagram Reels publish — port of yt-backend/src/app/services/upload.instagram.ts
 *
 * The Graph API expects a public HTTPS URL it can fetch the bytes from
 * (no multipart upload path for IG video). Post-R2 we pass the
 * library row's `file_url` directly — it's already a public CDN URL
 * served by R2_PUBLIC_BASE_URL.
 *
 * Flow (matches yt-backend exactly):
 *   1. POST /<ig-business-id>/media          — create container
 *   2. Poll GET /<container-id>?fields=status_code until FINISHED
 *   3. POST /<ig-business-id>/media_publish  — publish the container
 *
 * Scheduling: Instagram's API does **not** support direct future
 * scheduling for Reels. When the caller supplies `publish_at` we save
 * the row as `scheduled` without publishing — a Scenario-2 cron would
 * pick it up at the right time and run this same flow.
 */

import axios from "axios";
import { SocialAccount } from "../../db/models";

const GRAPH_VERSION = "v18.0";
const GRAPH_URL = process.env.GRAPH_URL || `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface InstagramUploadInput {
    account: SocialAccount;
    /** Public HTTPS URL Meta can fetch directly — the R2 CDN URL stored
     *  on the library row. Must be reachable without auth. */
    file_url: string;
    /** Determines which IG container shape we POST:
     *    'video' → media_type=REELS + video_url (default, back-compat)
     *    'image' → image_url only (no media_type for single-image posts)
     *  Mis-classifying triggers Graph API error 2207026
     *  ("video format is not supported") for images sent as REELS, or
     *  generic INVALID_PARAMETER for videos sent as IMAGE. */
    media_kind?: 'image' | 'video';
    /** Caption — IG combines caption + hashtags into one block. */
    caption: string;
    /** When set, we DON'T publish — caller marks the row as scheduled. */
    publish_at?: string | null;
}

export interface InstagramUploadResult {
    file_id: string;
    /** Container creation id (returned even when scheduled). */
    creation_id: string;
    /** Published media id from /media_publish (only when actually published). */
    media_id: string | null;
    scheduled: boolean;
    raw: any;
}

/**
 * Publish an IG container that was created earlier with `publish_at` set
 * (so we returned `scheduled` instead of running /media_publish). The
 * Scenario-2 cron calls this when the scheduled time hits.
 */
export async function publish_existing_instagram_container(
    account: SocialAccount,
    creation_id: string,
): Promise<{ media_id: string | null; raw: any }> {
    if (!account.account_id || !account.access_token) {
        throw new Error(`Instagram account ${account.id} is missing IG business id or page token`);
    }
    const { data } = await axios.post(`${GRAPH_URL}/${account.account_id}/media_publish`, {
        access_token: account.access_token,
        creation_id,
    });
    return { media_id: data?.id ?? null, raw: data };
}

function dlog(step: string, data?: Record<string, any>) {
    const safe = data ? Object.fromEntries(
        Object.entries(data).map(([k, v]) =>
            /access_token|secret|password|cookie|authorization/i.test(k)
                ? [k, typeof v === "string" ? `<redacted:${v.length}>` : "<redacted>"]
                : [k, v],
        ),
    ) : undefined;
    console.log(`[ig-upload] ${step}${safe ? " " + JSON.stringify(safe) : ""}`);
}

async function wait_for_container_status(
    creation_id: string,
    access_token: string,
    delay_ms = 5000,
): Promise<{ ok: boolean; status_code: string | null; status_message: string | null; raw: any }> {
    // Polls while IG reports IN_PROGRESS. Caps at 60 min total — long
    // enough for big-video ingestion (a 300 MB clip easily takes 5–10
    // min) but bounded so a permanently-stuck container can't hang the
    // worker forever. Also bails on too many consecutive request
    // failures (revoked token / dead network).
    const MAX_DURATION_MS = 60 * 60 * 1000;   // 60 min ceiling
    const MAX_CONSECUTIVE_ERRORS = 12;        // ~1 min of failed GETs at 5 s
    const started_at = Date.now();
    let consecutive_errors = 0;
    for (let attempt = 1; ; attempt += 1) {
        const elapsed_ms = Date.now() - started_at;
        if (elapsed_ms > MAX_DURATION_MS) {
            dlog("status_poll_timeout", { creation_id, attempts: attempt - 1, elapsed_ms });
            return { ok: false, status_code: "TIMEOUT", status_message: null, raw: null };
        }
        try {
            // `status` returns Instagram's human-readable explanation
            // (e.g. "Error: 2207026 The video format is not supported")
            // alongside the machine-readable `status_code`. We surface
            // it to the caller so the toast / log isn't just "ERROR".
            const res = await axios.get(`${GRAPH_URL}/${creation_id}`, {
                params: { fields: "status_code,status", access_token },
            });
            consecutive_errors = 0;
            const status_code = res.data?.status_code as string | undefined;
            const status_message = (res.data?.status ?? null) as string | null;
            dlog("status_poll", { creation_id, attempt, status_code, status_message });
            if (status_code === "FINISHED" || status_code === "PUBLISHED") {
                return { ok: true, status_code: status_code ?? null, status_message, raw: res.data };
            }
            if (status_code && status_code !== "IN_PROGRESS") {
                return { ok: false, status_code, status_message, raw: res.data };
            }
        } catch (err: any) {
            consecutive_errors += 1;
            const status = err?.response?.status;
            const body = err?.response?.data;
            dlog("status_poll_error", {
                creation_id,
                attempt,
                consecutive_errors,
                status,
                message: err?.message,
                body,
            });
            if (consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
                return {
                    ok: false,
                    status_code: "POLL_ERROR",
                    status_message: body?.error?.message ?? err?.message ?? null,
                    raw: body ?? { message: err?.message },
                };
            }
        }
        await new Promise(r => setTimeout(r, delay_ms));
    }
}

export async function upload_video_to_instagram(input: InstagramUploadInput): Promise<InstagramUploadResult> {
    const { account } = input;
    if (account.platform !== "instagram") {
        throw new Error(`SocialAccount ${account.id} is not an Instagram account (platform=${account.platform})`);
    }
    if (!account.account_id || !account.access_token) {
        throw new Error(`Instagram account ${account.id} is missing IG business id or page token — reconnect required`);
    }

    // The R2 CDN URL stored on the library row IS the public URL Meta
    // fetches from — no synthesis needed.
    const file_url = input.file_url;
    if (!file_url) {
        throw new Error("Instagram upload requires file_url — library row has no R2 URL");
    }
    const media_kind = input.media_kind ?? "video";
    dlog("upload_started", {
        account_id: account.id,
        ig_business_id: account.account_id,
        media_kind,
        file_url,
        publish_at: input.publish_at ?? null,
    });

    // Step 1 — create container. The body shape differs per media kind:
    //   image → just `image_url` (no media_type for single-image posts;
    //           Meta infers IMAGE from the field name)
    //   video → `media_type: REELS` + `video_url`
    const container_body: Record<string, any> = {
        access_token: account.access_token,
        caption: input.caption ?? "",
    };
    if (media_kind === "image") {
        container_body.image_url = file_url;
    } else {
        container_body.media_type = "REELS";
        container_body.video_url = file_url;
    }
    let container;
    try {
        const { data } = await axios.post(`${GRAPH_URL}/${account.account_id}/media`, container_body);
        container = data;
    } catch (err: any) {
        dlog("container_failed", {
            account_id: account.id,
            media_kind,
            error: err?.message ?? String(err),
            details: err?.response?.data ?? null,
        });
        throw err;
    }
    const creation_id = container?.id;
    if (!creation_id) {
        dlog("container_no_id", { raw: container });
        throw new Error("Instagram container creation returned no id");
    }
    dlog("container_created", { creation_id });

    // If the caller asked us to schedule, persist the container id and
    // bail before publishing — a future cron will run /media_publish at
    // `publish_at`. IG's API itself doesn't accept a publish-later flag.
    if (input.publish_at) {
        return {
            file_id: file_url,
            creation_id,
            media_id: null,
            scheduled: true,
            raw: { container, note: "Container created; publish deferred to scheduled cron." },
        };
    }

    // Step 2 — wait for container to finish processing.
    const status = await wait_for_container_status(creation_id, account.access_token);
    if (!status.ok) {
        dlog("container_not_ready", {
            creation_id,
            status_code: status.status_code,
            status_message: status.status_message,
        });
        // Surface Instagram's verbose `status` field when available
        // so the toast / DB error_message tells the user WHY
        // (codec/aspect/duration/URL unreachable/etc.) instead of a
        // bare "status=ERROR".
        const detail = status.status_message
            ? `: ${status.status_message}`
            : "";
        const hints = media_kind === "image"
            ? "Common image causes: unsupported format (use JPEG or PNG, sRGB), aspect ratio outside 4:5–1.91:1 for feed, file > 8 MB, or the R2 URL is not publicly reachable."
            : "Common video causes: unsupported codec/format (use H.264 MP4), aspect ratio outside 4:5–16:9 for Reels, duration > 90s, file > 1 GB, or the R2 URL is not publicly reachable.";
        throw new Error(
            `Instagram container did not become publishable (status=${status.status_code}${detail}). ${hints} Open the file_url in an incognito tab to verify.`,
        );
    }

    // Step 3 — publish.
    let publish;
    try {
        const { data } = await axios.post(`${GRAPH_URL}/${account.account_id}/media_publish`, {
            access_token: account.access_token,
            creation_id,
        });
        publish = data;
    } catch (err: any) {
        dlog("publish_failed", {
            account_id: account.id,
            creation_id,
            error: err?.message ?? String(err),
            details: err?.response?.data ?? null,
        });
        throw err;
    }
    const media_id = publish?.id ?? null;
    dlog("publish_success", { account_id: account.id, creation_id, media_id });

    return {
        file_id: file_url,
        creation_id,
        media_id,
        scheduled: false,
        raw: { container, status: status.raw, publish },
    };
}
