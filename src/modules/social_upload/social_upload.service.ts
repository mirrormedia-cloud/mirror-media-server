/**
 * Cross-platform upload dispatch.
 *
 * For each platform requested, validate the user has a connected social
 * account, create a `social_uploads` row in `uploading`, hand off to the
 * platform-specific service, and reflect the platform response back into
 * the row (`platform_media_id`, `published_at`, `status`).
 *
 * Bytes come from R2: every platform service streams from the library
 * row's `file_url` (the public CDN URL). If `file_url` is null the
 * upload is rejected with an actionable message rather than a silent fail.
 */

import type { FastifyRequest } from "fastify";
import { literal, Op } from "sequelize";
import {
    SocialUpload,
    SocialAccount,
    OttLibraryItem,
    UploadScheduleItem,
    UploadScheduleBatch,
} from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import { sendPushToUser } from "../../services/notification/firebase-notification.service";
import {
    upload_video_to_youtube,
    YouTubeUploadResult,
} from "../../services/social/youtube_upload.service";
import { image_to_video_mp4 } from "../../utils/ffmpeg";
import { get_url_stream } from "../../services/social/url_stream";
import { alloc_temp_dir, delete_temp_dir } from "../../utils/temp_storage";
import * as fs_node from "fs";
import * as path_node from "path";
import {
    upload_video_to_facebook,
    FacebookUploadResult,
} from "../../services/social/facebook_upload.service";
import {
    upload_video_to_instagram,
    InstagramUploadResult,
} from "../../services/social/instagram_upload.service";
import {
    sweep_youtube_copyright,
    check_and_handle_one,
} from "../../services/social/youtube_copyright_sweep";
import { ensure_analysis } from "../media_analysis/media_analysis.service";
import type { AnalysisPlatform } from "../../services/social/gemini_analysis.service";
import type { MediaAnalysisResult } from "../../db/models";
import {
    build_platform_upload_details,
    AnalysisJson,
} from "../../services/media_analysis/media_platform_parser.service";
import type { UploadInput, ListUploadsQueryInput } from "./social_upload.dto";

function ts(value: any): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function upload_dto(u: SocialUpload) {
    return {
        id: u.id,
        ott_id: u.ott_id ?? null,
        library_item_id: u.library_item_id ?? null,
        schedule_item_id: u.schedule_item_id ?? null,
        social_account_id: u.social_account_id ?? null,
        platform: u.platform,
        title: u.title ?? null,
        description: u.description ?? null,
        tags: u.tags ?? [],
        hashtags: u.hashtags ?? [],
        media_url: u.media_url ?? null,
        local_file_path: u.local_file_path ?? null,
        platform_media_id: u.platform_media_id ?? null,
        platform_post_id: u.platform_post_id ?? null,
        scheduledAt: ts((u as any).scheduled_at),
        publishedAt: ts((u as any).published_at),
        visibility: u.visibility ?? null,
        status: u.status ?? "draft",
        upload_result: u.upload_result ?? {},
        error_message: u.error_message ?? null,
        metadata: u.metadata ?? {},
        auto_details: !!(u as any).auto_details,
        analysis_result_id: (u as any).analysis_result_id ?? null,
        platform_details: (u as any).platform_details ?? {},
        createdAt: ts((u as any).createdAt),
        updatedAt: ts((u as any).updatedAt),
    };
}

