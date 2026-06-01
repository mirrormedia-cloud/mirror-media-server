/**
 * Media → details pipeline.
 *
 * Two public callables:
 *
 *   get_media_details_from_file({ file_path, platform, manual_details })
 *     - Pure I/O wrapper around Gemini. Takes a LOCAL file path.
 *     - Uploads to Gemini File API, polls until ACTIVE, runs the
 *       platform-specific prompt, parses the JSON, applies manual
 *       overrides, returns the structured details. Does NOT touch the
 *       database — callers decide whether/where to persist.
 *
 *   analyze_library_item_media({ user_id, ott_id, library_item_id,
 *                               platform, manual_details, force_refresh })
 *     - Higher-level: validates library-item ownership, downloads the
 *       Drive bytes to a temp file (so the underlying Gemini SDK can
 *       upload by path), invokes get_media_details_from_file, persists
 *       the result in `media_analysis_results`, cleans up the temp file.
 *     - Honours `force_refresh` — when false, an existing completed row
 *       for the same (user, library_item, platform) is returned without
 *       re-running Gemini.
 *
 * Logs (no API keys / tokens — handler redacts known sensitive keys):
 *   - media analysis started
 *   - file_path exists
 *   - platform / prompt_type
 *   - AI call started / response received
 *   - parse success/fail
 *   - manual overrides applied
 *   - result saved (when going through analyze_library_item_media)
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

import { MediaDetails, AnalyzeFileInput, MediaPlatform, ManualMediaOverrides } from "./media_analysis.types";
import { build_prompt, prompt_type_for } from "./media_prompt.service";
import {
    parse_json_block,
    to_media_details,
    apply_manual_overrides,
    derive_caption,
} from "./media_platform_parser.service";

import { OttLibraryItem, MediaAnalysisResult } from "../../db/models";
import { get_url_stream } from "../social/url_stream";

const MAX_STATE_ATTEMPTS = 30;
const STATE_POLL_MS = 5000;
const MAX_INFERENCE_RETRIES = 5;
/** Initial backoff after a 503; grows exponentially: 15s, 30s, 60s, 120s, 240s. */
const INFERENCE_INITIAL_BACKOFF_MS = 15_000;
/**
 * Tried in order. When one model returns 503 after exhausting its
 * retries, we fall down the list to the next. The first that responds
 * wins. Each model has its own retry budget.
 */
const MODEL_FALLBACK_CHAIN = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
];

function dlog(step: string, data?: Record<string, any>) {
    const safe = data ? Object.fromEntries(
        Object.entries(data).map(([k, v]) =>
            /api[_-]?key|secret|token|password|cookie|authorization/i.test(k)
                ? [k, typeof v === "string" ? `<redacted:${v.length}>` : "<redacted>"]
                : [k, v],
        ),
    ) : undefined;
    console.log(`[media-analysis] ${step}${safe ? " " + JSON.stringify(safe) : ""}`);
}

/**
 * Tiny extension → MIME map. Gemini accepts most common video / image
 * containers; for anything else we fall back to video/mp4 (which is what
 * the existing pipeline implicitly assumed).
 */
const MIME_BY_EXT: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    webm: "video/webm",
    avi: "video/x-msvideo",
    m4v: "video/x-m4v",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
};
function detect_mime_type(file_path: string, fallback = "video/mp4"): string {
    const ext = path.extname(file_path).slice(1).toLowerCase();
    return MIME_BY_EXT[ext] ?? fallback;
}

function delete_quietly(p: string) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

// ── 1. The main callable: file_path + platform → MediaDetails ──────────

