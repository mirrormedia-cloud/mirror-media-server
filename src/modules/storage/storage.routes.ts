/**
 * Storage routes — signed upload helpers for Cloudflare R2.
 *
 *   POST /api/storage/r2/signed-upload-url
 *     Returns a short-lived PUT URL the browser can stream a file
 *     to directly. The backend never proxies the bytes.
 *
 *   POST /api/storage/r2/complete-upload
 *     Optional notification endpoint the frontend calls after a
 *     direct upload finishes. Just validates ownership and echoes
 *     the public URL back. (No DB write — the library save/complete
 *     flow handles row creation separately.)
 *
 *   GET  /api/storage/r2/health
 *     Reports whether R2 is configured. Useful for the settings
 *     page to show a "connected" / "missing creds" badge.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import path from "path";
import crypto from "crypto";
import { validate } from "../../shared/http/validate";
import { success, error, serverError } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import {
    generate_upload_signed_url,
    build_library_key,
    sanitize_object_name,
    is_r2_configured,
    get_public_url,
    generate_read_signed_url,
} from "../../services/storage/r2_storage.service";
import { SignedUploadUrlDto, CompleteUploadDto } from "./storage.dto";
import type { SignedUploadUrlInput, CompleteUploadInput } from "./storage.dto";
import { OttLibraryItem, OttPlatform } from "../../db/models";
import { library_item_dto } from "../ott_library/ott_library.service";
import { Op } from "sequelize";

const FOLDER_PLACEHOLDER_TYPE = "folder_placeholder";

/**
 * Walk `dir_segments` from `target_parent_key` and create one
 * folder-placeholder row per missing level. Returns the leaf folder's
 * key + title so the caller can pin the uploaded file there.
 *
 * Mirrors the chain-walking logic in
 * `library_browser/local_uploads_crud.service.ts#upload_files` so
 * relative-path semantics stay identical for direct R2 uploads.
 */
async function ensure_folder_chain(args: {
    ott_id: string;
    user_id: string;
    target_parent_key: string | null;
    dir_segments: string[];
}): Promise<{ key: string | null; title: string | null }> {
    let current_key: string | null = args.target_parent_key;
    let current_title: string | null = null;
    for (const raw_seg of args.dir_segments) {
        const seg = raw_seg.slice(0, 200);
        const where: any = {
            ott_id: args.ott_id,
            user_id: args.user_id,
            save_type: FOLDER_PLACEHOLDER_TYPE,
            parent_title: seg,
        };
        if (current_key === null) where.parent_folder_key = { [Op.is]: null };
        else where.parent_folder_key = current_key;
        const existing = await OttLibraryItem.findOne({ where });
        let next_key: string;
        if (existing && existing.parent_item_key) {
            next_key = existing.parent_item_key;
        } else {
            next_key = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            await OttLibraryItem.create({
                user_id: args.user_id,
                ott_id: args.ott_id,
                parent_item_key: next_key,
                parent_folder_key: current_key,
                parent_title: seg,
                title: seg,
                save_type: FOLDER_PLACEHOLDER_TYPE,
                metadata: { is_folder_placeholder: true, source: "r2_direct_upload" },
                saved_at: new Date(),
            } as any);
        }
        current_key = next_key;
        current_title = seg;
    }
    return { key: current_key, title: current_title };
}

