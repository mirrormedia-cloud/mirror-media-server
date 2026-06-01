import { z } from "zod";

export const ANALYSIS_PLATFORMS = ["youtube", "facebook", "instagram", "general"] as const;
export type AnalysisPlatform = typeof ANALYSIS_PLATFORMS[number];

export const ManualOverridesDto = z.object({
    title: z.string().max(500).optional(),
    description: z.string().max(10000).optional(),
    caption: z.string().max(10000).optional(),
    tags: z.array(z.string()).optional(),
    hashtags: z.array(z.string()).optional(),
}).partial();
export type ManualOverridesInput = z.infer<typeof ManualOverridesDto>;

export const AnalyzeDto = z.object({
    library_item_id: z.string().uuid(),
    ott_id: z.string().uuid().optional(),
    /** Defaults to "general" when omitted. */
    platform: z.enum(ANALYSIS_PLATFORMS).optional(),
    /** Free-form context the user types in (channel name, series, etc.). */
    context: z.string().max(2000).optional(),
    /** When false (default), an existing completed result for the same
     *  (user, library_item, platform) tuple is returned without re-running
     *  Gemini. When true, a fresh inference replaces the cached row. */
    force_refresh: z.boolean().optional(),
    /** Manual values that override the AI output before persisting. Empty
     *  strings/arrays are ignored — only truthy fields take precedence. */
    manual_overrides: ManualOverridesDto.optional(),
});
export type AnalyzeInput = z.infer<typeof AnalyzeDto>;

export const ListAnalysisQueryDto = z.object({
    ott_id: z.string().uuid().optional(),
    library_item_id: z.string().uuid().optional(),
    platform: z.enum(ANALYSIS_PLATFORMS).optional(),
    status: z.enum(["pending", "completed", "failed"]).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListAnalysisQueryInput = z.infer<typeof ListAnalysisQueryDto>;

export const LibraryItemParamDto = z.object({
    library_item_id: z.string().uuid(),
});

export const AnalysisIdParamDto = z.object({
    analysis_id: z.string().uuid(),
});

export const AnalyzeFromFileDto = z.object({
    file_path: z.string().min(1, "file_path is required"),
    platform: z.enum(["youtube", "facebook", "instagram", "general"]),
    context: z.string().max(2000).optional(),
    manual_details: ManualOverridesDto.optional(),
    prompt_type: z.string().max(100).optional(),
});
export type AnalyzeFromFileInput = z.infer<typeof AnalyzeFromFileDto>;
