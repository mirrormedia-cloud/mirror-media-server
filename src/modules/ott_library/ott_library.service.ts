/**
 * Library service — post-R2-migration.
 *
 * Previously the file ran a download → ffmpeg → Drive-upload pipeline
 * with a status state machine (`initiate / pending / downloading /
 * ready_for_drive / uploading_on_drive / completed / failed`), a
 * per-user concurrency queue, an HLS enhancement layer, and a
 * boot-time Drive sweeper. All of that is gone — see the git history
 * if you need to bring any of it back.
 *
 * New contract: a library row exists *only* when an R2 upload
 * succeeded. There are no intermediate states, no retry counters, no
 * Drive identifiers.
 *
 * Save endpoints (`save_video_asset_to_library`, `save_bulk_…`,
 * `save_from_cards`) now:
 *   1. Download the source bytes to a local temp file (axios stream).
 *   2. Upload the temp file to R2 via the S3-compatible SDK.
 *   3. Insert the `OttLibraryItem` row only after R2 confirms.
 *   4. Clean up the temp file.
 * Failure at any step throws; no DB row is written.
 *
 * Local Uploads (user-picked files) follow the signed-URL path —
 * see `library_browser/local_uploads_crud.service.ts`.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import axios from "axios";
import fs from "fs";
import path from "path";
import { Op, literal, QueryTypes } from "sequelize";
import { sequelize } from "../../db";
import {
    OttPlatform,
    OttApiNode,
    OttApiResponse,
    OttChildApiItemResponse,
    OttVideoAsset,
    OttLibraryItem,
} from "../../db/models";
import { config } from "../../config";
import {
    get_value_by_path,
    replace_array_index_in_path,
} from "../../utils/response_path_utils";
import { detect_video_type } from "../ott_video_assets/ott_video_assets.service";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import type {
    SaveToLibraryInput,
    SaveBulkToLibraryInput,
    ListLibraryQueryInput,
} from "./ott_library.dto";
import { upload_library_item_to_r2, is_r2_configured, delete_item_r2_object } from "./ott_library_r2.service";
import { alloc_temp_dir, temp_file_path, delete_temp_dir } from "../../utils/temp_storage";
import { ext_from_url, ext_from_content_type, file_size as get_file_size } from "../../utils/library_storage";
import { convert_to_mp4, FfmpegMissingError, resolve_hls_highest_variant } from "../../utils/ffmpeg";

function ts(value: any): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function build_url(p: string): string {
    const raw = String(config.file?.access_url ?? "").trim();
    let origin = "";
    try { if (raw) origin = new URL(raw).origin; } catch { /* noop */ }
    if (!origin || origin.includes("undefined") || origin.includes("null")) {
        origin = `http://localhost:${config.app?.port ?? 3002}`;
    }
    return `${origin}${p}`;
}

// ── DTO ────────────────────────────────────────────────────────────────

/**
 * Trimmed DTO. Only emits fields the post-R2 schema still has plus
 * derived URLs that the frontend uses. All Drive / status / HLS /
 * local-path fields are gone — readers should depend on `file_url`
 * and `file_type` exclusively.
 */
export function library_item_dto(l: OttLibraryItem, ottName?: string | null, folderPath?: string | null) {
    const file_url = l.file_url ?? null;
    const file_type = l.file_type ?? null;
    const is_video_kind = file_type === "video"
        || file_type === "playlist"
        || l.save_type === "video"
        || l.save_type === "playlist"
        || (l.mime_type ?? "").startsWith("video/");

    // The library page used to show thumbnails via Drive CDN URLs;
    // now it just falls back to the upstream `thumbnail_url` /
    // `image_url` for items whose own `file_url` is the main video.
    const is_thumb_kind = file_type === "thumbnail" || file_type === "image";
    const thumbnail_display_url = is_thumb_kind
        ? (file_url ?? l.thumbnail_url ?? l.image_url ?? null)
        : (l.thumbnail_url ?? l.image_url ?? null);

    // Legacy download/stream routes still work for compat but resolve
    // to a redirect-to-file_url inside the handlers.
    const download_url = file_url ? build_url(`/api/ott/${l.ott_id}/library/${l.id}/download`) : null;
    const stream_url = file_url ? build_url(`/api/ott/${l.ott_id}/library/${l.id}/stream`) : null;

    return {
        id: l.id,
        ott_id: l.ott_id,
        video_asset_id: l.video_asset_id ?? null,
        api_node_id: l.api_node_id ?? null,
        source_response_id: l.source_response_id ?? null,
        parent_api_id: l.parent_api_id ?? null,
        item_key: l.item_key ?? null,
        parent_item_key: l.parent_item_key ?? null,
        parent_title: l.parent_title ?? null,
        folder_path: folderPath ?? (ottName && l.parent_title
            ? `${ottName}/${l.parent_title}`
            : (l.parent_title ?? null)),
        title: l.title ?? null,
        description: l.description ?? null,
        thumbnail_url: l.thumbnail_url ?? null,
        image_url: l.image_url ?? null,
        original_video_url: l.original_video_url ?? null,
        original_video_type: l.original_video_type ?? null,
        file_url,
        file_type,
        thumbnail_display_url,
        playback_url: file_url,
        download_url,
        stream_url,
        file_name: l.file_name ?? null,
        file_ext: l.file_ext ?? null,
        mime_type: l.mime_type ?? null,
        file_size: l.file_size ?? null,
        duration: l.duration ?? null,
        quality: l.quality ?? null,
        language: l.language ?? null,
        save_type: l.save_type,
        is_video: is_video_kind,
        metadata: l.metadata ?? {},
        savedAt: ts(l.saved_at),
        createdAt: ts((l as any).createdAt),
        updatedAt: ts((l as any).updatedAt),
        deletedAt: ts((l as any).deletedAt),
    };
}