export async function get_media_details_from_file(input: AnalyzeFileInput): Promise<MediaDetails> {
    const { file_path, platform } = input;
    if (!process.env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is not configured");
    }
    const file_exists = fs.existsSync(file_path);
    dlog("started", { file_path, file_exists, platform, prompt_type: input.prompt_type ?? prompt_type_for(platform) });
    if (!file_exists) {
        throw new Error(`File not found: ${file_path}`);
    }

    const mime_type = detect_mime_type(file_path);
    const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const file_manager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

    let gemini_file_name: string | null = null;
    try {
        // Upload to Gemini File API.
        dlog("upload_start", { mime_type });
        const upload = await file_manager.uploadFile(file_path, {
            mimeType: mime_type,
            displayName: path.basename(file_path),
        });
        gemini_file_name = upload.file.name;
        const file_uri = upload.file.uri;
        dlog("upload_done", { gemini_file_name });

        // Poll until ACTIVE.
        let state = upload.file.state as string;
        for (let i = 0; i < MAX_STATE_ATTEMPTS && state !== "ACTIVE"; i += 1) {
            await new Promise(r => setTimeout(r, STATE_POLL_MS));
            const f = await file_manager.getFile(gemini_file_name);
            state = f.state as string;
            dlog("state_poll", { attempt: i + 1, state });
            if (state === "FAILED") {
                throw new Error(`Gemini file processing failed: ${(f as any).error?.message ?? "unknown"}`);
            }
        }
        if (state !== "ACTIVE") {
            throw new Error("Gemini file did not become ACTIVE in time");
        }

        // Inference. Walk the model fallback chain — each model gets its
        // own retry budget with exponential backoff on 503. Falling down
        // the chain only happens when 503 persists across the full retry
        // budget; other errors short-circuit immediately so a real bug
        // (auth, quota, malformed request) doesn't quietly try every
        // model in the list.
        const prompt = build_prompt(platform, input.context);
        dlog("inference_start", { platform, prompt_chars: prompt.length, models: MODEL_FALLBACK_CHAIN });

        let response: any = null;
        let model_used: string | null = null;
        let last_503_err: any = null;
        outer: for (const model_name of MODEL_FALLBACK_CHAIN) {
            const model = genai.getGenerativeModel({
                model: model_name,
                generationConfig: { temperature: 0.6, maxOutputTokens: 4096 },
            });
            for (let retry = 0; retry < MAX_INFERENCE_RETRIES; retry += 1) {
                try {
                    response = await model.generateContent([
                        prompt,
                        { fileData: { fileUri: file_uri, mimeType: mime_type } },
                    ]);
                    model_used = model_name;
                    break outer;
                } catch (err: any) {
                    const status = err?.status;
                    dlog("inference_retry", {
                        model: model_name,
                        attempt: retry + 1,
                        max: MAX_INFERENCE_RETRIES,
                        status,
                        error: err?.message,
                    });
                    if (status !== 503) {
                        // Non-503 = real error. Don't fall through to the
                        // next model — surface it now.
                        throw err;
                    }
                    last_503_err = err;
                    if (retry < MAX_INFERENCE_RETRIES - 1) {
                        // Exponential backoff: 15s, 30s, 60s, 120s, 240s.
                        const wait_ms = INFERENCE_INITIAL_BACKOFF_MS * Math.pow(2, retry);
                        dlog("inference_backoff", { model: model_name, wait_ms });
                        await new Promise(r => setTimeout(r, wait_ms));
                    }
                }
            }
            // Model exhausted its retries on 503 → try the next one.
            dlog("inference_model_exhausted", { model: model_name });
        }
        if (!response) {
            // Every model in the chain returned 503 after every retry. Throw
            // a friendly, persisted-to-error_message-aware message so the
            // UI shows "Gemini overloaded — try again in a few minutes"
            // instead of an opaque stack.
            const msg = last_503_err?.message?.includes("high demand")
                ? "Gemini is overloaded right now (model returned 503 \"high demand\"). Try again in a few minutes."
                : `Gemini was unreachable across all models: ${MODEL_FALLBACK_CHAIN.join(", ")}.`;
            const friendly = new Error(msg);
            (friendly as any).status = 503;
            throw friendly;
        }
        dlog("inference_model_used", { model: model_used });
        // Explicit "Google responded" boundary — easy to grep for, separate
        // from the parsing/normalisation logs below.
        console.log(`[GOOGLE ANALYSIS] response received { model: "${model_used}", platform: "${platform}", response_chars: ${response?.response?.text?.()?.length ?? 0} }`);

        const text = response.response.text();
        dlog("inference_done", { response_chars: text?.length ?? 0 });
        const parsed = parse_json_block(text);
        if (!parsed) {
            dlog("parse_failed", { preview: (text ?? "").slice(0, 200) });
            throw new Error("Gemini returned no parseable JSON block");
        }
        // Full parsed payload, pretty-printed so you can read it directly
        // in the terminal instead of scrolling a single stringified blob.
        // Bypassing dlog here on purpose — dlog uses one-line JSON which
        // is unreadable for the long description / tags arrays.
        console.log("[media-analysis] parse_ok\n" + JSON.stringify(parsed, null, 2));

        // Normalise → apply manual overrides → derive caption.
        const base = to_media_details(platform, parsed, text);
        const overridden = apply_manual_overrides(base, input.manual_details);
        const final: MediaDetails = {
            ...overridden,
            caption: derive_caption(platform, overridden, input.manual_details?.caption),
            raw_analysis: {
                ...(base.raw_analysis ?? {}),
                manual_overrides: input.manual_details ?? null,
                prompt_type: input.prompt_type ?? prompt_type_for(platform),
                model_used,
            },
        };
        if (input.manual_details && Object.keys(input.manual_details).length > 0) {
            dlog("manual_overrides_applied", { fields: Object.keys(input.manual_details) });
        }
        return final;
    } finally {
        if (gemini_file_name) {
            try { await file_manager.deleteFile(gemini_file_name); } catch { /* non-fatal */ }
        }
    }
}

