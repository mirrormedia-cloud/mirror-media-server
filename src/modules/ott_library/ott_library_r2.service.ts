/**
 * R2 upload pipeline for library items — Mirror Media Cloud
 * replacement for `ott_library_drive.service.ts`.
 *
 * Same conceptual surface as the Drive helper (main file + optional
 * thumbnail + optional image), but writes to Cloudflare R2 via the
 * S3-compatible SDK and stamps the **single** `file_url` the frontend
 * now reads.
 *
 * Key layout (kept stable so URLs remain predictable):
 *
 *     users/<user_id>/library/<ott_id>/<folder>/<library_item_id>/<safe_name>
 *
 *   folder ∈ { videos | images | thumbnails | playlists }
 *
 * If R2_PUBLIC_BASE_URL is configured, the helper returns a permanent
 * CDN-style URL the browser can stream directly (the user said this is
 * how their bucket is configured). When that env is empty the upload
 * still succeeds but `file_url` is null — callers can then materialise
 * a short-lived signed read URL via `generate_read_signed_url` at
 * preview time.
 */

import fs from "fs";
import path from "path";
import {
    upload_file_to_r2,
    build_library_key,
    is_r2_configured,
    sanitize_object_name,
    delete_r2_object,
} from "../../services/storage/r2_storage.service";
import { config } from "../../config";

export { is_r2_configured };

/**
 * Resolve the R2 object key for a library row.
 *
 * Preference order:
 *   1. `metadata.r2_key` (new uploads — explicit, survives URL rewrites).
 *   2. `metadata.key`    (signed-URL upload flow — legacy field name).
 *   3. Strip `R2_PUBLIC_BASE_URL` from `file_url` (covers rows uploaded
 *      before metadata persistence was added).
 *
 * Returns null when no key can be derived — caller should skip the
 * R2 delete in that case rather than throwing.
 */
export function resolve_item_r2_key(item: {
    file_url?: string | null | undefined;
    metadata?: any;
}): string | null {
    const meta = (item.metadata ?? {}) as Record<string, any>;
    if (typeof meta.r2_key === "string" && meta.r2_key.length > 0) return meta.r2_key;
    if (typeof meta.key === "string" && meta.key.length > 0) return meta.key;
    if (!item.file_url) return null;
    const base = (config.r2?.public_base_url || "").replace(/\/+$/, "");
    if (!base) return null;
    if (!item.file_url.startsWith(base + "/")) return null;
    return item.file_url.slice(base.length + 1);
}

/**
 * Best-effort delete of the row's main R2 object. Non-fatal: the
 * underlying `delete_r2_object` already swallows errors so the DB
 * delete is never blocked by a transient R2 outage. Folder-placeholder
 * rows (no `file_url`) are skipped automatically.
 *
 * NOTE: per-item thumbnail/image objects uploaded by the OTT scrape
 * pipeline are NOT removed here — their keys were never persisted on
 * the row. They remain orphaned in the bucket (pre-existing behaviour).
 */
export async function delete_item_r2_object(item: {
    file_url?: string | null | undefined;
    metadata?: any;
}): Promise<void> {
    if (!is_r2_configured()) return;
    const key = resolve_item_r2_key(item);
    if (!key) return;
    await delete_r2_object(key);
}

export interface R2UploadResult {
    /** Stable R2 object key — useful for re-upload / delete. */
    key: string;
    /** Permanent public URL when R2_PUBLIC_BASE_URL is set, else null. */
    file_url: string | null;
    mime_type: string;
    size: number;
}

export interface R2UploadOutput {
    main: R2UploadResult;
    thumbnail?: R2UploadResult | null;
    image?: R2UploadResult | null;
}

export interface R2LibraryUploadInput {
    user_id: string;
    ott_id: string;
    library_item_id: string;
    file_path: string;
    file_name: string;
    mime_type: string;
    folder: "videos" | "images" | "thumbnails" | "playlists";
    thumbnail_path?: string | null;
    thumbnail_name?: string | null;
    image_path?: string | null;
    image_name?: string | null;
}

async function _upload(args: {
    user_id: string;
    ott_id: string;
    library_item_id: string;
    folder: R2LibraryUploadInput["folder"];
    file_path: string;
    file_name: string;
    mime_type: string;
}): Promise<R2UploadResult> {
    const safe_name = sanitize_object_name(args.file_name, "file");
    const key = build_library_key({
        user_id: args.user_id,
        ott_id: args.ott_id,
        library_item_id: args.library_item_id,
        folder: args.folder,
        file_name: safe_name,
    });
    const result = await upload_file_to_r2({
        local_file_path: args.file_path,
        key,
        content_type: args.mime_type,
    });
    return {
        key: result.key,
        file_url: result.public_url,
        mime_type: args.mime_type,
        size: result.size,
    };
}

export async function upload_library_item_to_r2(
    input: R2LibraryUploadInput,
): Promise<R2UploadOutput> {
    const main = await _upload({
        user_id: input.user_id,
        ott_id: input.ott_id,
        library_item_id: input.library_item_id,
        folder: input.folder,
        file_path: input.file_path,
        file_name: input.file_name,
        mime_type: input.mime_type,
    });

    let thumbnail: R2UploadResult | null = null;
    if (input.thumbnail_path && fs.existsSync(input.thumbnail_path)) {
        try {
            thumbnail = await _upload({
                user_id: input.user_id,
                ott_id: input.ott_id,
                library_item_id: input.library_item_id,
                folder: "thumbnails",
                file_path: input.thumbnail_path,
                file_name: input.thumbnail_name || path.basename(input.thumbnail_path),
                mime_type: "image/jpeg",
            });
        } catch (e: any) {
            console.log(`[R2] thumbnail upload failed for ${input.thumbnail_path}:`, e?.message ?? e);
        }
    }

    let image: R2UploadResult | null = null;
    if (
        input.image_path
        && input.image_path !== input.thumbnail_path
        && fs.existsSync(input.image_path)
    ) {
        try {
            image = await _upload({
                user_id: input.user_id,
                ott_id: input.ott_id,
                library_item_id: input.library_item_id,
                folder: "images",
                file_path: input.image_path,
                file_name: input.image_name || path.basename(input.image_path),
                mime_type: "image/jpeg",
            });
        } catch (e: any) {
            console.log(`[R2] image upload failed for ${input.image_path}:`, e?.message ?? e);
        }
    }

    return { main, thumbnail, image };
}
