/**
 * Pure functions that turn Gemini's text response into a normalised
 * `MediaDetails`, then merge user-supplied manual overrides.
 *
 * No side effects, no I/O — easy to unit-test, and the call site
 * (media_to_details.service.ts) becomes a straight pipeline:
 *   gemini.generateContent → parse_json_block → normalise → apply_overrides
 */

import { MediaDetails, MediaPlatform, ManualMediaOverrides } from "./media_analysis.types";

/**
 * Gemini occasionally wraps output in ```json ... ``` or prefixes a
 * sentence ("Sure! Here's the JSON..."). Extract the largest
 * brace-delimited block and JSON.parse it.
 */
export function parse_json_block(text: string): Record<string, any> | null {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
}

export function clean_strings(arr: any): string[] {
    if (!Array.isArray(arr)) return [];
    return arr.map(x => String(x ?? "").trim()).filter(Boolean);
}

/**
 * Normalise the raw parsed JSON into a typed `MediaDetails`. Also
 * harmonises legacy keys (`suggestedHashtags` → `hashtags`).
 */
export function to_media_details(
    platform: MediaPlatform,
    parsed: Record<string, any>,
    raw_text?: string,
): MediaDetails {
    const hashtags = clean_strings(parsed.hashtags ?? parsed.suggestedHashtags);
    return {
        platform,
        title: String(parsed.title ?? "").trim() || undefined,
        description: String(parsed.description ?? "").trim() || undefined,
        caption: String(parsed.caption ?? "").trim() || undefined,
        tags: clean_strings(parsed.tags),
        hashtags,
        keywords: clean_strings(parsed.keywords),
        category: parsed.category ? String(parsed.category).trim() : null,
        language: parsed.language ? String(parsed.language).trim() : null,
        raw_analysis: { parsed, raw_text },
    };
}

/**
 * Caption derivation per platform:
 *   - Instagram / Facebook: caption is the main copy. If the prompt
 *     didn't fill it (older prompts), fall back to description.
 *   - YouTube: caption stays empty — YT has no caption field.
 */
export function derive_caption(platform: MediaPlatform, details: MediaDetails, override?: string): string | undefined {
    if (override && override.trim()) return override.trim();
    if (platform === "instagram" || platform === "facebook") {
        return details.caption || details.description || undefined;
    }
    return undefined;
}

/**
 * Apply manual overrides on top of generated values. Empty strings and
 * empty arrays are treated as "not provided" — a blank field should NOT
 * erase the generated value, it should keep the generated one. To
 * explicitly clear a field, use the regenerate / edit flow.
 */
export function apply_manual_overrides(
    details: MediaDetails,
    overrides?: ManualMediaOverrides,
): MediaDetails {
    if (!overrides) return details;
    const out: MediaDetails = { ...details };
    if (overrides.title?.trim())       out.title = overrides.title.trim();
    if (overrides.description?.trim()) out.description = overrides.description.trim();
    if (overrides.caption?.trim())     out.caption = overrides.caption.trim();
    if (overrides.tags && overrides.tags.length > 0)         out.tags = overrides.tags;
    if (overrides.hashtags && overrides.hashtags.length > 0) out.hashtags = overrides.hashtags;
    return out;
}

// ── General-prompt platform builder ────────────────────────────────────
//
// The "general" prompt returns ONE response keyed by platform:
//   { instagram: { title, hashtags },
//     youtube:   { title, description, tags, keywords, hashtags, category, language },
//     facebook:  { title, hashtags } }
//
// `build_platform_upload_details` turns that single payload + the user's
// manual_details into the final per-platform field set the uploader will
// hand to YouTube / Facebook / Instagram. Manual fields always win;
// missing manual fields fall through to the AI output.
//
// IG and FB don't take a separate caption + title in our pipeline — the
// caption/title carries everything. So when manual_title is set we
// concatenate `manual_title + " " + hashtags.join(" ")`. When it isn't,
// the AI's full title (which already ends with hashtags) is used as-is.

export type AnalysisJson = {
    instagram?: { title?: string; hashtags?: string[] };
    youtube?: {
        title?: string; description?: string;
        tags?: string[]; keywords?: string[]; hashtags?: string[];
        category?: string; language?: string;
    };
    facebook?: { title?: string; hashtags?: string[] };
};

export type ManualDetails = {
    title?: string; description?: string; caption?: string;
    tags?: string[]; keywords?: string[]; hashtags?: string[];
    category?: string; language?: string;
};

export type PlatformUploadDetails = {
    title: string;
    description: string;
    caption: string;
    tags: string[];
    hashtags: string[];
    keywords: string[];
    category: string | null;
    language: string | null;
};

function merge_text(manual: string | undefined | null, ai: string | undefined | null): string {
    if (manual && String(manual).trim()) return String(manual).trim();
    return (ai ?? "").toString();
}

function merge_array(manual: string[] | undefined | null, ai: string[] | undefined | null): string[] {
    if (Array.isArray(manual) && manual.length > 0) return manual;
    return Array.isArray(ai) ? ai : [];
}