// ── 2. Library-item helper: handles ownership + Drive download + DB persist ──

export interface AnalyzeLibraryItemInput {
    user_id: string;
    ott_id?: string | null;
    library_item_id: string;
    platform: MediaPlatform;
    context?: string;
    manual_details?: ManualMediaOverrides;
    force_refresh?: boolean;
}

/**
 * Stream a public R2 URL to a fresh temp path so the Gemini SDK (which
 * wants a filesystem path, not a stream) has something to upload.
 */
async function url_to_temp(file_url: string): Promise<{ path: string; mime_type: string }> {
    const { stream, content_type } = await get_url_stream(file_url);
    const tmp_dir = path.join(os.tmpdir(), "media-analysis");
    fs.mkdirSync(tmp_dir, { recursive: true });
    const ext = (content_type || "video/mp4").split("/")[1]?.split(";")[0] ?? "mp4";
    const tmp_path = path.join(tmp_dir, `r2-${crypto.randomBytes(8).toString("hex")}.${ext}`);
    const out = fs.createWriteStream(tmp_path);
    await new Promise<void>((resolve, reject) => {
        (stream as NodeJS.ReadableStream).pipe(out);
        out.on("finish", () => resolve());
        out.on("error", reject);
        (stream as NodeJS.ReadableStream).on("error", reject);
    });
    dlog("r2_temp_written", { tmp_path, size: fs.statSync(tmp_path).size, mime_type: content_type });
    return { path: tmp_path, mime_type: content_type || "video/mp4" };
}

async function find_existing_row(
    user_id: string,
    library_item_id: string,
    platform: MediaPlatform,
): Promise<MediaAnalysisResult | null> {
    return MediaAnalysisResult.findOne({
        where: { user_id, library_item_id, platform } as any,
        order: [["createdAt", "DESC"]],
    });
}