// ── Helpers (OTT save path) ────────────────────────────────────────────

function build_request_headers(ott: OttPlatform): Record<string, string> {
    const headers: Record<string, string> = {};
    const stored = (ott.headers || {}) as Record<string, any>;
    for (const [k, v] of Object.entries(stored)) {
        if (!k || v === undefined || v === null) continue;
        const cleaned = String(k).trim().replace(/^["']|["']$/g, "");
        if (cleaned) headers[cleaned] = String(v);
    }
    if (!headers["User-Agent"] && !headers["user-agent"]) {
        headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119";
    }
    if (ott.cookie_string) headers["Cookie"] = ott.cookie_string;
    return headers;
}

const STREAM_TYPES = new Set(["m3u8", "mpd"]);
const DIRECT_VIDEO_TYPES = new Set(["mp4", "webm", "mov", "mkv", "ts"]);

interface SaveOptions {
    save_video: boolean;
    save_image: boolean;
    save_thumbnail: boolean;
    convert_to_mp4: boolean;
}
function default_options(input?: Record<string, any> | null | undefined): SaveOptions {
    return {
        save_video: input?.save_video !== false,
        save_image: input?.save_image !== false,
        save_thumbnail: input?.save_thumbnail !== false,
        convert_to_mp4: input?.convert_to_mp4 !== false,
    };
}

async function download_to_file(args: {
    url: string;
    headers: Record<string, string>;
    absolute_path: string;
}): Promise<{ content_type: string | undefined; file_size: number }> {
    const res = await axios.get(args.url, {
        headers: args.headers,
        responseType: "stream",
        // No timeout — large library downloads must run to completion.
        timeout: 0,
        validateStatus: () => true,
    });
    if (res.status >= 400) throw new Error(`Upstream HTTP ${res.status} for ${args.url}`);
    await new Promise<void>((resolve, reject) => {
        const w = fs.createWriteStream(args.absolute_path);
        res.data.on("error", reject);
        w.on("error", reject);
        w.on("finish", resolve);
        res.data.pipe(w);
    });
    return {
        content_type: res.headers["content-type"] as string | undefined,
        file_size: get_file_size(args.absolute_path) ?? 0,
    };
}

/**
 * Run the full OTT-scrape pipeline synchronously: download (and
 * optionally ffmpeg-convert) the upstream video, push the local
 * file to R2, return the resulting `file_url` + `file_type` so the
 * caller can either persist a fresh row or update an existing one.
 *
 * Throws on any failure — caller decides whether to surface the
 * error to the user or skip the asset.
 */
async function build_r2_payload_for_asset(args: {
    ott: OttPlatform;
    user_id: string;
    library_item_id: string;
    asset: OttVideoAsset;
    options: SaveOptions;
}): Promise<{
    file_url: string | null;
    file_type: string;
    file_name: string;
    file_ext: string;
    mime_type: string;
    file_size: number | null;
    r2_key: string;
}> {
    if (!is_r2_configured()) {
        throw new Error("Cloudflare R2 is not configured. Set R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME first.");
    }
    const { ott, user_id, library_item_id, asset, options } = args;
    const headers = build_request_headers(ott);
    const url = asset.video_url!;
    const video_type = (asset.video_type ?? "").toLowerCase();
    const base = (asset.title || "video").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120) || "video";

    const { dir: temp_dir } = alloc_temp_dir(ott.id!, library_item_id);
    try {
        let local_path: string;
        let ext: string;
        let mime: string;

        if (DIRECT_VIDEO_TYPES.has(video_type)) {
            ext = video_type;
            local_path = temp_file_path(temp_dir, `${base}.${ext}`);
            const r = await download_to_file({ url, headers, absolute_path: local_path });
            mime = r.content_type ?? `video/${ext}`;
        } else if (STREAM_TYPES.has(video_type)) {
            const hi_url = video_type === "m3u8" ? await resolve_hls_highest_variant({ url, headers }) : url;
            if (!options.convert_to_mp4) {
                ext = video_type;
                local_path = temp_file_path(temp_dir, `${base}.${ext}`);
                const r = await download_to_file({ url: hi_url, headers, absolute_path: local_path });
                mime = r.content_type ?? "application/vnd.apple.mpegurl";
            } else {
                ext = "mp4";
                local_path = temp_file_path(temp_dir, `${base}.mp4`);
                try {
                    await convert_to_mp4({ input_url: hi_url, output_path: local_path, headers });
                } catch (e: any) {
                    if (e instanceof FfmpegMissingError) throw e;
                    // Try the heavy re-encode fallback once.
                    await convert_to_mp4({ input_url: hi_url, output_path: local_path, headers, reencode: true });
                }
                mime = "video/mp4";
            }
        } else {
            throw new Error(`Unsupported video_type "${video_type}"`);
        }

        const safe_file_name = `${base}.${ext}`;
        const r2 = await upload_library_item_to_r2({
            ott_id: ott.id!,
            user_id,
            library_item_id,
            file_path: local_path,
            file_name: safe_file_name,
            mime_type: mime,
            folder: video_type && STREAM_TYPES.has(video_type) && !options.convert_to_mp4 ? "playlists" : "videos",
        });

        return {
            file_url: r2.main.file_url,
            file_type: video_type && STREAM_TYPES.has(video_type) && !options.convert_to_mp4 ? "playlist" : "video",
            file_name: safe_file_name,
            file_ext: ext,
            mime_type: mime,
            file_size: r2.main.size ?? get_file_size(local_path) ?? null,
            r2_key: r2.main.key,
        };
    } finally {
        delete_temp_dir(temp_dir);
    }
}

// ── Save endpoints (OTT scrape) ────────────────────────────────────────

async function get_or_create_row_for_asset(args: {
    ott: OttPlatform;
    asset: OttVideoAsset;
    user_id: string;
}): Promise<{ item: OttLibraryItem; created: boolean }> {
    const { ott, asset, user_id } = args;
    const existing = await OttLibraryItem.findOne({
        where: { ott_id: ott.id, original_video_url: asset.video_url } as any,
        paranoid: false,
    });
    if (existing) {
        if ((existing as any).deletedAt) await existing.restore();
        return { item: existing, created: false };
    }
    const item = await OttLibraryItem.create({
        user_id,
        ott_id: ott.id,
        video_asset_id: asset.id,
        api_node_id: asset.api_node_id ?? null,
        source_response_id: asset.source_response_id ?? null,
        parent_api_id: asset.parent_api_id ?? null,
        item_key: asset.item_key ?? null,
        title: asset.title ?? null,
        description: asset.description ?? null,
        thumbnail_url: asset.thumbnail ?? null,
        image_url: asset.thumbnail ?? null,
        original_video_url: asset.video_url ?? null,
        original_video_type: asset.video_type ?? null,
        quality: asset.quality ?? null,
        language: asset.language ?? null,
        duration: asset.duration ?? null,
        save_type: "video",
        metadata: {},
    } as any);
    return { item, created: true };
}

/**
 * Synchronously run download → R2 upload for a single asset. Inserts
 * (or updates) the library row only when R2 succeeds. On failure the
 * placeholder row created by `get_or_create_row_for_asset` is rolled
 * back (hard-deleted) so the user sees nothing — that's the new
 * "success-or-not-shown" contract.
 */
async function process_asset_to_r2(args: {
    ott: OttPlatform;
    user_id: string;
    asset: OttVideoAsset;
    options: SaveOptions;
}): Promise<OttLibraryItem> {
    const { ott, user_id, asset, options } = args;
    const { item, created } = await get_or_create_row_for_asset({ ott, asset, user_id });
    // Already has a file_url → leave as-is.
    if (item.file_url) return item;
    try {
        const payload = await build_r2_payload_for_asset({
            ott, user_id, library_item_id: item.id, asset, options,
        });
        await item.update({
            file_url: payload.file_url,
            file_type: payload.file_type,
            file_name: payload.file_name,
            file_ext: payload.file_ext,
            mime_type: payload.mime_type,
            file_size: payload.file_size,
            saved_at: new Date(),
            metadata: { ...(item.metadata as any ?? {}), r2_key: payload.r2_key },
        } as any);
        return item;
    } catch (err: any) {
        // No-status contract: if the upload failed, delete the
        // placeholder so the library never shows a broken row.
        if (created) {
            try { await item.destroy({ force: true }); } catch { /* noop */ }
        }
        throw err;
    }
}

export async function save_video_asset_to_library(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id } = req.params as { ott_id: string };
    const body = req.body as SaveToLibraryInput;
    const opts = default_options(body);

    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const asset = await OttVideoAsset.findOne({ where: { id: body.video_asset_id, ott_id } as any });
    if (!asset) return error(HttpStatus.NOT_FOUND, "Video asset not found");

    try {
        const item = await process_asset_to_r2({ ott, user_id, asset, options: opts });
        return success("library save completed", library_item_dto(item));
    } catch (err: any) {
        return error(HttpStatus.INTERNAL_SERVER_ERROR, err?.message ?? "R2 upload failed");
    }
}

