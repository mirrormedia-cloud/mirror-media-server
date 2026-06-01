/**
 * YouTube uploader — port of yt-backend/src/app/services/upload.youtube.ts
 * trimmed to match the OTT backend's flow:
 *
 *   - Source bytes come from R2 via HTTPS GET (the library row's
 *     `file_url`). googleapis accepts a Node.js Readable directly so we
 *     pipe the response stream into `media.body` — no temp file.
 *   - When the stored token is past expiry, the OAuth client auto-refreshes
 *     and our `tokens` event listener writes the new access_token + expiry
 *     back to the SocialAccount row.
 *   - `publish_at` (RFC3339) is honoured when present — YouTube schedules
 *     the publish step for that time and the video stays unlisted/private
 *     until then.
 */

import fs from "fs";
import { google } from "googleapis";
import { SocialAccount } from "../../db/models";
import { get_url_stream } from "./url_stream";

export interface YouTubeUploadInput {
    /** SocialAccount row holding the credentials. */
    account: SocialAccount;
    /** Public R2 CDN URL to stream bytes from. Mutually exclusive with
     *  `local_file_path`. */
    file_url?: string;
    /** Local file path to read from. Used by the image-to-video
     *  branch where we already wrote a temp MP4 to disk. */
    local_file_path?: string;
    /** MIME type of `local_file_path` source. Defaults to video/mp4
     *  when using the local-file branch. */
    local_mime_type?: string;
    title: string;
    description: string;
    /** YouTube tags array — total length capped to 500 chars by the API. */
    tags?: string[];
    /** "public" | "unlisted" | "private" — anything else falls back to private. */
    privacy_status?: "public" | "unlisted" | "private";
    /** ISO 8601 string. When set, video uploads as private + becomes public at this time. */
    publish_at?: string | null;
    /** YouTube category id ("22" = People & Blogs is a safe default). */
    category_id?: string | undefined;
}

export interface YouTubeUploadResult {
    file_id: string;
    video_id: string;
    privacy_status: string;
    publish_at: string | null;
    raw: any;
}

function dlog(step: string, data?: Record<string, any>) {
    const safe = data ? Object.fromEntries(
        Object.entries(data).map(([k, v]) =>
            /access_token|refresh_token|secret|password|cookie|authorization/i.test(k)
                ? [k, typeof v === "string" ? `<redacted:${v.length}>` : "<redacted>"]
                : [k, v],
        ),
    ) : undefined;
    console.log(`[yt-upload] ${step}${safe ? " " + JSON.stringify(safe) : ""}`);
}

/**
 * Build an authenticated YouTube client from a SocialAccount row, with the
 * auto-refresh listener wired to persist renewed tokens. Reused by the
 * uploader and by the copyright sweep.
 */
export function build_youtube_client(account: SocialAccount) {
    if (account.platform !== "youtube") {
        throw new Error(`SocialAccount ${account.id} is not a YouTube account (platform=${account.platform})`);
    }
    if (!account.access_token) {
        throw new Error(`YouTube account ${account.id} has no access_token — reconnect required`);
    }
    const oauth2 = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.SECRET_KEY,
        process.env.YOUTUBE_REDIRECT_URI ?? process.env.GOOGLE_REDIRECT_URI,
    );
    const credentials: { access_token: string; refresh_token?: string; expiry_date?: number } = {
        access_token: account.access_token,
    };
    if (account.refresh_token) credentials.refresh_token = account.refresh_token;
    if ((account as any).expires_at) credentials.expiry_date = new Date((account as any).expires_at).getTime();
    oauth2.setCredentials(credentials);
    oauth2.on("tokens", async (tokens) => {
        if (!tokens.access_token) return;
        try {
            await account.update({
                access_token: tokens.access_token,
                expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : (account as any).expires_at,
                ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
            } as any);
            dlog("token_auto_refreshed", { account_id: account.id, expiry_date: tokens.expiry_date });
        } catch (err: any) {
            dlog("token_persist_failed", { account_id: account.id, error: err?.message });
        }
    });
    return google.youtube({ version: "v3", auth: oauth2 });
}

/**
 * Inspect a YouTube video for copyright / Content-ID issues. Returns a
 * structured verdict the caller can act on.
 *
 * Signals we treat as "infringing":
 *   - status.uploadStatus === 'rejected' with rejectionReason in
 *     { 'copyright', 'claim', 'trademark', 'duplicate' }
 *   - status.privacyStatus flipped to 'private' by YouTube *after* upload
 *     (we can't tell from the API alone, so we don't infer this)
 *   - contentDetails.regionRestriction.blocked has any entries (Content-ID
 *     match with region block)
 *
 * Note: detailed Content-ID claim metadata requires YouTube Partner API
 * scope (`youtubepartner`), which a regular OAuth app doesn't have. The
 * signals above work without it.
 */
export interface YouTubeCopyrightCheck {
    has_issue: boolean;
    /** Short machine reason: 'rejected:copyright', 'region_blocked', 'not_found', etc. */
    reason: string | null;
    /** Human-readable summary suitable for error_message. */
    summary: string | null;
    raw: any;
}