export async function analyze_library_item_media(
    input: AnalyzeLibraryItemInput,
): Promise<MediaAnalysisResult> {
    const { user_id, library_item_id, platform } = input;
    const item = await OttLibraryItem.findOne({ where: { id: library_item_id, user_id } as any });
    if (!item) throw new Error("Library item not found");
    const file_url = (item as any).file_url as string | null | undefined;
    if (!file_url) throw new Error("Library item has no file_url — upload to R2 first before running analysis.");

    if (!input.force_refresh) {
        const cached = await find_existing_row(user_id, library_item_id, platform);
        const expected_prompt = prompt_type_for(platform);
        const stale_prompt = cached && cached.prompt_type !== expected_prompt;
        // Belt-and-braces: even within the same prompt_type, validate
        // that the parsed JSON has the expected platform-keyed shape for
        // "general". If it's missing the shape, treat the row as stale
        // and re-run Gemini.
        const stale_shape = cached && platform === "general" && (() => {
            const parsed = (cached.raw_analysis as any)?.parsed ?? cached.raw_analysis;
            return !parsed || (!parsed.youtube && !parsed.instagram && !parsed.facebook);
        })();
        if (cached && cached.status === "completed" && !stale_prompt && !stale_shape) {
            dlog("cache_hit", { user_id, library_item_id, platform, analysis_id: cached.id });
            // Apply overrides without persisting — the response reflects
            // the user's edits, the row stays as the source of truth.
            if (input.manual_details && Object.keys(input.manual_details).length > 0) {
                const merged = apply_manual_overrides({
                    platform,
                    title: cached.title ?? undefined,
                    description: cached.description ?? undefined,
                    caption: cached.caption ?? undefined,
                    tags: cached.tags ?? [],
                    hashtags: cached.hashtags ?? [],
                    keywords: cached.keywords ?? [],
                }, input.manual_details);
                cached.title = merged.title ?? null;
                cached.description = merged.description ?? null;
                cached.caption = derive_caption(platform, merged, input.manual_details.caption) ?? null;
                cached.tags = merged.tags ?? [];
                cached.hashtags = merged.hashtags ?? [];
            }
            return cached;
        }
        if (cached && (stale_prompt || stale_shape)) {
            dlog("cache_stale", {
                analysis_id: cached.id,
                cached_prompt_type: cached.prompt_type,
                expected_prompt_type: expected_prompt,
                stale_shape: !!stale_shape,
            });
        }
    }

    // Reuse-or-create the row so id stays stable from pending → completed.
    let row = await find_existing_row(user_id, library_item_id, platform);
    if (!row) {
        row = await MediaAnalysisResult.create({
            user_id,
            ott_id: input.ott_id ?? (item as any).ott_id ?? null,
            library_item_id,
            platform,
            status: "pending",
            analysis_provider: "google",
            prompt_type: prompt_type_for(platform),
            tags: [],
            hashtags: [],
            keywords: [],
            raw_analysis: {},
        } as any);
    } else {
        await row.update({
            status: "pending",
            error_message: null,
            ott_id: input.ott_id ?? row.ott_id ?? (item as any).ott_id ?? null,
            prompt_type: prompt_type_for(platform),
        } as any);
    }

    let tmp_path: string | null = null;
    try {
        const tmp = await url_to_temp(file_url);
        tmp_path = tmp.path;
        const fileInput: AnalyzeFileInput = {
            file_path: tmp.path,
            platform,
            prompt_type: prompt_type_for(platform),
        };
        if (input.context !== undefined) fileInput.context = input.context;
        if (input.manual_details !== undefined) fileInput.manual_details = input.manual_details;
        const details = await get_media_details_from_file(fileInput);

        await row.update({
            status: "completed",
            title: details.title ?? null,
            description: details.description ?? null,
            caption: details.caption ?? null,
            tags: details.tags ?? [],
            hashtags: details.hashtags ?? [],
            keywords: details.keywords ?? [],
            category: details.category ?? null,
            language: details.language ?? null,
            raw_analysis: details.raw_analysis ?? {},
            error_message: null,
        } as any);
        dlog("result_saved", {
            analysis_id: row.id,
            platform,
            generated: { title_chars: details.title?.length ?? 0, tags: details.tags?.length ?? 0 },
        });
        return row;
    } catch (err: any) {
        dlog("result_failed", { analysis_id: row.id, platform, error: err?.message ?? String(err) });
        await row.update({
            status: "failed",
            error_message: (err?.message ?? String(err)).slice(0, 1000),
        } as any);
        throw err;
    } finally {
        if (tmp_path) delete_quietly(tmp_path);
    }
}