export async function save_bulk_video_assets_to_library(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id } = req.params as { ott_id: string };
    const body = req.body as SaveBulkToLibraryInput;
    const opts = default_options(body);

    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const assets = await OttVideoAsset.findAll({ where: { id: { [Op.in]: body.video_asset_ids }, ott_id } as any });

    const items: OttLibraryItem[] = [];
    const failures: Array<{ asset_id: string; error: string }> = [];
    for (const asset of assets) {
        try {
            const item = await process_asset_to_r2({ ott, user_id, asset, options: opts });
            items.push(item);
        } catch (err: any) {
            failures.push({ asset_id: asset.id, error: err?.message ?? "failed" });
        }
    }
    return success("bulk save completed", {
        total: body.video_asset_ids.length,
        succeeded: items.length,
        failed: failures.length,
        failures,
        items: items.map(item => library_item_dto(item)),
    });
}

// ── save_from_cards (existing capture flow) ────────────────────────────

async function load_source_response_for_node(args: {
    api_node_id: string;
    source_response_id?: string | null;
}): Promise<any | null> {
    if (args.source_response_id) {
        const child = await OttChildApiItemResponse.findByPk(args.source_response_id);
        if (child) return child.response;
        const root = await OttApiResponse.findByPk(args.source_response_id);
        if (root) return root.response;
    }
    const root = await OttApiResponse.findOne({ where: { api_node_id: args.api_node_id } as any });
    if (root) return root.response;
    const child = await OttChildApiItemResponse.findOne({
        where: { child_api_id: args.api_node_id } as any,
        order: [["called_at", "DESC"]],
    });
    if (child) return child.response;
    return null;
}

