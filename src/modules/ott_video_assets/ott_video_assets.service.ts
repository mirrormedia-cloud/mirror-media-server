import type { FastifyReply, FastifyRequest } from "fastify";
import axios from "axios";
import { Op } from "sequelize";
import {
    OttPlatform,
    OttApiNode,
    OttApiResponse,
    OttChildApiItemResponse,
    OttVideoAsset,
    OttLibraryItem,
} from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import {
    get_value_by_path,
    replace_array_index_in_path,
} from "../../utils/response_path_utils";
import type {
    CaptureVideoAssetsInput,
    ListVideoAssetsQueryInput,
    DownloadVideoQueryInput,
} from "./ott_video_assets.dto";

function ts(value: any): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function video_asset_dto(v: OttVideoAsset) {
    return {
        id: v.id,
        ott_id: v.ott_id,
        api_node_id: v.api_node_id ?? null,
        source_response_id: v.source_response_id ?? null,
        parent_api_id: v.parent_api_id ?? null,
        item_key: v.item_key ?? null,
        title: v.title ?? null,
        description: v.description ?? null,
        thumbnail: v.thumbnail ?? null,
        video_url: v.video_url,
        video_type: v.video_type ?? null,
        quality: v.quality ?? null,
        language: v.language ?? null,
        duration: v.duration ?? null,
        metadata: v.metadata ?? {},
        status: v.status,
        downloaded_at: ts(v.downloaded_at),
        createdAt: ts((v as any).createdAt),
        updatedAt: ts((v as any).updatedAt),
    };
}

/** Detect video_type from URL extension. */
export function detect_video_type(url: string): string {
    const lower = (url || "").split("?")[0]?.toLowerCase() ?? "";
    if (lower.endsWith(".m3u8")) return "m3u8";
    if (lower.endsWith(".mpd")) return "mpd";
    if (lower.endsWith(".mp4")) return "mp4";
    if (lower.endsWith(".webm")) return "webm";
    if (lower.endsWith(".mov")) return "mov";
    if (lower.endsWith(".mkv")) return "mkv";
    if (lower.endsWith(".ts")) return "ts";
    if (lower.includes(".m3u8?")) return "m3u8";
    if (lower.includes(".mpd?")) return "mpd";
    if (lower.includes(".mp4?")) return "mp4";
    return "unknown";
}

function safe_filename_for(asset: OttVideoAsset): string {
    const base = (asset.title ?? "video")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 100) || "video";
    const ext = asset.video_type && asset.video_type !== "unknown" ? asset.video_type : "bin";
    return `${base}.${ext}`;
}

async function load_source_response(args: {
    ott_id: string;
    api_node_id: string;
    source_response_id?: string | null | undefined;
}): Promise<{ response: any; source_kind: "root" | "child" | null } | null> {
    if (args.source_response_id) {
        const child_row = await OttChildApiItemResponse.findOne({
            where: { id: args.source_response_id } as any,
        });
        if (child_row) return { response: child_row.response, source_kind: "child" };

        const root_row = await OttApiResponse.findByPk(args.source_response_id);
        if (root_row) return { response: root_row.response, source_kind: "root" };
    }
    const root = await OttApiResponse.findOne({ where: { api_node_id: args.api_node_id } as any });
    if (root) return { response: root.response, source_kind: "root" };
    const child = await OttChildApiItemResponse.findOne({
        where: { child_api_id: args.api_node_id } as any,
        order: [["called_at", "DESC"]],
    });
    if (child) return { response: child.response, source_kind: "child" };
    return null;
}

/**
 * Core upsert logic — takes a fully-resolved response and a mapping, creates
 * new OttVideoAsset rows for URLs that haven't been seen before (downloaded_at
 * stays null so Download All picks them up), and patches metadata on existing
 * rows without touching downloaded_at.
 */