/** Ensure every hashtag has a leading "#" before joining into a caption. */
function ensure_hash_prefix(tags: string[]): string[] {
    return tags.map(t => {
        const trimmed = String(t ?? "").trim();
        if (!trimmed) return "";
        return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
    }).filter(Boolean);
}

/**
 * The general prompt currently asks Gemini to put hashtags INLINE at the
 * end of `instagram.title` / `facebook.title`. When we then append the
 * `hashtags` array to build the final caption, we'd double-print them.
 * Strip any trailing run of `#word #word ...` so the concat produces a
 * single, clean hashtag block.
 */
function strip_trailing_hashtags(text: string): string {
    return text.replace(/(\s*#[\w_]+)+\s*$/u, "").trim();
}

/**
 * Build the final per-platform field set from the general analysis JSON
 * and any manual overrides. Caller decides which `platform` slice to use.
 */
export function build_platform_upload_details(opts: {
    platform: "youtube" | "facebook" | "instagram";
    auto_details: boolean;
    manual_details?: ManualDetails;
    analysis_json?: AnalysisJson;
}): PlatformUploadDetails {
    const m = opts.manual_details ?? {};
    const a = opts.analysis_json ?? {};
    const ai = opts.auto_details;
    const yt = a.youtube ?? {};
    const ig = a.instagram ?? {};
    const fb = a.facebook ?? {};

    if (opts.platform === "youtube") {
        // For YouTube, caption is not a native field — fall back to caption
        // so users who type a caption (IG/FB style) still get a meaningful
        // video title without having to fill a separate title field.
        const effective_title = m.caption || m.title || "";
        const title       = merge_text(effective_title, ai ? yt.title : "");
        const description = merge_text(m.description, ai ? yt.description : "");
        const tags        = merge_array(m.tags,       ai ? yt.tags : []);
        const keywords    = merge_array(m.keywords,   ai ? yt.keywords : []);
        const hashtags    = merge_array(m.hashtags,   ai ? yt.hashtags : []);
        const category    = merge_text(m.category,    ai ? yt.category : "");
        const language    = merge_text(m.language,    ai ? yt.language : "");
        return {
            title,
            description,
            caption: "",
            tags,
            hashtags,
            keywords,
            category: category || null,
            language: language || null,
        };
    }

    // Instagram + Facebook share the same caption-is-the-body shape.
    // Priority: manual.caption → manual.title → analysis.title.
    // Hashtags are sourced from manual.hashtags if any, else from the
    // analysis hashtag array. The chosen body text has any trailing
    // hashtags stripped before we append the hashtag block, so we never
    // double-print (the prompt produces titles with hashtags inline).
    const slice = opts.platform === "instagram" ? ig : fb;
    const ai_title = ai ? (slice.title ?? "") : "";
    const ai_hashtags = ai ? ensure_hash_prefix(slice.hashtags ?? []) : [];

    const manual_title = (m.title ?? "").trim();
    const manual_caption = (m.caption ?? "").trim();
    const manual_hashtags = (m.hashtags && m.hashtags.length > 0) ? ensure_hash_prefix(m.hashtags) : null;
    const final_hashtags = manual_hashtags ?? ai_hashtags;

    let body_text = "";
    if (manual_caption) body_text = manual_caption;
    else if (manual_title) body_text = manual_title;
    else if (ai_title) body_text = ai_title;
    body_text = strip_trailing_hashtags(body_text);

    const final_title = manual_title || (ai_title ? strip_trailing_hashtags(ai_title) : "");
    const final_caption = body_text
        ? (final_hashtags.length > 0 ? `${body_text} ${final_hashtags.join(" ")}` : body_text)
        : (final_hashtags.length > 0 ? final_hashtags.join(" ") : "");

    // For IG/FB we don't track a separate description; the caption IS
    // the post body. Tags array stays empty (FB Pages don't index tags;
    // IG ignores them). Keywords/category/language aren't applicable.
    return {
        title: final_title,
        description: "",
        caption: final_caption,
        tags: [],
        hashtags: final_hashtags,
        keywords: [],
        category: null,
        language: null,
    };
}

/**
 * Reduce the full `MediaDetails` to the subset that's meaningful for the
 * platform — used by callers that want to hand a minimal payload to the
 * platform's upload API.
 */
export function to_platform_shape(platform: MediaPlatform, details: MediaDetails): Record<string, any> {
    switch (platform) {
        case "youtube":
            return {
                title: details.title,
                description: details.description,
                tags: details.tags ?? [],
                hashtags: details.hashtags ?? [],
                keywords: details.keywords ?? [],
                category: details.category ?? null,
                language: details.language ?? null,
            };
        case "instagram":
            return {
                title: details.title,
                caption: details.caption ?? details.description,
                hashtags: details.hashtags ?? [],
                keywords: details.keywords ?? [],
            };
        case "facebook":
            return {
                title: details.title,
                caption: details.caption ?? details.description,
                description: details.description,
                hashtags: details.hashtags ?? [],
                keywords: details.keywords ?? [],
            };
        default:
            return {
                title: details.title,
                description: details.description,
                tags: details.tags ?? [],
                hashtags: details.hashtags ?? [],
            };
    }
}