interface CaptureMapping {
    list_path?: string | null;
    video_url_paths: string[];
    title_path?: string | null;
    description_path?: string | null;
    thumbnail_path?: string | null;
    quality_path?: string | null;
    language_path?: string | null;
    duration_path?: string | null;
    save_video?: boolean;
    save_image?: boolean;
    save_thumbnail?: boolean;
    convert_to_mp4?: boolean;
}

async function capture_assets_for_card_index(args: {
    ott_id: string;
    api_node: OttApiNode;
    response: any;
    mapping: CaptureMapping;
    card_index: number;
}): Promise<OttVideoAsset[]> {
    const { ott_id, api_node, response, mapping, card_index } = args;
    const list_path = mapping.list_path ?? api_node.list_path ?? "";
    const out: OttVideoAsset[] = [];
    const get = (raw_path: string | null | undefined): string | null => {
        if (!raw_path) return null;
        const idx_path = replace_array_index_in_path(raw_path, card_index);
        const value = get_value_by_path(response, idx_path);
        if (value === undefined || value === null) return null;
        return typeof value === "string" ? value : String(value);
    };
    for (const raw_url_path of mapping.video_url_paths) {
        const url_path = replace_array_index_in_path(raw_url_path, card_index);
        const url_value = get_value_by_path(response, url_path);
        if (typeof url_value !== "string" || !url_value) continue;
        const existing = await OttVideoAsset.findOne({ where: { ott_id, video_url: url_value } as any });
        if (existing) { out.push(existing); continue; }
        const created = await OttVideoAsset.create({
            ott_id,
            api_node_id: api_node.id,
            source_response_id: null,
            parent_api_id: api_node.parent_id ?? null,
            item_key: null,
            title: get(mapping.title_path),
            description: get(mapping.description_path),
            thumbnail: get(mapping.thumbnail_path),
            video_url: url_value,
            video_type: detect_video_type(url_value),
            quality: get(mapping.quality_path),
            language: get(mapping.language_path),
            duration: get(mapping.duration_path),
            metadata: { source_path: raw_url_path, card_index, list_path, from_save_from_cards: true },
            status: "active",
        } as any);
        out.push(created);
    }
    return out;
}