export async function capture_for_node(args: {
    ott_id: string;
    api_node_id: string;
    response: any;
    mapping: {
        list_path?: string | null;
        video_url_paths: string[];
        title_path?: string | null;
        description_path?: string | null;
        thumbnail_path?: string | null;
        quality_path?: string | null;
        language_path?: string | null;
        duration_path?: string | null;
    };
}): Promise<{ created: number; updated: number; already_saved: number }> {
    const { ott_id, api_node_id, response, mapping } = args;
    let iter_count = 1;
    if (mapping.list_path) {
        const arr = get_value_by_path(response, mapping.list_path);
        if (Array.isArray(arr)) iter_count = arr.length;
    }

    let created = 0, updated = 0, already_saved = 0;

    for (let i = 0; i < iter_count; i++) {
        const idx = mapping.list_path ? i : 0;
        const get = (p: string | null | undefined): string | null => {
            if (!p) return null;
            const v = get_value_by_path(response, replace_array_index_in_path(p, idx));
            return (v !== undefined && v !== null) ? (typeof v === "string" ? v : String(v)) : null;
        };
        for (const raw_path of mapping.video_url_paths) {
            const url = get_value_by_path(response, replace_array_index_in_path(raw_path, idx));
            if (typeof url !== "string" || !url) continue;
            try {
                const existing = await OttVideoAsset.findOne({ where: { ott_id, video_url: url } as any });
                if (existing) {
                    const patch: any = {};
                    if (!existing.title && get(mapping.title_path)) patch.title = get(mapping.title_path);
                    if (!existing.description && get(mapping.description_path)) patch.description = get(mapping.description_path);
                    if (!existing.thumbnail && get(mapping.thumbnail_path)) patch.thumbnail = get(mapping.thumbnail_path);
                    if (!existing.quality && get(mapping.quality_path)) patch.quality = get(mapping.quality_path);
                    if (!existing.language && get(mapping.language_path)) patch.language = get(mapping.language_path);
                    if (!existing.duration && get(mapping.duration_path)) patch.duration = get(mapping.duration_path);
                    if (Object.keys(patch).length > 0) { await existing.update(patch); updated += 1; }
                    else already_saved += 1;
                } else {
                    await OttVideoAsset.create({
                        ott_id, api_node_id,
                        video_url: url,
                        video_type: detect_video_type(url),
                        title: get(mapping.title_path),
                        description: get(mapping.description_path),
                        thumbnail: get(mapping.thumbnail_path),
                        quality: get(mapping.quality_path),
                        language: get(mapping.language_path),
                        duration: get(mapping.duration_path),
                        metadata: { source_path: raw_path, captured_index: i },
                        status: "active",
                        downloaded_at: null,
                    } as any);
                    created += 1;
                }
            } catch { /* skip failed rows */ }
        }
    }
    return { created, updated, already_saved };
}

