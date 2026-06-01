/**
 * Media analysis HTTP module — wraps the Gemini service with persistence
 * in `media_analysis_results` and exposes CRUD-style endpoints for the
 * upload / schedule flows to consume.
 *
 *   POST   /api/media-analysis/analyze
 *   GET    /api/media-analysis
 *   GET    /api/media-analysis/library/:library_item_id
 *   DELETE /api/media-analysis/:analysis_id
 *
 * Per-platform caching: the (user_id, library_item_id, platform) tuple
 * is the natural key — by default we return the most recent completed
 * row for that tuple. `force_refresh: true` runs Gemini again and
 * overwrites it. Failed runs leave a `failed` row behind so the UI can
 * surface the error without re-running.
 *
 * Manual overrides: empty values are ignored; truthy values override the
 * generated field before the row is saved. This is the "if user fills
 * title manually, keep it; generate the rest" rule.
 */

import type { FastifyRequest } from "fastify";
import { Op } from "sequelize";
import { OttLibraryItem, MediaAnalysisResult } from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import path from "path";
import fs from "fs";
import os from "os";
import { analyze_library_item_media, get_media_details_from_file } from "../../services/media_analysis/media_to_details.service";
import { MediaPlatform } from "../../services/media_analysis/media_analysis.types";
import type { AnalyzeFromFileInput } from "./media_analysis.dto";

// Legacy alias kept for the rest of the file's signatures.
export type AnalysisPlatform = MediaPlatform;
import type {
    AnalyzeInput,
    ListAnalysisQueryInput,
    ManualOverridesInput,
} from "./media_analysis.dto";