export async function save_from_cards(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id } = req.params as { ott_id: string };
    const body = req.body as import("./ott_library.dto").SaveFromCardsInput;

    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const node = await OttApiNode.findOne({ where: { id: body.api_node_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    const mapping = (node.card_config as any)?.capture_mapping as CaptureMapping | undefined;
    if (!mapping || !Array.isArray(mapping.video_url_paths) || mapping.video_url_paths.length === 0) {
        return error(HttpStatus.BAD_REQUEST, "Capture mapping is not configured for this API.");
    }

    const load_args: Parameters<typeof load_source_response_for_node>[0] = {
        api_node_id: body.api_node_id,
    };
    if (body.source_response_id) load_args.source_response_id = body.source_response_id;
    const response = await load_source_response_for_node(load_args);
    if (!response) return error(HttpStatus.BAD_REQUEST, "No saved response found for this API");

    const opts: SaveOptions = {
        save_video: body.save_video ?? mapping.save_video ?? true,
        save_image: body.save_image ?? mapping.save_image ?? true,
        save_thumbnail: body.save_thumbnail ?? mapping.save_thumbnail ?? true,
        convert_to_mp4: body.convert_to_mp4 ?? mapping.convert_to_mp4 ?? true,
    };

    const items: OttLibraryItem[] = [];
    const failures: Array<{ card_index: number; error: string }> = [];
    let no_url = 0;
    for (const card_index of body.card_indices) {
        const assets = await capture_assets_for_card_index({
            ott_id, api_node: node, response, mapping, card_index,
        });
        if (assets.length === 0) { no_url += 1; continue; }
        for (const asset of assets) {
            try {
                const item = await process_asset_to_r2({ ott, user_id, asset, options: opts });
                // Backfill folder grouping from request body if provided.
                if (body.parent_item_key && !item.parent_item_key) {
                    await item.update({
                        parent_item_key: body.parent_item_key,
                        parent_title: body.parent_title ?? null,
                        parent_api_id: body.parent_api_id ?? null,
                    } as any);
                }
                items.push(item);
            } catch (err: any) {
                failures.push({ card_index, error: err?.message ?? "failed" });
            }
        }
    }
    return success("save_from_cards completed", {
        total: body.card_indices.length,
        succeeded: items.length,
        failed: failures.length,
        no_url,
        failures,
        items: items.map(item => library_item_dto(item)),
    });
}

// ── List / get / delete ────────────────────────────────────────────────

function order_for_sort(sort_by: ListLibraryQueryInput["sort_by"]): any[] {
    switch (sort_by) {
        case "oldest": return [["createdAt", "ASC"]];
        case "title_asc": return [literal(`regexp_replace("title", '(\\d+)', lpad('\\1', 10, '0'), 'g') ASC NULLS LAST`)];
        case "title_desc": return [literal(`regexp_replace("title", '(\\d+)', lpad('\\1', 10, '0'), 'g') DESC NULLS LAST`)];
        case "size_desc": return [literal('"file_size" DESC NULLS LAST')];
        case "size_asc": return [literal('"file_size" ASC NULLS LAST')];
        case "newest":
        default: return [["createdAt", "DESC"]];
    }
}

export async function get_library_items(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id } = req.params as { ott_id: string };
    const query = (req.query || {}) as ListLibraryQueryInput;
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const where: any = {
        ott_id,
        save_type: { [Op.ne]: "folder_placeholder" },
        // Success-or-not-shown: only rows with an actual `file_url` are
        // visible. There is no `status` column anymore.
        file_url: { [Op.not]: null } as any,
    };
    if (query.type) where.save_type = query.type;
    if (query.search) {
        const like = `%${query.search}%`;
        where[Op.or] = [
            { title: { [Op.iLike]: like } },
            { original_video_url: { [Op.iLike]: like } },
            { file_name: { [Op.iLike]: like } },
        ];
    }
    if (query.parent_item_key) {
        where.parent_item_key = query.parent_item_key;
        if (query.parent_api_id) where.parent_api_id = query.parent_api_id;
    } else if (query.ungrouped_only) {
        where.parent_item_key = { [Op.is]: null } as any;
    }

    const { rows, count } = await OttLibraryItem.findAndCountAll({
        where,
        order: order_for_sort(query.sort_by),
        limit,
        offset: (page - 1) * limit,
    });

    // Build a full nested-path map from folder_placeholder rows so that items
    // inside nested local-upload folders (e.g. "media/reel") get the correct
    // folder_path instead of just the leaf parent_title.
    const placeholders = await OttLibraryItem.findAll({
        where: { ott_id, save_type: "folder_placeholder" } as any,
        attributes: ["parent_item_key", "parent_folder_key", "parent_title", "title"],
    });
    type PhEntry = { title: string; parent_folder_key: string | null };
    const phMap = new Map<string, PhEntry>();
    for (const ph of placeholders) {
        const key = ph.parent_item_key;
        if (key) {
            phMap.set(key, {
                title: (ph.parent_title || ph.title || "Folder") as string,
                parent_folder_key: (ph.parent_folder_key as string | null) ?? null,
            });
        }
    }
    function full_folder_path(parent_item_key: string | null): string | null {
        if (!parent_item_key) return null;
        const segments: string[] = [];
        let cur: string | null = parent_item_key;
        for (let i = 0; i < 50 && cur; i++) {
            const entry = phMap.get(cur);
            if (!entry) break;
            segments.unshift(entry.title);
            cur = entry.parent_folder_key;
        }
        return segments.length > 0 ? segments.join("/") : null;
    }

    return success("library fetched", {
        items: rows.map((row) => {
            const folderPath = full_folder_path(row.parent_item_key ?? null);
            return library_item_dto(row, ott.name, folderPath);
        }),
        pagination: { page, limit, total: count },
    });
}

export async function get_library_item(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id, library_item_id } = req.params as { ott_id: string; library_item_id: string };
    const [item, ott] = await Promise.all([
        OttLibraryItem.findOne({ where: { id: library_item_id, ott_id, user_id } as any }),
        OttPlatform.findOne({ where: { id: ott_id, user_id } as any }),
    ]);
    if (!item) return error(HttpStatus.NOT_FOUND, "Library item not found");

    let folderPath: string | null = null;
    if (item.parent_item_key) {
        const placeholders = await OttLibraryItem.findAll({
            where: { ott_id, save_type: "folder_placeholder" } as any,
            attributes: ["parent_item_key", "parent_folder_key", "parent_title", "title"],
        });
        type PhEntry = { title: string; parent_folder_key: string | null };
        const phMap = new Map<string, PhEntry>();
        for (const ph of placeholders) {
            const key = ph.parent_item_key;
            if (key) phMap.set(key, { title: (ph.parent_title || ph.title || "Folder") as string, parent_folder_key: (ph.parent_folder_key as string | null) ?? null });
        }
        const segments: string[] = [];
        let cur: string | null = item.parent_item_key;
        for (let i = 0; i < 50 && cur; i++) {
            const entry = phMap.get(cur);
            if (!entry) break;
            segments.unshift(entry.title);
            cur = entry.parent_folder_key;
        }
        folderPath = segments.length > 0 ? segments.join("/") : null;
    }

    return success("library item fetched", library_item_dto(item, ott?.name, folderPath));
}

