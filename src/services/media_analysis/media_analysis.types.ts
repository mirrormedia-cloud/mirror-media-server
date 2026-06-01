/**
 * Shared types for the media analysis services. Lives separately so any
 * file in the chain (prompt builder, parser, the main service) can import
 * from one place without circular deps.
 */

export type MediaPlatform = "youtube" | "facebook" | "instagram" | "general";

export interface ManualMediaOverrides {
    title?: string | undefined;
    description?: string | undefined;
    caption?: string | undefined;
    tags?: string[] | undefined;
    hashtags?: string[] | undefined;
}

/**
 * Final, platform-agnostic generated payload. Specific platforms only
 * use a subset (YT cares about title/description/tags/hashtags;
 * Instagram cares about caption + hashtags) — the caller decides which
 * fields to consume.
 */
export interface MediaDetails {
    platform: MediaPlatform;
    title?: string | undefined;
    description?: string | undefined;
    caption?: string | undefined;
    tags?: string[] | undefined;
    hashtags?: string[] | undefined;
    keywords?: string[] | undefined;
    category?: string | null | undefined;
    language?: string | null | undefined;
    /** Untouched JSON from Gemini, plus any internal flags (manual_overrides, etc.). */
    raw_analysis?: Record<string, any> | undefined;
}

export interface AnalyzeFileInput {
    file_path: string;
    platform: MediaPlatform;
    /** Free-form context appended to the prompt. */
    context?: string | undefined;
    /** Manual values that override generated fields per-field (empty values are ignored). */
    manual_details?: ManualMediaOverrides | undefined;
    /** Tagged onto the result for traceability — e.g. "youtube_v1". */
    prompt_type?: string | undefined;
}