function alog(step: string, data?: Record<string, any>) {
    console.log(`[media-analysis] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

// ── DTO ────────────────────────────────────────────────────────────────

export function analysis_dto(r: MediaAnalysisResult) {
    return {
        id: r.id,
        user_id: r.user_id,
        ott_id: r.ott_id ?? null,
        library_item_id: r.library_item_id,
        platform: r.platform,
        title: r.title ?? null,
        description: r.description ?? null,
        caption: r.caption ?? null,
        tags: r.tags ?? [],
        hashtags: r.hashtags ?? [],
        keywords: r.keywords ?? [],
        category: r.category ?? null,
        language: r.language ?? null,
        analysis_provider: r.analysis_provider ?? "google",
        prompt_type: r.prompt_type ?? null,
        raw_analysis: r.raw_analysis ?? {},
        status: r.status,
        error_message: r.error_message ?? null,
        createdAt: (r as any).createdAt ?? null,
        updatedAt: (r as any).updatedAt ?? null,
        deletedAt: (r as any).deletedAt ?? null,
    };
}

// ── Public surface ─────────────────────────────────────────────────────
//
// Helpers (apply_overrides, derive_caption, find_existing) moved to
// `services/media_analysis/media_platform_parser.service.ts` and the
// underlying `analyze_library_item_media` callable. This file is now
// just HTTP plumbing + DTO shaping.

/**
 * Run analysis for one (library_item, platform) pair. Returns cached row
 * unless `force_refresh` is true. Public so the upload + schedule flows
 * can call it directly without going through HTTP.
 */
/**
 * Thin wrapper over `analyze_library_item_media` so existing callers
 * (resolve_details in social_upload, the HTTP /analyze endpoint, the
 * Edit-overrides flow) keep their import path. The heavy lifting now
 * lives in `services/media_analysis/media_to_details.service.ts`.
 */
export async function ensure_analysis(opts: {
    user_id: string;
    ott_id?: string | null;
    library_item_id: string;
    platform: AnalysisPlatform;
    context?: string;
    force_refresh?: boolean;
    manual_overrides?: ManualOverridesInput;
}): Promise<MediaAnalysisResult> {
    alog("analyze_start", {
        user_id: opts.user_id,
        library_item_id: opts.library_item_id,
        platform: opts.platform,
        force: !!opts.force_refresh,
    });
    const helper_input: Parameters<typeof analyze_library_item_media>[0] = {
        user_id: opts.user_id,
        ott_id: opts.ott_id ?? null,
        library_item_id: opts.library_item_id,
        platform: opts.platform,
    };
    if (opts.context !== undefined) helper_input.context = opts.context;
    if (opts.force_refresh !== undefined) helper_input.force_refresh = opts.force_refresh;
    if (opts.manual_overrides !== undefined) helper_input.manual_details = opts.manual_overrides;
    const result =await analyze_library_item_media(helper_input);
    return result
}

// ── HTTP handlers ──────────────────────────────────────────────────────

export async function analyze(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const body = req.body as AnalyzeInput;
    const platform = (body.platform ?? "general") as AnalysisPlatform;

    try {
        const opts: Parameters<typeof ensure_analysis>[0] = {
            user_id,
            ott_id: body.ott_id ?? null,
            library_item_id: body.library_item_id,
            platform,
        };
        if (body.context !== undefined) opts.context = body.context;
        if (body.force_refresh !== undefined) opts.force_refresh = body.force_refresh;
        if (body.manual_overrides !== undefined) opts.manual_overrides = body.manual_overrides;
        const row = await ensure_analysis(opts);
        return success("Analysis complete", analysis_dto(row));
    } catch (err: any) {
        const msg = err?.message ?? "Analysis failed";
        const code = /not found/i.test(msg) ? HttpStatus.NOT_FOUND
            : /no file_url/i.test(msg) ? HttpStatus.BAD_REQUEST
            : HttpStatus.INTERNAL_SERVER_ERROR;
        return error(code, msg);
    }
}

export async function list_analysis(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const q = (req.query ?? {}) as ListAnalysisQueryInput;

    const where: any = { user_id };
    if (q.ott_id) where.ott_id = q.ott_id;
    if (q.library_item_id) where.library_item_id = q.library_item_id;
    if (q.platform) where.platform = q.platform;
    if (q.status) where.status = q.status;

    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const offset = (page - 1) * limit;

    const { rows, count } = await MediaAnalysisResult.findAndCountAll({
        where,
        order: [["createdAt", "DESC"]],
        limit,
        offset,
    });
    return success("Analyses fetched", {
        total: count,
        page,
        limit,
        analyses: rows.map(analysis_dto),
    });
}

export async function get_for_library_item(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { library_item_id } = req.params as { library_item_id: string };

    const item = await OttLibraryItem.findOne({ where: { id: library_item_id, user_id } as any });
    if (!item) return error(HttpStatus.NOT_FOUND, "Library item not found");

    const rows = await MediaAnalysisResult.findAll({
        where: { user_id, library_item_id } as any,
        order: [["platform", "ASC"], ["createdAt", "DESC"]],
    });

    // Latest per platform — the array is already DESC by createdAt, so the
    // first row we encounter for a given platform is the freshest.
    const by_platform: Record<string, ReturnType<typeof analysis_dto>> = {};
    for (const r of rows) {
        const p = r.platform ?? "general";
        if (!by_platform[p]) by_platform[p] = analysis_dto(r);
    }

    return success("Analyses fetched", {
        library_item_id,
        analyses: rows.map(analysis_dto),
        latest_by_platform: by_platform,
    });
}

/**
 * Sandbox the user-supplied `file_path` to known-safe roots so a request
 * body can't read arbitrary files off disk (`/etc/passwd`, etc.). Allowed
 * roots: the OS tmp dir, the backend's `public/uploads` dir, and the
 * media-analysis tmp dir we write to ourselves when streaming from R2.
 */
const ALLOWED_FILE_ROOTS = [
    path.resolve(os.tmpdir()),
    path.resolve(process.cwd(), "public", "uploads"),
    path.resolve(process.cwd(), "storage", "temp"),
    path.resolve(os.tmpdir(), "media-analysis"),
    path.resolve(os.tmpdir(), "gemini-analysis"),
];

function is_path_allowed(file_path: string): boolean {
    const abs = path.resolve(file_path);
    return ALLOWED_FILE_ROOTS.some(root => abs === root || abs.startsWith(root + path.sep));
}

/**
 * POST /api/media-analysis/from_file
 *
 * Direct-call testing endpoint — runs `get_media_details_from_file` on
 * a local file and returns the generated details (does NOT persist).
 * For library-item analysis (with persistence), use POST /analyze.
 */
export async function analyze_from_file(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const body = req.body as AnalyzeFromFileInput;

    const abs = path.resolve(body.file_path);
    if (!is_path_allowed(abs)) {
        return error(HttpStatus.BAD_REQUEST, "file_path is outside the allowed roots (tmp / uploads / storage/temp)");
    }
    if (!fs.existsSync(abs)) {
        return error(HttpStatus.NOT_FOUND, `File not found: ${abs}`);
    }

    try {
        const details = await get_media_details_from_file({
            file_path: abs,
            platform: body.platform as MediaPlatform,
            ...(body.context !== undefined ? { context: body.context } : {}),
            ...(body.manual_details !== undefined ? { manual_details: body.manual_details } : {}),
            ...(body.prompt_type !== undefined ? { prompt_type: body.prompt_type } : {}),
        });
        return success("media details generated successfully", {
            title: details.title ?? null,
            description: details.description ?? null,
            caption: details.caption ?? null,
            tags: details.tags ?? [],
            hashtags: details.hashtags ?? [],
            keywords: details.keywords ?? [],
            category: details.category ?? null,
            language: details.language ?? null,
            raw_analysis: details.raw_analysis ?? {},
        });
    } catch (err: any) {
        const msg = err?.message ?? "Analysis failed";
        const code = /not found/i.test(msg) ? HttpStatus.NOT_FOUND : HttpStatus.INTERNAL_SERVER_ERROR;
        return error(code, msg);
    }
}

export async function delete_analysis(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { analysis_id } = req.params as { analysis_id: string };

    const row = await MediaAnalysisResult.findOne({
        where: { id: analysis_id, user_id } as any,
    });
    if (!row) return error(HttpStatus.NOT_FOUND, "Analysis not found");
    await row.destroy();
    alog("analysis_deleted", { analysis_id, user_id });
    return success("Analysis deleted", { id: analysis_id });
}

// Re-exports — not strictly needed but keeps the import surface narrow.
export { Op };