export async function delete_library_item(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id, library_item_id } = req.params as { ott_id: string; library_item_id: string };
    const item = await OttLibraryItem.findOne({
        where: { id: library_item_id, ott_id, user_id } as any,
        paranoid: false,
    } as any);
    if (!item) return error(HttpStatus.NOT_FOUND, "Library item not found");
    await delete_item_r2_object(item);
    await item.destroy({ force: true });
    return success("library item deleted", { id: library_item_id, deleted_items: 1 });
}

export async function bulk_delete_library_items(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id } = req.params as { ott_id: string };
    const body = (req.body ?? {}) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
        ? body.ids.filter((v): v is string => typeof v === "string" && v.length > 0)
        : [];
    if (ids.length === 0) return error(HttpStatus.BAD_REQUEST, "ids must be a non-empty array");

    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const items = await OttLibraryItem.findAll({
        where: { id: { [Op.in]: ids }, ott_id, user_id } as any,
        paranoid: false,
    } as any);
    const found = new Set(items.map(i => i.id));
    const missing_ids = ids.filter(id => !found.has(id));
    let deleted = 0;
    const failed: Array<{ id: string; error: string }> = [];
    for (const i of items) {
        try {
            await delete_item_r2_object(i);
            await i.destroy({ force: true });
            deleted += 1;
        }
        catch (err: any) { failed.push({ id: i.id, error: err?.message ?? "delete failed" }); }
    }
    return success(`Deleted ${deleted} item(s)`, {
        requested: ids.length, deleted_items: deleted, missing_ids, failed,
    });
}