export async function capture_video_assets(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const body = req.body as CaptureVideoAssetsInput;

    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id: (req as any).userId } as any });
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const node = await OttApiNode.findOne({ where: { id: body.api_node_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    const loaded = await load_source_response({
        ott_id,
        api_node_id: body.api_node_id,
        source_response_id: body.source_response_id ?? undefined,
    });
    if (!loaded || loaded.response === null || loaded.response === undefined) {
        return error(HttpStatus.BAD_REQUEST, "No saved response found for this API");
    }

    const response = loaded.response;

    // Determine the iteration count.
    let iter_count = 1;
    if (body.list_path) {
        const arr = get_value_by_path(response, body.list_path);
        if (Array.isArray(arr)) iter_count = arr.length;
        else iter_count = 1;
    }

    const items_to_save: Partial<OttVideoAsset>[] = [];
    // Per-path resolution outcome — surfaced when zero URLs extract so
    // the user can see WHICH paths failed and what the response actually
    // had at the parent of each path. Without this the toast just says
    // "no URLs extracted" and the user has to guess.
    type Diag = { path: string; index: number; resolved: string };
    const diagnostics: Diag[] = [];
    for (let i = 0; i < iter_count; i++) {
        const replace_idx = body.list_path ? i : 0;
        for (const raw_path of body.video_url_paths) {
            const url_path = replace_array_index_in_path(raw_path, replace_idx);
            const url_value = get_value_by_path(response, url_path);
            if (typeof url_value !== "string" || !url_value) {
                // Only record the first 8 attempts to keep the response
                // payload small — that's enough to spot the pattern.
                if (diagnostics.length < 8) {
                    diagnostics.push({
                        path: url_path,
                        index: replace_idx,
                        resolved: url_value === undefined ? "undefined"
                                : url_value === null ? "null"
                                : url_value === "" ? "empty string"
                                : `${typeof url_value}: ${JSON.stringify(url_value).slice(0, 120)}`,
                    });
                }
                continue;
            }

            const get = (p: string | null | undefined): string | null => {
                if (!p) return null;
                const v = get_value_by_path(response, replace_array_index_in_path(p, replace_idx));
                if (v === undefined || v === null) return null;
                return typeof v === "string" ? v : String(v);
            };

            items_to_save.push({
                ott_id,
                api_node_id: body.api_node_id,
                source_response_id: body.source_response_id ?? null,
                parent_api_id: body.parent_api_id ?? null,
                item_key: body.item_key ?? null,
                title: get(body.title_path),
                description: get(body.description_path),
                thumbnail: get(body.thumbnail_path),
                video_url: url_value,
                video_type: detect_video_type(url_value),
                quality: get(body.quality_path),
                language: get(body.language_path),
                duration: get(body.duration_path),
                metadata: { source_path: raw_path, captured_index: i },
                status: "active",
            });
        }
    }

    let saved_count = 0;
    let updated_count = 0;
    let already_saved_count = 0;
    const saved_items: Array<OttVideoAsset & { __outcome?: "created" | "updated" | "already_saved" }> = [];
    const errors: Array<{ video_url?: string; message: string }> = [];

    for (const payload of items_to_save) {
        // Defensive: never run findOne with an undefined video_url — Sequelize would
        // ignore the column and match the wrong row, causing false "already saved" hits.
        if (!payload.video_url || typeof payload.video_url !== "string") continue;

        try {
            const existing = await OttVideoAsset.findOne({
                where: { ott_id, video_url: payload.video_url } as any,
            });
            if (existing) {
                // Patch metadata only when the new payload has a value the existing row lacks.
                const patch: Partial<OttVideoAsset> = {};
                if (!existing.title && payload.title) patch.title = payload.title;
                if (!existing.description && payload.description) patch.description = payload.description;
                if (!existing.thumbnail && payload.thumbnail) patch.thumbnail = payload.thumbnail;
                if (!existing.quality && payload.quality) patch.quality = payload.quality;
                if (!existing.language && payload.language) patch.language = payload.language;
                if (!existing.duration && payload.duration) patch.duration = payload.duration;
                const did_patch = Object.keys(patch).length > 0;
                if (did_patch) await existing.update(patch);
                (existing as any).__outcome = did_patch ? "updated" : "already_saved";
                if (did_patch) updated_count += 1; else already_saved_count += 1;
                saved_items.push(existing);
            } else {
                const created = await OttVideoAsset.create(payload as any);
                (created as any).__outcome = "created";
                saved_count += 1;
                saved_items.push(created);
            }
        } catch (err: any) {
            errors.push({ video_url: payload.video_url, message: err?.message ?? "save failed" });
            console.log("[VIDEO ASSET CAPTURE ERROR]", err);
        }
    }

    // Combined "skipped" count for backwards compatibility with older clients.
    const skipped_count = updated_count + already_saved_count;

    // When nothing extracted AT ALL, attach diagnostics so the UI toast
    // can tell the user *why*. Keeps the success-shape contract intact
    // (consumers that don't read `extraction_diagnostics` see the same
    // zero counts they did before).
    let extraction_diagnostics: any = null;
    if (saved_count + updated_count + already_saved_count === 0 && errors.length === 0) {
        const top_keys = response && typeof response === "object" && !Array.isArray(response)
            ? Object.keys(response).slice(0, 12)
            : null;
        // If the iterated parent (e.g. `episodes[0]`) exists, surface its
        // keys too — that's usually the parent of the user's path and
        // tells them whether the field they expected actually exists.
        let sample_card_keys: string[] | null = null;
        if (body.list_path) {
            const arr = get_value_by_path(response, body.list_path);
            if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0] === "object") {
                sample_card_keys = Object.keys(arr[0]).slice(0, 20);
            }
        }
        extraction_diagnostics = {
            iter_count,
            attempted_paths: diagnostics,
            response_top_keys: top_keys,
            response_is_array: Array.isArray(response),
            sample_card_keys,
            hint: top_keys && (top_keys.includes("data") || top_keys.includes("result"))
                ? `Response is wrapped — paths might need a "${top_keys.includes("data") ? "data." : "result."}" prefix.`
                : sample_card_keys && sample_card_keys.length > 0
                    ? `The list items have these fields — pick a URL field from this list and update Edit Mapping.`
                    : `The configured paths returned undefined/empty for every card. The cached response may not contain video URLs at this level — check whether a child API (e.g. /play, /stream) is needed.`,
        };
        console.log("[VIDEO ASSET CAPTURE NO-MATCH]", JSON.stringify(extraction_diagnostics, null, 2));
    }

    return success("video urls captured successfully", {
        saved_count,
        updated_count,
        already_saved_count,
        skipped_count,
        error_count: errors.length,
        errors,
        items: saved_items.map((it) => ({
            ...video_asset_dto(it),
            outcome: (it as any).__outcome ?? "created",
        })),
        ...(extraction_diagnostics ? { extraction_diagnostics } : {}),
    });
}