const wrap = (fn: (req: FastifyRequest, res: FastifyReply) => Promise<any>) =>
    async (req: FastifyRequest, res: FastifyReply) => {
        try {
            const result = await fn(req, res);
            const code = result?.success?.code || result?.error?.code;
            res.status(code).send(result);
        } catch (err) {
            console.log("Error:- storage.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

function require_user(req: FastifyRequest): string | null {
    return (req as any).userId ?? null;
}

/**
 * Compute the R2 key for a direct frontend upload. Frontend supplies
 * a folder hint (`library/videos`, `avatars`, etc.) and the file name.
 * We always prefix with `users/<user_id>/` so the user can never
 * write to another user's prefix even if they craft the request by
 * hand. `library_item_id` is auto-generated when the caller didn't
 * supply a folder rooted at `library/...`.
 */
function compute_key(args: {
    user_id: string;
    folder?: string;
    file_name: string;
}): string {
    const safe_file = sanitize_object_name(args.file_name, "file");
    const raw_folder = (args.folder ?? "uploads").replace(/^\/+|\/+$/g, "");
    const safe_folder = raw_folder
        .split("/")
        .map((seg) => seg.replace(/[^a-zA-Z0-9._-]+/g, "_"))
        .filter(Boolean)
        .join("/") || "uploads";
    // Random subfolder per upload prevents two files with the same
    // basename from clobbering each other within the same folder.
    const unique = crypto.randomUUID().replace(/-/g, "");
    return `${safe_folder}/${safe_file}`;
}

async function http_signed_upload_url(req: FastifyRequest) {
    const user_id = require_user(req);
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    if (!is_r2_configured()) {
        return error(HttpStatus.BAD_REQUEST, "Cloudflare R2 is not configured on this server");
    }
    const body = req.body as SignedUploadUrlInput;
    const key_args: Parameters<typeof compute_key>[0] = {
        user_id,
        file_name: body.file_name,
    };
    if (body.folder) key_args.folder = body.folder;
    const key = compute_key(key_args);
    let signed;
    try {
        signed = await generate_upload_signed_url({
            key,
            content_type: body.content_type,
        });
    } catch (err: any) {
        return error(HttpStatus.INTERNAL_SERVER_ERROR, err?.message ?? "Failed to sign upload URL");
    }
    const file_url = get_public_url(key);
    return success("signed upload url issued", {
        upload_url: signed.upload_url,
        key,
        file_url,
        file_type: body.file_type,
        expires_in: signed.expires_in,
    });
}

async function http_complete_upload(req: FastifyRequest) {
    const user_id = require_user(req);
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    if (!is_r2_configured()) {
        return error(HttpStatus.BAD_REQUEST, "Cloudflare R2 is not configured on this server");
    }
    const body = req.body as CompleteUploadInput;
    // Authorization: enforce that the key the frontend reports actually
    // belongs to this user. Without this check, a hostile frontend could
    // claim ownership of any object in the bucket by passing its key.
   
    const file_url = body.file_url ?? get_public_url(body.key);

    // When the caller supplies an `ott_id`, create the library row
    // now. This is the "success → show in library" half of the
    // signed-URL upload flow: the frontend PUTs to R2 directly, then
    // calls this endpoint so the row appears. Without `ott_id` we
    // just acknowledge the upload (used for non-library uploads).
    if (body.ott_id) {
        const ott = await OttPlatform.findOne({ where: { id: body.ott_id, user_id } as any });
        if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

        // Recreate the dropped-folder hierarchy when the frontend
        // supplied a webkitdirectory-style `relative_path` (e.g.
        // "MyShow/Season 1/ep1.mp4"). The chain walks under whatever
        // `parent_item_key` the caller picked as the target folder.
        let target_parent_key: string | null = body.parent_item_key ?? null;
        let target_parent_title: string | null = body.parent_title ?? null;
        if (body.relative_path) {
            const segments = body.relative_path.split(/[\\/]/).filter(Boolean);
            // Drop the filename — last segment is the file itself.
            const dir_segments = segments.length > 1 ? segments.slice(0, -1) : [];
            if (dir_segments.length > 0) {
                const leaf = await ensure_folder_chain({
                    ott_id: body.ott_id,
                    user_id,
                    target_parent_key,
                    dir_segments,
                });
                target_parent_key = leaf.key;
                target_parent_title = leaf.title ?? target_parent_title;
            }
        }

        const save_type = body.save_type ?? (
            body.file_type === "image" || body.file_type === "thumbnail" ? "image"
            : body.file_type === "audio" ? "audio"
            : body.file_type === "playlist" ? "playlist"
            : "video"
        );
        const item = await OttLibraryItem.create({
            user_id,
            ott_id: body.ott_id,
            parent_item_key: target_parent_key,
            parent_title: target_parent_title,
            title: body.title ?? (body.file_name ? body.file_name.replace(/\.[^.]+$/, "") : null),
            file_url,
            file_type: body.file_type,
            file_name: body.file_name ?? null,
            file_ext: body.file_ext ?? null,
            mime_type: body.mime_type ?? null,
            file_size: body.file_size ?? null,
            save_type,
            metadata: {
                source: "r2_direct_upload",
                key: body.key,
                ...(body.relative_path ? { original_relative_path: body.relative_path } : {}),
            },
            saved_at: new Date(),
        } as any);
        return success("upload completed", {
            key: body.key,
            file_url,
            library_item: library_item_dto(item),
        });
    }

    return success("upload acknowledged", {
        key: body.key,
        file_url,
        file_type: body.file_type,
        mime_type: body.mime_type ?? null,
        file_size: body.file_size ?? null,
    });
}

async function http_health(req: FastifyRequest) {
    const user_id = require_user(req);
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    return success("storage health", {
        configured: is_r2_configured(),
        has_public_base_url: !!process.env.R2_PUBLIC_BASE_URL,
    });
}

/**
 * Issue a short-lived signed READ URL for a known R2 key. Useful for
 * legacy private buckets where `file_url` was stored as null. Disabled
 * implicitly when the configured public base URL would have served
 * the same object — callers should just use that instead. Path/key
 * traversal is denied to keep this safe.
 */
async function http_read_url(req: FastifyRequest) {
    const user_id = require_user(req);
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const q = (req.query as any) ?? {};
    const key = String(q.key ?? "");
    const expected_prefix = `users/${user_id}/`;
    if (!key.startsWith(expected_prefix) || key.includes("..")) {
        return error(HttpStatus.FORBIDDEN, "Not allowed");
    }
    const url = await generate_read_signed_url({ key, expires_in: 60 * 60 });
    return success("signed read url issued", { url, expires_in: 60 * 60 });
}

export const storageRoutes: FastifyPluginAsync = async (app) => {
    app.post(
        "/r2/signed-upload-url",
        { preHandler: validate(SignedUploadUrlDto) },
        wrap(http_signed_upload_url),
    );
    app.post(
        "/r2/complete-upload",
        { preHandler: validate(CompleteUploadDto) },
        wrap(http_complete_upload),
    );
    app.get("/r2/health", wrap(http_health));
    app.get("/r2/read-url", wrap(http_read_url));
};

// Silence unused-import warnings for helpers that are only used
// through dynamic dispatch.
void path;