export async function bulk_delete_library_folders(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id } = req.params as { ott_id: string };
    const body = (req.body ?? {}) as { folders?: Array<{ parent_item_key?: string | null; parent_api_id?: string | null }> };
    const folders = Array.isArray(body.folders) ? body.folders : [];
    if (folders.length === 0) return error(HttpStatus.BAD_REQUEST, "folders must be a non-empty array");

    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    let total_deleted = 0;
    const folder_results: Array<{ parent_item_key: string | null; parent_api_id: string | null; deleted: number; failed: number }> = [];
    for (const f of folders) {
        const where: any = { ott_id, user_id };
        if (f.parent_item_key === null || f.parent_item_key === undefined) {
            where.parent_item_key = { [Op.is]: null };
        } else {
            where.parent_item_key = f.parent_item_key;
            if (f.parent_api_id) where.parent_api_id = f.parent_api_id;
        }
        const rows = await OttLibraryItem.findAll({ where, paranoid: false } as any);
        let deleted = 0, failed = 0;
        for (const r of rows) {
            try {
                await delete_item_r2_object(r);
                await r.destroy({ force: true });
                deleted += 1;
            }
            catch { failed += 1; }
        }
        total_deleted += deleted;
        folder_results.push({
            parent_item_key: f.parent_item_key ?? null,
            parent_api_id: f.parent_api_id ?? null,
            deleted, failed,
        });
    }
    return success("folder records deleted", {
        requested_folders: folders.length,
        deleted_items: total_deleted,
        total_deleted,
        folders: folder_results,
    });
}

// ── Folder grid (used by LibraryBrowserPage) ───────────────────────────

export async function get_library_folders(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { ott_id } = req.params as { ott_id: string };

    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    // Aggregate by parent_item_key. Count any row with at least one
    // downloadable URL (file_url, image_url, or download_url) so that
    // items captured before R2 migration are still counted.
    const rows = await OttLibraryItem.findAll({
        where: {
            ott_id,
            save_type: { [Op.ne]: "folder_placeholder" },
            [Op.or]: [
                { file_url: { [Op.not]: null } },
                { image_url: { [Op.not]: null } },
            ],
        } as any,
        attributes: ["parent_item_key", "parent_title", "parent_api_id", "thumbnail_url", "title"],
    });
    const buckets = new Map<string, {
        parent_item_key: string | null;
        parent_title: string | null;
        first_item_title: string | null;
        parent_api_id: string | null;
        count: number;
        thumb: string | null;
    }>();
    for (const r of rows) {
        const key = r.parent_item_key ?? "__ungrouped__";
        const existing = buckets.get(key);
        if (existing) {
            existing.count += 1;
            if (!existing.thumb && r.thumbnail_url) existing.thumb = r.thumbnail_url;
        } else {
            buckets.set(key, {
                parent_item_key: r.parent_item_key ?? null,
                parent_title: r.parent_title ?? null,
                first_item_title: (r as any).title ?? null,
                parent_api_id: r.parent_api_id ?? null,
                count: 1,
                thumb: r.thumbnail_url ?? null,
            });
        }
    }
    return success("library folders", {
        folders: Array.from(buckets.values()).map(b => ({
            parent_item_key: b.parent_item_key,
            parent_title: b.parent_title,
            title: b.parent_title ?? b.first_item_title ?? b.parent_item_key ?? "Unnamed",
            parent_api_id: b.parent_api_id,
            item_count: b.count,
            thumbnail_url: b.thumb,
            completed_count: 0,
            failed_count: 0,
            in_progress_count: 0,
            latest_at: null,
        })),
    });
}

// ── Download / Stream (redirect to file_url) ───────────────────────────

async function find_owned(req: FastifyRequest) {
    const user_id = (req as any).userId;
    const { ott_id, library_item_id } = req.params as { ott_id: string; library_item_id: string };
    if (!user_id) return null;
    return OttLibraryItem.findOne({ where: { id: library_item_id, ott_id, user_id } as any });
}

export async function download_library_item(req: FastifyRequest, reply: FastifyReply) {
    const item = await find_owned(req);
    if (!item) {
        return reply.status(HttpStatus.NOT_FOUND).send(error(HttpStatus.NOT_FOUND, "Library item not found"));
    }
    if (!item.file_url) {
        return reply.status(HttpStatus.NOT_FOUND).send(error(HttpStatus.NOT_FOUND, "Library item has no file"));
    }
    return reply.redirect(item.file_url, 302);
}