export async function list_video_assets(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const query = (req.query || {}) as ListVideoAssetsQueryInput;
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const where: any = { ott_id };
    if (query.video_type) where.video_type = query.video_type;
    if (query.api_node_id) where.api_node_id = query.api_node_id;
    if (query.search) {
        const like = `%${query.search}%`;
        where[Op.or] = [
            { title: { [Op.iLike]: like } },
            { video_url: { [Op.iLike]: like } },
        ];
    }

    const { rows, count } = await OttVideoAsset.findAndCountAll({
        where,
        order: [["createdAt", "DESC"]],
        limit,
        offset: (page - 1) * limit,
    });

    // Decorate each asset with its library save status (if any).
    const asset_ids = rows.map((r) => r.id);
    const library_rows = asset_ids.length
        ? await OttLibraryItem.findAll({
            where: { ott_id, video_asset_id: asset_ids } as any,
        })
        : [];
    const lib_by_asset = new Map<string, OttLibraryItem>();
    for (const l of library_rows) {
        if (l.video_asset_id) lib_by_asset.set(l.video_asset_id, l);
    }

    return success("video assets fetched successfully", {
        ott_id,
        total: count,
        page,
        limit,
        items: rows.map((r) => {
            const lib = lib_by_asset.get(r.id);
            return {
                ...video_asset_dto(r),
                is_saved_to_library: !!lib,
                library_item_id: lib?.id ?? null,
                // After the R2 migration there's no `status` column —
                // a row's existence IS the success signal.
                library_status: lib ? "completed" as const : null,
            };
        }),
    });
}

export async function get_video_asset(req: FastifyRequest) {
    const { ott_id, video_asset_id } = req.params as { ott_id: string; video_asset_id: string };
    const asset = await OttVideoAsset.findOne({ where: { id: video_asset_id, ott_id } as any });
    if (!asset) return error(HttpStatus.NOT_FOUND, "Video asset not found");
    return success("video asset fetched successfully", video_asset_dto(asset));
}

export async function delete_video_asset(req: FastifyRequest) {
    const { ott_id, video_asset_id } = req.params as { ott_id: string; video_asset_id: string };
    const asset = await OttVideoAsset.findOne({ where: { id: video_asset_id, ott_id } as any });
    if (!asset) return error(HttpStatus.NOT_FOUND, "Video asset not found");
    await asset.destroy();
    return success("video asset deleted successfully", { id: video_asset_id });
}

/**
 * POST /:ott_id/video_assets/reset_downloaded
 * Clears downloaded_at on every video asset for this OTT so that a fresh
 * sync's content becomes eligible for Download All again.
 */
export async function reset_downloaded(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const [updated] = await OttVideoAsset.update(
        { downloaded_at: null } as any,
        { where: { ott_id, downloaded_at: { [Op.ne]: null } } as any },
    );
    return success(`Reset download status on ${updated} asset${updated === 1 ? "" : "s"}`, { updated });
}

/**
 * Bulk-delete captured video assets — body: { ids: string[] }. Used by
 * the desktop-style multi-select in the captured videos page. Reports
 * per-id outcomes so the toast can read accurately.
 */