function slog(step: string, data?: Record<string, any>) {
    console.log(`[social-upload] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

/**
 * Phased flow logger — prints the upload pipeline as a numbered sequence
 * so the order is unambiguous when triaging:
 *   [UPLOAD FLOW] start
 *   [UPLOAD FLOW] r2 source resolved
 *   [UPLOAD FLOW] analyze_media started
 *   [UPLOAD FLOW] analyze_media completed
 *   [UPLOAD FLOW] final details built
 *   [UPLOAD FLOW] final details saved
 *   [UPLOAD FLOW] platform upload started
 *   [UPLOAD FLOW] platform upload completed | failed
 */
function flog(step: string, data?: Record<string, any>) {
    console.log(`[UPLOAD FLOW] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

/**
 * Pull the most useful sentence out of whatever the platform / SDK threw.
 *
 * - Meta Graph API: { error: { message, type, code, error_subcode, error_user_msg } }
 * - googleapis YouTube: err.errors[0].reason / err.errors[0].message, OR err.message
 * - Plain axios: "Request failed with status code 400"
 *
 * Without this the UI shows the generic axios string and the user has
 * no way to know whether it's an expired token, missing permission,
 * file too large, or wrong endpoint.
 */
function extract_api_error(err: any, fallback = "Upload failed"): string {
    if (!err) return fallback;
    const meta = err?.response?.data?.error;
    if (meta) {
        const parts = [
            meta.error_user_msg ?? meta.message,
            meta.type ? `(${meta.type}` + (meta.code ? `:${meta.code}` : "") + ")" : null,
        ].filter(Boolean);
        if (parts.length) return parts.join(" ");
    }
    if (Array.isArray(err?.errors) && err.errors.length) {
        const first = err.errors[0];
        const reason = first?.reason ? `[${first.reason}] ` : "";
        if (first?.message) return `${reason}${first.message}`;
    }
    if (err?.response?.data?.message) return err.response.data.message;
    return err?.message ?? fallback;
}

/**
 * Combine the modal's separate description / tags / hashtags fields into
 * one caption string. FB + IG don't have separate tag fields like YouTube
 * does — convention is to dump tags + hashtags onto the end of the body.
 */
function build_caption(description: string, tags: string[], hashtags: string[]): string {
    const parts: string[] = [];
    if (description) parts.push(description.trim());
    const tag_line = tags.filter(Boolean).map(t => t.startsWith("#") ? t : `#${t}`).join(" ");
    const hash_line = hashtags.filter(Boolean).map(h => h.startsWith("#") ? h : `#${h}`).join(" ");
    const merged = [tag_line, hash_line].filter(Boolean).join(" ");
    if (merged) parts.push(merged);
    return parts.join("\n\n");
}

// ── Upload ─────────────────────────────────────────────────────────────

export async function create_upload(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const body = req.body as UploadInput;

    // Library item must exist + belong to the user.
    const item = await OttLibraryItem.findOne({
        where: { id: body.library_item_id, user_id } as any,
    });
    if (!item) return error(HttpStatus.NOT_FOUND, "Library item not found");

    // Library items identify themselves via `file_url` (R2 CDN URL).
    // Social uploads stream from that URL — no row, no upload.
    const file_url: string | null = ((item as any).file_url ?? null) as string | null;
    if (!file_url) {
        return error(
            HttpStatus.BAD_REQUEST,
            "Library item has no file_url. Upload to storage first before pushing to social.",
        );
    }

    slog("upload_start", {
        user_id,
        library_item_id: item.id,
        platforms: body.platforms,
        scheduledAt: body.scheduledAt ?? null,
    });

    // ── PHASE 1: start + drive file ─────────────────────────────────────
    const m_top = body.manual_details ?? {};
    flog("start", {
        library_item_id: item.id,
        selected_platforms: body.platforms,
        auto_details: !!body.auto_details,
        has_manual_title: !!((m_top.title ?? body.title ?? "").toString().trim()),
        has_manual_caption: !!((m_top.caption ?? "").toString().trim()),
        has_manual_description: !!((m_top.description ?? body.description ?? "").toString().trim()),
        manual_hashtags_count: (m_top.hashtags ?? body.hashtags ?? []).length,
        manual_tags_count: (m_top.tags ?? body.tags ?? []).length,
    });
    flog("r2 source resolved", { file_url });
    flog("auto_details", { value: !!body.auto_details });

    const results: ReturnType<typeof upload_dto>[] = [];

    /**
     * Per-platform resolution: returns the final field set used for the
     * upload (and stamped on the SocialUpload row). When `auto_details`
     * is on we run/fetch a Gemini analysis for THIS platform and merge
     * it with manual_details (manual wins on a per-field basis). When
     * auto_details is off, we just normalise the body fields.
     */
    const platform_overrides = ((body as any).metadata?.platform_details ?? {}) as Record<string, any>;

    /**
     * Run the SINGLE general-platform analysis ONCE up-front when
     * auto_details=true. The "general" prompt returns a platform-keyed
     * JSON with separate slices for IG/YT/FB — we cache it here and
     * every per-platform `resolve_details` call below just slices the
     * matching key. Saves 2 Gemini calls per upload (was: one analysis
     * per platform).
     */
    // ── PHASE 2: analyze_media (BLOCKING) ───────────────────────────────
    // Awaited explicitly. No upload runs before this resolves. If
    // analysis fails, every per-platform row is created in a `failed`
    // state with the error_message set; we never silently fall back to
    // partial data when auto_details was on AND no manual fields were
    // supplied.
    let general_analysis: MediaAnalysisResult | null = null;
    let general_analysis_json: AnalysisJson = {};
    let general_analysis_error: string | null = null;
    if (body.auto_details) {
        flog("analyze_media started", {
            library_item_id: item.id,
            platform: "general",
        });
        try {
            general_analysis = await ensure_analysis({
                user_id,
                ott_id: (item as any).ott_id ?? null,
                library_item_id: item.id,
                platform: "general" as AnalysisPlatform,
                force_refresh: false,
            });
            console.log(1234567890, general_analysis)
            // Pull the platform-keyed payload out of raw_analysis.
            const raw = (general_analysis?.raw_analysis ?? {}) as any;
            const parsed = raw.parsed ?? raw;
            if (parsed && (parsed.youtube || parsed.instagram || parsed.facebook)) {
                general_analysis_json = {
                    youtube: parsed.youtube,
                    instagram: parsed.instagram,
                    facebook: parsed.facebook,
                };
            }
            flog("analyze_media completed", {
                analysis_id: general_analysis.id,
                status: general_analysis.status,
                has_youtube: !!general_analysis_json.youtube,
                has_instagram: !!general_analysis_json.instagram,
                has_facebook: !!general_analysis_json.facebook,
                yt_tags_count: general_analysis_json.youtube?.tags?.length ?? 0,
                ig_hashtags_count: general_analysis_json.instagram?.hashtags?.length ?? 0,
                fb_hashtags_count: general_analysis_json.facebook?.hashtags?.length ?? 0,
            });
        } catch (err: any) {
            general_analysis_error = err?.message ?? String(err);
            flog("analyze_media failed", {
                library_item_id: item.id,
                error: general_analysis_error,
            });
            // Fall through — uploads still attempt with manual-only fields.
        }
    } else {
        flog("analyze_media skipped", { reason: "auto_details=false" });
    }

    const resolve_details = (platform: AnalysisPlatform): {
        title: string;
        description: string;
        caption: string;
        tags: string[];
        hashtags: string[];
        keywords: string[];
        category: string | null;
        language: string | null;
        analysis_id: string | null;
        source: "manual" | "generated" | "mixed";
    } => {
        // Per-platform overrides win over global manual_details — used by
        // the schedule modal which can carry separate values per platform.
        const p_over = (platform_overrides[platform] ?? {}) as Record<string, any>;
        const m = body.manual_details ?? {};

        // Per-field manual: per_platform → top-level manual_details → body
        const manual = {
            title: (p_over.title ?? m.title ?? body.title ?? "").toString(),
            description: (p_over.description ?? m.description ?? body.description ?? "").toString(),
            caption: (p_over.caption ?? m.caption ?? "").toString(),
            tags: (p_over.tags && p_over.tags.length > 0) ? p_over.tags
                : (m.tags && m.tags.length > 0) ? m.tags
                    : (body.tags ?? []),
            hashtags: (p_over.hashtags && p_over.hashtags.length > 0) ? p_over.hashtags
                : (m.hashtags && m.hashtags.length > 0) ? m.hashtags
                    : (body.hashtags ?? []),
            keywords: (p_over.keywords ?? []) as string[],
            category: (p_over.category ?? "").toString(),
            language: (p_over.language ?? "").toString(),
        };

        if (platform !== "youtube" && platform !== "facebook" && platform !== "instagram") {
            // Defensive — shouldn't fire, but the type signature includes "general".
            return {
                title: manual.title, description: manual.description, caption: manual.caption || manual.description,
                tags: manual.tags, hashtags: manual.hashtags, keywords: [], category: null, language: null,
                analysis_id: null, source: "manual",
            };
        }

        const final = build_platform_upload_details({
            platform,
            auto_details: !!body.auto_details,
            manual_details: manual,
            analysis_json: general_analysis_json,
        });

        const used_manual = !!manual.title || !!manual.description || !!manual.caption
            || manual.tags.length > 0 || manual.hashtags.length > 0;
        const used_generated = !!body.auto_details && !!general_analysis_json[platform]
            && (!manual.title || !manual.description || (manual.tags.length === 0));
        const source: "manual" | "generated" | "mixed" =
            used_manual && used_generated ? "mixed" : used_manual ? "manual" : "generated";

        return {
            title: final.title,
            description: final.description,
            caption: final.caption,
            tags: final.tags,
            hashtags: final.hashtags,
            keywords: final.keywords,
            category: final.category,
            language: final.language,
            analysis_id: general_analysis?.id ?? null,
            source,
        };
    };

    for (const platform of body.platforms) {
        // ── PHASE 3: build final details (after analysis has resolved) ─
        const details_raw = resolve_details(platform);
        // When auto_details is on and analysis failed, ensure there is
        // always a title so the upload proceeds. Fallback chain:
        //   1. user-supplied manual_details.title
        //   2. static "Latest Video"
        const details = (body.auto_details && general_analysis_error && !details_raw.title)
            ? { ...details_raw, title: ((body as any).manual_details?.title?.trim()) || 'Latest Video' }
            : details_raw;
        flog("final details built", {
            platform,
            source: details.source,
            youtube_title: platform === "youtube" ? details.title : undefined,
            youtube_title_len: platform === "youtube" ? (details.title?.length ?? 0) : undefined,
            instagram_caption_len: platform === "instagram" ? (details.caption?.length ?? 0) : undefined,
            facebook_caption_len: platform === "facebook" ? (details.caption?.length ?? 0) : undefined,
            tags_count: details.tags?.length ?? 0,
            hashtags_count: details.hashtags?.length ?? 0,
        });

        // Pick the most-recently-connected account for this platform.
        const account = await SocialAccount.findOne({
            where: { user_id, platform, status: "connected" } as any,
            order: [["createdAt", "DESC"]],
        });

        // Always persist a row, even when we're going to bail — gives the
        // user a uniform list of attempts in the schedules / activity view.
        const upload = await SocialUpload.create({
            user_id,
            ott_id: (item as any).ott_id ?? null,
            library_item_id: item.id,
            schedule_item_id: body.schedule_item_id ?? null,
            social_account_id: account?.id ?? null,
            platform,
            title: details.title,
            description: details.description,
            tags: details.tags,
            hashtags: details.hashtags,
            scheduled_at: body.scheduledAt ? new Date(body.scheduledAt) : null,
            visibility: body.visibility ?? "private",
            status: "uploading",
            upload_result: {},
            metadata: { details_source: details.source },
            auto_details: !!body.auto_details,
            analysis_result_id: details.analysis_id,
            platform_details: platform === "youtube"
                ? {
                    [platform]: {
                        title: details.title,
                        description: details.description,
                        tags: details.tags,
                        keywords: details.keywords,
                        hashtags: details.hashtags,
                        category: details.category,
                        language: details.language,
                    },
                }
                : {
                    // IG / FB: caption is the full body. Title kept for
                    // traceability ("what manual title did the user
                    // type") even though the upload uses caption.
                    [platform]: {
                        caption: details.caption,
                        title: details.title,
                        hashtags: details.hashtags,
                    },
                },
        } as any);

        // ── PHASE 4: final details persisted ───────────────────────────
        // The row above was created with all the resolved fields; this is
        // the durable "details_ready" boundary even though we don't have
        // a separate enum value (status='uploading' covers from-this-point).
        flog("final details saved", {
            platform,
            upload_id: upload.id,
            analysis_result_id: details.analysis_id,
        });

        if (!account) {
            slog("upload_no_account", { user_id, platform, upload_id: upload.id });
            await upload.update({
                status: "failed",
                error_message: `No connected ${platform} account. Connect one in /dashboard/social-accounts first.`,
            });
            // Treat "no account" as a reconnect-required signal. The dedup
            // window keeps a flapping platform from spamming the user.
            try {
                await sendPushToUser({
                    user_id,
                    title: "Reconnect Required",
                    body: `Your ${platform} account is not connected. Please reconnect it.`,
                    type: "warning",
                    module: "platform",
                    event_type: "platform_token_error",
                    related_id: platform,
                    redirect_url: "/dashboard/social-accounts",
                });
            } catch (err) { console.log("Error:- push platform_token_error", err); }
            results.push(upload_dto(upload));
            continue;
        }

        // ── PHASE 5: platform upload ───────────────────────────────────
        flog("platform upload started", { platform, upload_id: upload.id });

        try {
            if (platform === "youtube") {
                // YouTube has no native image upload. When the library
                // item is an image, download it from R2, wrap it in a
                // short MP4 with silent audio via ffmpeg, then upload
                // the temp MP4 instead of the original image bytes.
                const item_save_type = (item as any).save_type as string | undefined;
                const item_mime = (item as any).mime_type as string | undefined;
                const is_image = item_save_type === "image"
                    || item_save_type === "thumbnail"
                    || (item_mime ? item_mime.toLowerCase().startsWith("image/") : false);

                let yt: YouTubeUploadResult;
                let temp_dir: string | null = null;
                try {
                    if (is_image) {
                        // Stream the image from R2 to disk, then wrap in MP4.
                        const alloc = alloc_temp_dir(`yt-image-${upload.id}`);
                        temp_dir = alloc.dir;
                        const image_ext = (item_mime || "").split("/")[1] || "jpg";
                        const image_path = path_node.join(temp_dir, `source.${image_ext}`);
                        const video_path = path_node.join(temp_dir, "output.mp4");
                        const r2 = await get_url_stream(file_url);
                        await new Promise<void>((resolve, reject) => {
                            const ws = fs_node.createWriteStream(image_path);
                            r2.stream.pipe(ws);
                            ws.on("finish", () => resolve());
                            ws.on("error", reject);
                            r2.stream.on("error", reject);
                        });
                        flog("image_to_video_started", { upload_id: upload.id, image_path, video_path });
                        await image_to_video_mp4({
                            image_path,
                            output_path: video_path,
                            duration_sec: 5,
                            fps: 30,
                        });
                        flog("image_to_video_done", { upload_id: upload.id });
                        yt = await upload_video_to_youtube({
                            account,
                            local_file_path: video_path,
                            local_mime_type: "video/mp4",
                            title: details.title || "Untitled",
                            description: details.description,
                            tags: details.tags,
                            privacy_status: body.visibility ?? "private",
                            publish_at: body.scheduledAt ?? null,
                            category_id: body.youtube_category_id,
                        });
                    } else {
                        yt = await upload_video_to_youtube({
                            account,
                            file_url,
                            title: details.title || "Untitled",
                            description: details.description,
                            tags: details.tags,
                            privacy_status: body.visibility ?? "private",
                            publish_at: body.scheduledAt ?? null,
                            category_id: body.youtube_category_id,
                        });
                    }
                } finally {
                    if (temp_dir) {
                        try { delete_temp_dir(temp_dir); } catch { /* best-effort */ }
                    }
                }
                const has_publish_at = !!yt.publish_at;
                await upload.update({
                    status: has_publish_at ? "scheduled" : "uploaded",
                    platform_media_id: yt.video_id,
                    media_url: `https://www.youtube.com/watch?v=${yt.video_id}`,
                    published_at: has_publish_at ? null : new Date(),
                    upload_result: { youtube: { video_id: yt.video_id, privacy_status: yt.privacy_status, publish_at: yt.publish_at } },
                    error_message: null,
                } as any);
                slog("upload_done", { upload_id: upload.id, platform, video_id: yt.video_id, scheduled: has_publish_at });
                flog("platform upload completed", { platform, upload_id: upload.id, scheduled: has_publish_at, platform_media_id: yt.video_id });
            } else if (platform === "facebook") {
                // FB caption: prefer the platform-specific caption when we
                // have one (Gemini already produced FB-tone copy), else
                // synthesize from description + hashtags.
                const caption = details.caption || build_caption(details.description, details.tags, details.hashtags);
                const fb: FacebookUploadResult = await upload_video_to_facebook({
                    account,
                    file_url,
                    title: details.title || "Upload",
                    description: caption,
                    publish_at: body.scheduledAt ?? null,
                });
                await upload.update({
                    status: fb.scheduled ? "scheduled" : "uploaded",
                    platform_media_id: fb.video_id,
                    platform_post_id: fb.video_id,
                    media_url: account.page_id
                        ? `https://www.facebook.com/${account.page_id}/videos/${fb.video_id}`
                        : `https://www.facebook.com/${fb.video_id}`,
                    published_at: fb.scheduled ? null : new Date(),
                    upload_result: { facebook: { video_id: fb.video_id, scheduled: fb.scheduled, publish_at: fb.publish_at } },
                    error_message: null,
                } as any);
                slog("upload_done", { upload_id: upload.id, platform, video_id: fb.video_id, scheduled: fb.scheduled });
                flog("platform upload completed", { platform, upload_id: upload.id, scheduled: fb.scheduled, platform_media_id: fb.video_id });
            } else if (platform === "instagram") {
                // IG caption: prefer the analysis-derived caption (which is
                // mobile-tuned) over the synthesized one.
                const caption = details.caption || build_caption(details.description, details.tags, details.hashtags);
                // IG accepts BOTH single images and Reels via the same
                // /media endpoint, but the body shape differs per kind.
                // Classify the library row so we send the right one — a
                // Reels POST with an image URL gets rejected by Meta
                // with status code 2207026 ("video format is not
                // supported"), which is what the user was seeing.
                const ig_item_save_type = (item as any).save_type as string | undefined;
                const ig_item_mime = (item as any).mime_type as string | undefined;
                const ig_is_image = ig_item_save_type === "image"
                    || ig_item_save_type === "thumbnail"
                    || (ig_item_mime ? ig_item_mime.toLowerCase().startsWith("image/") : false);
                const ig: InstagramUploadResult = await upload_video_to_instagram({
                    account,
                    file_url,
                    media_kind: ig_is_image ? "image" : "video",
                    caption,
                    publish_at: body.scheduledAt ?? null,
                });
                if (ig.scheduled) {
                    // IG has no native publish-later flag — we hold the
                    // container and let a Scenario-2 cron run /media_publish
                    // at the scheduled time. Surfaced in the row so the UI
                    // shows the right state.
                    await upload.update({
                        status: "scheduled",
                        platform_media_id: ig.creation_id,
                        upload_result: {
                            instagram: {
                                creation_id: ig.creation_id,
                                deferred_publish: true,
                                note: "Container created; cron will run /media_publish at scheduledAt.",
                            },
                        },
                        error_message: null,
                    } as any);
                } else {
                    await upload.update({
                        status: "uploaded",
                        platform_media_id: ig.creation_id,
                        platform_post_id: ig.media_id ?? ig.creation_id,
                        media_url: ig.media_id ? `https://www.instagram.com/p/${ig.media_id}/` : null,
                        published_at: new Date(),
                        upload_result: { instagram: { creation_id: ig.creation_id, media_id: ig.media_id } },
                        error_message: null,
                    } as any);
                }
                slog("upload_done", { upload_id: upload.id, platform, creation_id: ig.creation_id, scheduled: ig.scheduled });
                flog("platform upload completed", { platform, upload_id: upload.id, scheduled: ig.scheduled, platform_media_id: ig.creation_id });
            } else {
                await upload.update({
                    status: "failed",
                    error_message: `${platform} upload not implemented.`,
                });
            }
        } catch (err: any) {
            const friendly = extract_api_error(err, `${platform} upload failed`);
            slog("upload_error", {
                upload_id: upload.id,
                platform,
                friendly,
                axios_status: err?.response?.status,
                axios_message: err?.message,
            });
            await upload.update({
                status: "failed",
                error_message: friendly.slice(0, 500),
                // Keep the full structured error in upload_result so the
                // analytics page (and devtools) can see the raw payload.
                upload_result: {
                    error: err?.errors ?? err?.response?.data ?? { message: err?.message },
                    http_status: err?.response?.status ?? null,
                },
            });
            flog("platform upload failed", {
                platform,
                upload_id: upload.id,
                http_status: err?.response?.status ?? null,
                friendly,
            });
            // Heuristic: a 401/403 from the platform API almost always means
            // the access token is no longer valid (revoked / expired / scope
            // changed). Surface it as the reconnect notification instead of
            // a generic "upload failed" so the user knows what to fix.
            try {
                const http = err?.response?.status as number | undefined;
                const isTokenIssue = http === 401 || http === 403;
                const file_name = (item as any).file_name ?? "Your file";
                const platform_label = platform.charAt(0).toUpperCase() + platform.slice(1);
                if (isTokenIssue) {
                    await sendPushToUser({
                        user_id,
                        title: "Reconnect Required",
                        body: `Your ${platform_label} account token expired. Please reconnect it.`,
                        type: "warning",
                        module: "platform",
                        event_type: "platform_token_error",
                        related_id: account?.id ?? platform,
                        redirect_url: "/dashboard/social-accounts",
                    });
                } else {
                    await sendPushToUser({
                        user_id,
                        title: `${platform_label} Upload Failed`,
                        body: `${file_name} could not be uploaded to ${platform_label}.`,
                        type: "error",
                        module: platform,
                        event_type: "platform_upload_failed",
                        related_id: upload.id,
                        redirect_url: "/dashboard/media-uploads",
                    });
                }
            } catch (notify_err) { console.log("Error:- push platform_upload_failed", notify_err); }
        }

        results.push(upload_dto(upload));
    }

    return success("Upload dispatched", { uploads: results });
}

// ── Schedule-item bridge ───────────────────────────────────────────────

/**
 * Trigger uploads for a previously-saved calendar schedule item.
 *
 * This is the manual "fire one schedule slot" entry point — Scenario 2
 * cron will eventually run this same logic on every slot at its
 * `scheduled_at`. For now the user clicks "Upload Now" on the schedule
 * item and we kick off the per-platform pushes immediately.
 *
 * Reuses everything else: validates ownership, walks every platform on
 * the parent batch, creates social_uploads rows, hands off to the same
 * platform services as the manual library-card flow.
 */
export async function upload_schedule_item(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { schedule_item_id } = req.params as { schedule_item_id: string };

    const item = await UploadScheduleItem.findOne({ where: { id: schedule_item_id, user_id } as any });
    if (!item) return error(HttpStatus.NOT_FOUND, "Schedule item not found");

    if (!(item as any).library_item_id) {
        return error(HttpStatus.BAD_REQUEST, "Schedule item has no library_item_id — nothing to upload.");
    }

    // Walk back to the batch so we know which platforms the user picked.
    const batch = (item as any).batch_id
        ? await UploadScheduleBatch.findOne({ where: { id: (item as any).batch_id, user_id } as any })
        : null;
    const platforms = (batch?.platforms ?? item.platforms ?? []) as string[];
    if (platforms.length === 0) {
        return error(HttpStatus.BAD_REQUEST, "No platforms recorded on this schedule slot.");
    }

    // Reuse the main `create_upload` body by synthesising a request-like
    // object. Title / description / tags carry over from the batch.
    //
    // visibility defaults to "public" — when the user schedules an
    // upload to a platform, the whole point is for it to go live at the
    // chosen time. They can override per-batch via metadata.visibility
    // (set from the schedule wizard), private/unlisted respected.
    //
    // scheduledAt is only forwarded when it's at least a few minutes
    // ahead — YouTube/FB reject publishAt in the past. When the slot
    // time has already arrived (the cron fires AT scheduled_at), we
    // upload + publish immediately instead.
    const visibility = (batch?.metadata as any)?.visibility ?? "public";
    const slot_time = (item as any).scheduled_at ? new Date((item as any).scheduled_at).getTime() : null;
    const min_ahead_ms = 5 * 60 * 1000;
    const forward_scheduled_at = slot_time != null && slot_time - Date.now() > min_ahead_ms;

    // If the slot was saved with auto_details=true, forward that flag and
    // the manual values the user typed at schedule time as `manual_details`
    // so create_upload's per-platform resolver fills only the empty fields
    // (preserving the user's choices). Per-platform overrides live in
    // `platform_details` on the schedule item — we forward them too so the
    // creator's per-platform tweaks survive into the social_uploads row.
    const item_auto_details = !!(item as any).auto_details;
    const item_platform_details = ((item as any).platform_details ?? {}) as Record<string, any>;
    const item_caption = (item as any).caption as string | null | undefined;
    const item_tags = ((item as any).tags ?? batch?.tags ?? []) as string[];
    const item_hashtags = ((item as any).hashtags ?? []) as string[];

    // CRITICAL: when auto_details=true, ONLY set top-level body fields
    // (title/description/tags/hashtags) for values the user explicitly
    // typed. Otherwise resolve_details would treat the batch name /
    // empty-string fallbacks as manual overrides and silently shadow
    // the AI-generated values. Empty fields are intentionally omitted
    // so the per-platform builder reaches for `manual_details` (which
    // is also user-typed only) and falls through to the analysis JSON.
    const synthetic_body: Record<string, any> = {
        library_item_id: (item as any).library_item_id,
        platforms,
        ...(forward_scheduled_at ? { scheduledAt: new Date(slot_time!).toISOString() } : {}),
        visibility,
        schedule_item_id: item.id,
        auto_details: item_auto_details,
    };
    if (item_auto_details) {
        // Auto-details: ONLY user-typed fields make it through. Don't
        // include batch.name / batch.description as fallbacks here —
        // they'd masquerade as manual overrides and beat the AI output.
        if (item.title) synthetic_body.title = item.title;
        if (item.description) synthetic_body.description = item.description;
        if (item_tags.length) synthetic_body.tags = item_tags;
        if (item_hashtags.length) synthetic_body.hashtags = item_hashtags;
        synthetic_body.manual_details = {
            ...(item.title ? { title: item.title } : {}),
            ...(item.description ? { description: item.description } : {}),
            ...(item_caption ? { caption: item_caption } : {}),
            ...(item_tags.length > 0 ? { tags: item_tags } : {}),
            ...(item_hashtags.length > 0 ? { hashtags: item_hashtags } : {}),
        };
    } else {
        // Manual-only: fall back to batch fields so a slot scheduled
        // without auto_details still gets a sensible title at fire time.
        synthetic_body.title = item.title || batch?.name || "Upload";
        synthetic_body.description = item.description ?? batch?.description ?? "";
        synthetic_body.tags = item_tags;
        synthetic_body.hashtags = item_hashtags;
    }
    // Pass platform_details through metadata so create_upload's per-platform
    // branch can read per-platform overrides without changing its DTO shape.
    if (Object.keys(item_platform_details).length > 0) {
        synthetic_body.metadata = { platform_details: item_platform_details };
    }

    const synthetic_req = { ...req, body: synthetic_body } as FastifyRequest;

    // Mark the schedule slot as `uploading` BEFORE the long-running
    // create_upload runs, then return to the caller immediately. The
    // actual platform pushes happen in a fire-and-forget background
    // promise so:
    //   - the HTTP response is instant (no minute-long hang),
    //   - a page refresh during the upload shows `uploading` instead
    //     of the stale `scheduled` / `failed`,
    //   - when the background promise finishes it persists the final
    //     status (`uploaded` / `failed`) so the next refresh reflects
    //     the real outcome.
    try {
        await item.update({ status: "uploading", error_message: null } as any);
    } catch (err: any) {
        slog("schedule_item_status_uploading_failed", { schedule_item_id: item.id, error: err?.message });
    }

    void (async () => {
        try {
            const result: any = await create_upload(synthetic_req);
            const uploads = result?.data?.uploads ?? [];
            const ok = uploads.filter((u: any) => u.status === "uploaded" || u.status === "scheduled").length;
            const failed = uploads.filter((u: any) => u.status === "failed").length;
            await item.update({
                status: ok > 0 ? "uploaded" : "failed",
                error_message: failed > 0
                    ? `${failed} platform(s) failed — see Social Media → Recent uploads`
                    : null,
            } as any);
            slog("schedule_item_push_done", { schedule_item_id: item.id, ok, failed });

            // Partial-failure push: some platforms succeeded, others didn't.
            // Per-platform `platform_upload_failed` pushes already fired from
            // inside create_upload; this one is the umbrella "partial" alert.
            if (ok > 0 && failed > 0) {
                const failed_platforms = uploads
                    .filter((u: any) => u.status === "failed")
                    .map((u: any) => (u.platform as string).charAt(0).toUpperCase() + u.platform.slice(1));
                const file_name = (item as any).title ?? "Your scheduled upload";
                try {
                    await sendPushToUser({
                        user_id,
                        title: "Partial Upload Failed",
                        body: `${file_name} uploaded to some platforms, but failed on ${failed_platforms.join(", ")}.`,
                        type: "warning",
                        module: "platform",
                        event_type: "platform_partial_failed",
                        related_id: item.id,
                        redirect_url: "/dashboard/media-uploads",
                    });
                } catch (err) { console.log("Error:- push platform_partial_failed", err); }
            }
        } catch (err: any) {
            slog("schedule_item_push_error", { schedule_item_id: item.id, error: err?.message });
            try {
                await item.update({
                    status: "failed",
                    error_message: (err?.message ?? "Push failed").slice(0, 500),
                } as any);
            } catch { /* noop */ }

            // Whole scheduled slot blew up before a single platform attempt
            // finished — this is the canonical scheduled_upload_failed event.
            const file_name = (item as any).title ?? "Your scheduled upload";
            const reason = (err?.message ?? "an unknown error").slice(0, 200);
            try {
                await sendPushToUser({
                    user_id,
                    title: "Scheduled Upload Failed",
                    body: `${file_name} was not uploaded because ${reason}.`,
                    type: "error",
                    module: "schedule",
                    event_type: "scheduled_upload_failed",
                    related_id: item.id,
                    redirect_url: "/dashboard/schedules",
                });
            } catch (notify_err) { console.log("Error:- push scheduled_upload_failed", notify_err); }
        }
    })();

    return success("Push queued", {
        schedule_item_id: item.id,
        status: "uploading",
        // Empty uploads array so the existing frontend code that reads
        // `uploads` doesn't crash. The real per-platform rows will
        // appear in social_uploads as the background job processes
        // them — fetched via the Social Uploads page or via a refresh
        // of this schedule.
        uploads: [],
    });
}

// ── List uploads ───────────────────────────────────────────────────────

export async function list_uploads(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const q = (req.query ?? {}) as ListUploadsQueryInput;

    const where: any = { user_id };
    if (q.library_item_id) where.library_item_id = q.library_item_id;
    if (q.platform) where.platform = q.platform;
    if (q.status) where.status = q.status;
    if (q.search?.trim()) {
        const term = `%${q.search.trim()}%`;
        where[Op.or] = [
            { title: { [Op.iLike]: term } },
            { description: { [Op.iLike]: term } },
        ];
    }
    if (q.date_from || q.date_to) {
        const range: any = {};
        if (q.date_from) range[Op.gte] = new Date(`${q.date_from}T00:00:00.000Z`);
        if (q.date_to)   range[Op.lte] = new Date(`${q.date_to}T23:59:59.999Z`);
        where.createdAt = range;
    }

    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const offset = (page - 1) * limit;

    const { rows, count } = await SocialUpload.findAndCountAll({
        where,
        order: [["createdAt", "DESC"]],
        limit,
        offset,
    });

    // Resolve human-friendly names for the FK ids the upload row carries
    // (library_item_id / schedule_item_id / social_account_id) so the
    // frontend can render "download.mp4" / "Daily Mix · 9:30 AM" /
    // "@my-channel" instead of raw UUIDs. One batched lookup per FK
    // table, then a per-row dictionary merge.
    const lib_ids = unique_strings(rows.map(r => r.library_item_id));
    const sched_ids = unique_strings(rows.map(r => r.schedule_item_id));
    const acct_ids = unique_strings(rows.map(r => r.social_account_id));

    const [lib_rows, sched_rows, acct_rows] = await Promise.all([
        lib_ids.length === 0
            ? []
            : OttLibraryItem.findAll({
                where: { id: { [Op.in]: lib_ids } } as any,
                attributes: ["id", "title", "file_name", "parent_title"],
                raw: true,
            }) as unknown as Array<{ id: string; title: string | null; file_name: string | null; parent_title: string | null }>,
        sched_ids.length === 0
            ? []
            : UploadScheduleItem.findAll({
                where: { id: { [Op.in]: sched_ids } } as any,
                attributes: ["id", "title", "scheduled_at", "batch_id"],
                raw: true,
            }) as unknown as Array<{ id: string; title: string | null; scheduled_at: Date | string | null; batch_id: string | null }>,
        acct_ids.length === 0
            ? []
            : SocialAccount.findAll({
                where: { id: { [Op.in]: acct_ids } } as any,
                attributes: ["id", "channel_name", "account_name", "platform"],
                raw: true,
            }) as unknown as Array<{ id: string; channel_name: string | null; account_name: string | null; platform: string }>,
    ]);

    // Batches sit one hop behind schedule items — pull them only after
    // we know which batch_ids we actually need.
    const batch_ids = unique_strings(sched_rows.map(s => s.batch_id));
    const batch_rows = batch_ids.length === 0
        ? []
        : await UploadScheduleBatch.findAll({
            where: { id: { [Op.in]: batch_ids } } as any,
            attributes: ["id", "name"],
            raw: true,
        }) as unknown as Array<{ id: string; name: string | null }>;

    const lib_map = new Map(lib_rows.map(r => [r.id, {
        title: r.title || r.file_name || null,
        file_name: r.file_name,
        parent_title: r.parent_title,
    }]));
    const batch_map = new Map(batch_rows.map(b => [b.id, b.name]));
    const sched_map = new Map(sched_rows.map(s => [s.id, {
        title: s.title,
        scheduled_at: s.scheduled_at instanceof Date
            ? s.scheduled_at.toISOString()
            : (s.scheduled_at as string | null) ?? null,
        batch_name: s.batch_id ? batch_map.get(s.batch_id) ?? null : null,
    }]));
    const acct_map = new Map(acct_rows.map(a => [a.id, {
        channel_name: a.channel_name,
        account_name: a.account_name,
        platform: a.platform,
    }]));

    return success("Uploads fetched", {
        total: count,
        page,
        limit,
        uploads: rows.map(r => ({
            ...upload_dto(r),
            library_item: r.library_item_id ? lib_map.get(r.library_item_id) ?? null : null,
            schedule_item: r.schedule_item_id ? sched_map.get(r.schedule_item_id) ?? null : null,
            social_account: r.social_account_id ? acct_map.get(r.social_account_id) ?? null : null,
        })),
    });
}

/** Collect a deduped list of defined string ids from a column array. */
function unique_strings(arr: Array<string | null | undefined>): string[] {
    const set = new Set<string>();
    for (const v of arr) if (typeof v === "string" && v.length > 0) set.add(v);
    return Array.from(set);
}

// ── Upload stats ─────────────────────────────────────────────────────
//
// Aggregate counts over the entire `social_uploads` table for the
// authenticated user. The frontend's stat cards + per-platform tiles
// previously derived their counts from the paginated table response,
// which capped each tile at PAGE_SIZE. This endpoint returns the
// authoritative totals so the cards reflect ALL data, not just the
// current page.
//
// Optional filter params (?platform=&status=) are accepted so callers
// who want a filtered breakdown can use them; the default page just
// calls without filters to show the overall picture.
export async function list_upload_stats(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const q = (req.query ?? {}) as { platform?: string; status?: string };

    const where: any = { user_id };
    if (q.platform) where.platform = q.platform;
    if (q.status) where.status = q.status;

    // Two GROUP-BY queries so we get both the status and platform
    // breakdowns in one trip — each is a single COUNT(*) GROUP BY
    // <column> so the cost is small even with many uploads.
    const by_status_rows = await SocialUpload.findAll({
        where,
        attributes: ["status", [literal("COUNT(*)"), "count"]],
        group: ["status"],
        raw: true,
    }) as unknown as Array<{ status: string; count: string }>;

    const by_platform_rows = await SocialUpload.findAll({
        where,
        attributes: ["platform", [literal("COUNT(*)"), "count"]],
        group: ["platform"],
        raw: true,
    }) as unknown as Array<{ platform: string; count: string }>;

    const by_status: Record<string, number> = {
        draft: 0, scheduled: 0, uploading: 0, uploaded: 0, failed: 0, cancelled: 0,
    };
    let total = 0;
    for (const r of by_status_rows) {
        const n = Number(r.count) || 0;
        if (r.status in by_status) by_status[r.status] = n;
        total += n;
    }

    const by_platform: Record<string, number> = {
        youtube: 0, facebook: 0, instagram: 0,
    };
    for (const r of by_platform_rows) {
        const n = Number(r.count) || 0;
        if (r.platform in by_platform) by_platform[r.platform] = n;
    }

    return success("Upload stats", { total, by_status, by_platform });
}

/**
 * Manual "Check now" — runs the YouTube copyright sweep immediately for
 * the caller's uploads, bypassing the per-row 15-min cooldown. Returns a
 * summary plus the per-row outcomes so the UI can show what was checked.
 */
export async function youtube_copyright_check_now(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const result = await sweep_youtube_copyright({ force: true, user_id });
    return success("Copyright check completed", result);
}

/**
 * Manual per-row check. The id in the URL is the SocialUpload row id —
 * not the YouTube video id — so we can scope ownership before touching
 * anything on YouTube.
 */
export async function youtube_copyright_check_one(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { upload_id } = (req.params ?? {}) as { upload_id: string };
    const row = await SocialUpload.findByPk(upload_id);
    if (!row) return error(HttpStatus.NOT_FOUND, "Upload not found");
    if (row.user_id !== user_id) return error(HttpStatus.FORBIDDEN, "Not your upload");
    if (row.platform !== "youtube") return error(HttpStatus.BAD_REQUEST, "Only YouTube uploads can be checked for copyright");
    const outcome = await check_and_handle_one(row, { force: true });
    return success("Check completed", outcome);
}