export async function stream_library_item(req: FastifyRequest, reply: FastifyReply) {
    const item = await find_owned(req);
    if (!item) {
        return reply.status(HttpStatus.NOT_FOUND).send(error(HttpStatus.NOT_FOUND, "Library item not found"));
    }
    if (!item.file_url) {
        return reply.status(HttpStatus.NOT_FOUND).send(error(HttpStatus.NOT_FOUND, "Library item has no file"));
    }
    return reply.redirect(item.file_url, 302);
}

// ── library_browser cross-OTT helpers ──────────────────────────────────

export async function list_user_library_otts(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const otts = await OttPlatform.findAll({
        where: { user_id } as any,
        attributes: ["id", "name", "favicon_url"],
    });

    // Per-OTT aggregation. Three numbers per row:
    //   total              — file rows the user can actually open
    //   placeholder_roots  — folder_placeholder rows with parent_folder_key
    //                        NULL. For Local Uploads this is the count the
    //                        user perceives in StoryGridView at root.
    //                        Non-local OTTs don't create placeholders, so
    //                        this is 0 for them.
    //   distinct_buckets   — distinct parent_item_key on file rows. For
    //                        non-local (scrape-pipeline) OTTs this matches
    //                        the "stories" grid. For Local Uploads it
    //                        over-counts because every nested subfolder
    //                        gets its own bucket — DO NOT use it there.
    //
    // folder_count = placeholder_roots when > 0, else distinct_buckets.
    const counts_rows = await sequelize.query<{
        ott_id: string;
        total: string;
        placeholder_roots: string;
        distinct_buckets: string;
    }>(
        `SELECT ott_id,
                COUNT(*) FILTER (
                    WHERE save_type != 'folder_placeholder'
                    AND (file_url IS NOT NULL OR image_url IS NOT NULL)
                )::text AS total,
                COUNT(*) FILTER (
                    WHERE save_type = 'folder_placeholder'
                    AND parent_folder_key IS NULL
                )::text AS placeholder_roots,
                COUNT(DISTINCT parent_item_key) FILTER (
                    WHERE save_type != 'folder_placeholder'
                    AND (file_url IS NOT NULL OR image_url IS NOT NULL)
                )::text AS distinct_buckets
         FROM ott_library_items
         WHERE user_id = :user_id AND "deletedAt" IS NULL
         GROUP BY ott_id`,
        { type: QueryTypes.SELECT, replacements: { user_id } },
    );
    const counts_by_ott = new Map<string, { total: number; folder_count: number }>();
    for (const r of counts_rows) {
        const placeholder_roots = Number(r.placeholder_roots) || 0;
        const distinct_buckets = Number(r.distinct_buckets) || 0;
        counts_by_ott.set(r.ott_id, {
            total: Number(r.total) || 0,
            folder_count: placeholder_roots > 0 ? placeholder_roots : distinct_buckets,
        });
    }

    return success("library otts", {
        otts: otts.map(o => {
            const c = counts_by_ott.get(o.id);
            return {
                id: o.id,
                name: o.name,
                favicon_url: o.favicon_url,
                counts: {
                    total: c?.total ?? 0,
                    folder_count: c?.folder_count ?? 0,
                },
            };
        }),
    });
}

export async function bulk_delete_otts_library_contents(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const body = (req.body ?? {}) as { ott_ids?: unknown };
    const ott_ids = Array.isArray(body.ott_ids)
        ? body.ott_ids.filter((v): v is string => typeof v === "string" && v.length > 0)
        : [];
    if (ott_ids.length === 0) return error(HttpStatus.BAD_REQUEST, "ott_ids must be a non-empty array");

    let total_deleted = 0;
    const per_ott: Array<{ ott_id: string; deleted: number }> = [];
    for (const ott_id of ott_ids) {
        const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
        if (!ott) { per_ott.push({ ott_id, deleted: 0 }); continue; }
        const rows = await OttLibraryItem.findAll({
            where: { ott_id, user_id } as any,
            paranoid: false,
        } as any);
        let deleted = 0;
        for (const r of rows) {
            try {
                await delete_item_r2_object(r);
                await r.destroy({ force: true });
                deleted += 1;
            }
            catch { /* noop */ }
        }
        total_deleted += deleted;
        per_ott.push({ ott_id, deleted });
    }
    return success("library contents deleted", { total_deleted, per_ott });
}

// path is referenced for jsdoc only — keep the import alive so editors
// don't flag it during refactors.
void path;