export async function bulk_delete_video_assets(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const body = (req.body ?? {}) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
        ? body.ids.filter((v): v is string => typeof v === "string" && v.length > 0)
        : [];
    if (ids.length === 0) {
        return error(HttpStatus.BAD_REQUEST, "ids must be a non-empty array of video asset ids");
    }

    const assets = await OttVideoAsset.findAll({
        where: { id: { [Op.in]: ids }, ott_id } as any,
    });
    const found_ids = new Set(assets.map(a => a.id));
    const missing_ids = ids.filter(id => !found_ids.has(id));
    let deleted = 0;
    const failed: Array<{ id: string; error: string }> = [];

    for (const asset of assets) {
        try {
            await asset.destroy();
            deleted += 1;
        } catch (err: any) {
            failed.push({ id: asset.id, error: err?.message ?? "delete failed" });
        }
    }

    return success(
        `Deleted ${deleted} video asset${deleted === 1 ? "" : "s"}`,
        { requested: ids.length, deleted, missing_ids, failed },
    );
}

const STREAMABLE_TYPES = new Set(["mp4", "webm", "mov", "mkv", "ts"]);

export async function download_video_asset(req: FastifyRequest, reply: FastifyReply) {
    const { ott_id, video_asset_id } = req.params as { ott_id: string; video_asset_id: string };
    const query = (req.query || {}) as DownloadVideoQueryInput;

    const asset = await OttVideoAsset.findOne({ where: { id: video_asset_id, ott_id } as any });
    if (!asset) {
        return reply.status(HttpStatus.NOT_FOUND).send(error(HttpStatus.NOT_FOUND, "Video asset not found"));
    }
    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id: (req as any).userId } as any });
    if (!ott) {
        return reply.status(HttpStatus.NOT_FOUND).send(error(HttpStatus.NOT_FOUND, "OTT not found"));
    }

    const video_type = asset.video_type ?? "unknown";
    const url = asset.video_url!;
    const headers: Record<string, string> = {};
    if (ott.headers && typeof ott.headers === "object") {
        for (const [k, v] of Object.entries(ott.headers)) {
            if (k && v !== undefined && v !== null) headers[k] = String(v);
        }
    }
    if (!headers["User-Agent"] && !headers["user-agent"]) {
        headers["User-Agent"] =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
    }
    if (ott.cookie_string) headers["Cookie"] = ott.cookie_string;

    const is_playlist = video_type === "m3u8" || video_type === "mpd";

    // Playlist: only stream when ?mode=playlist; else respond with JSON message.
    if (is_playlist && query.mode !== "playlist") {
        return reply.status(HttpStatus.BAD_REQUEST).send(
            error(
                HttpStatus.BAD_REQUEST,
                "This is a streaming playlist. Use ?mode=playlist to download the playlist file, or use Copy URL to play it externally.",
            ),
        );
    }

    if (!is_playlist && !STREAMABLE_TYPES.has(video_type)) {
        return reply.status(HttpStatus.BAD_REQUEST).send(
            error(HttpStatus.BAD_REQUEST, `Unsupported video_type "${video_type}" for download.`),
        );
    }

    try {
        const upstream = await axios.get(url, {
            headers,
            responseType: "stream",
            // No timeout — large video downloads must run to completion.
            timeout: 0,
            validateStatus: () => true,
        });

        if (upstream.status >= 400) {
            return reply.status(HttpStatus.BAD_GATEWAY).send(
                error(HttpStatus.BAD_GATEWAY, `Upstream returned HTTP ${upstream.status}`),
            );
        }

        const filename = safe_filename_for(asset);
        const content_type = (upstream.headers["content-type"] as string)
            || (is_playlist ? "application/vnd.apple.mpegurl" : "application/octet-stream");
        const content_length = upstream.headers["content-length"];

        reply
            .header("Content-Type", content_type)
            .header("Content-Disposition", `attachment; filename="${filename}"`);
        if (content_length) reply.header("Content-Length", String(content_length));

        // Mark as downloaded — fire-and-forget, don't block the stream.
        asset.update({ downloaded_at: new Date() } as any).catch(() => {});

        return reply.send(upstream.data);
    } catch (err: any) {
        return reply.status(HttpStatus.BAD_GATEWAY).send(
            error(HttpStatus.BAD_GATEWAY, err?.message || "Failed to fetch upstream video"),
        );
    }
}