export async function check_youtube_video_copyright(
    account: SocialAccount,
    video_id: string,
): Promise<YouTubeCopyrightCheck> {
    const youtube = build_youtube_client(account);
    let res: any;
    try {
        res = await youtube.videos.list({
            part: ["status", "contentDetails"],
            id: [video_id],
        });
    } catch (err: any) {
        dlog("copyright_check_api_failed", { video_id, error: err?.message });
        throw err;
    }
    const item = res.data?.items?.[0];
    if (!item) {
        // Video gone — could be us, the user, or a takedown. Treat as an
        // issue so the caller cleans up the row.
        return {
            has_issue: true,
            reason: "not_found",
            summary: "Video no longer exists on YouTube (deleted or taken down).",
            raw: res.data,
        };
    }
    const status = item.status ?? {};
    const content_details = item.contentDetails ?? {};
    const upload_status: string | undefined = status.uploadStatus;
    const rejection_reason: string | undefined = status.rejectionReason;
    const region_blocked: string[] = content_details.regionRestriction?.blocked ?? [];

    if (upload_status === "rejected" && rejection_reason) {
        const copyright_like = ["copyright", "claim", "trademark", "duplicate"];
        if (copyright_like.includes(rejection_reason)) {
            return {
                has_issue: true,
                reason: `rejected:${rejection_reason}`,
                summary: `YouTube rejected the video — reason: ${rejection_reason}.`,
                raw: { status, contentDetails: content_details },
            };
        }
    }
    if (region_blocked.length > 0) {
        return {
            has_issue: true,
            reason: "region_blocked",
            summary: `Content-ID match — blocked in ${region_blocked.length} region(s): ${region_blocked.slice(0, 5).join(", ")}${region_blocked.length > 5 ? "…" : ""}.`,
            raw: { status, contentDetails: content_details },
        };
    }
    return {
        has_issue: false,
        reason: null,
        summary: null,
        raw: { status, contentDetails: content_details },
    };
}

/**
 * Permanent delete of a YouTube video by id. The OAuth scope must include
 * `youtube` (read/write) — `youtube.upload` alone is NOT enough.
 */
export async function delete_youtube_video(
    account: SocialAccount,
    video_id: string,
): Promise<void> {
    const youtube = build_youtube_client(account);
    try {
        await youtube.videos.delete({ id: video_id });
        dlog("video_deleted", { account_id: account.id, video_id });
    } catch (err: any) {
        // 404 = already gone, treat as success.
        const status = err?.response?.status;
        if (status === 404) {
            dlog("video_delete_already_gone", { video_id });
            return;
        }
        dlog("video_delete_failed", { video_id, status, error: err?.message });
        throw err;
    }
}

export async function upload_video_to_youtube(input: YouTubeUploadInput): Promise<YouTubeUploadResult> {
    const { account } = input;
    const youtube = build_youtube_client(account);

    // Source can be the R2 CDN URL (streamed directly, the normal path)
    // or a local file on disk (used by the image-to-video branch where
    // we already wrote a temp MP4). URL wins when both are set.
    let stream: NodeJS.ReadableStream;
    let content_type: string;
    let source_label: string;
    if (input.file_url) {
        dlog("url_stream_open", { file_url: input.file_url });
        const r2 = await get_url_stream(input.file_url);
        stream = r2.stream;
        content_type = r2.content_type;
        source_label = `r2:${input.file_url}`;
    } else if (input.local_file_path) {
        dlog("local_stream_open", { path: input.local_file_path });
        stream = fs.createReadStream(input.local_file_path);
        content_type = input.local_mime_type ?? "video/mp4";
        source_label = `local:${input.local_file_path}`;
    } else {
        throw new Error("upload_video_to_youtube needs either file_url or local_file_path");
    }
    dlog("upload_started", {
        account_id: account.id,
        title: input.title,
        privacy_status: input.privacy_status,
        publish_at: input.publish_at,
        content_type,
        source: source_label,
    });

    const privacy = input.privacy_status === "public"
        ? "public"
        : input.privacy_status === "unlisted"
            ? "unlisted"
            : "private";

    // YouTube enforces: when `publishAt` is set, privacyStatus MUST be
    // "private" at upload time — the API flips it to public at that time.
    // selfDeclaredMadeForKids=false — always declare "Not made for kids" so
    // YouTube doesn't apply COPPA restrictions (no comments, no personalised
    // ads, etc.). Our content isn't directed at children.
    const status_block: Record<string, any> = { privacyStatus: privacy, selfDeclaredMadeForKids: false };
    if (input.publish_at) {
        status_block.privacyStatus = "private";
        status_block.publishAt = new Date(input.publish_at).toISOString();
    }

    let upload_res: any;
    try {
        upload_res = await youtube.videos.insert({
            part: ["snippet", "status"],
            requestBody: {
                snippet: {
                    title: input.title.slice(0, 100),     // YouTube hard-caps title at 100
                    description: input.description ?? "",
                    tags: input.tags ?? [],
                    categoryId: input.category_id ?? "22",
                },
                status: status_block,
            },
            media: {
                body: stream as any,
            },
        });
    } catch (err: any) {
        dlog("upload_failed", {
            account_id: account.id,
            error: err?.message ?? String(err),
            // Googleapis stuffs the structured error here.
            details: err?.errors ?? err?.response?.data ?? null,
        });
        throw err;
    }

    const video_id = upload_res.data?.id;
    if (!video_id) {
        dlog("upload_no_video_id", { raw: upload_res?.data });
        throw new Error("YouTube upload returned no video id");
    }
    dlog("upload_success", { account_id: account.id, video_id });

    return {
        file_id: input.file_url ?? input.local_file_path ?? "",
        video_id,
        privacy_status: status_block.privacyStatus,
        publish_at: status_block.publishAt ?? null,
        raw: upload_res.data,
    };
}
