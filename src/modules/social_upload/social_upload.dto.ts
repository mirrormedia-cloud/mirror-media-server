import { z } from "zod";

export const SUPPORTED_PLATFORMS = ["youtube", "facebook", "instagram"] as const;

/**
 * Manual values the user typed in the modal — used when auto_details is on
 * to override individual generated fields, OR (when auto_details is off)
 * as the only source of truth.
 */
export const ManualDetailsDto = z.object({
    title: z.string().max(500).optional(),
    description: z.string().max(10000).optional(),
    caption: z.string().max(10000).optional(),
    tags: z.array(z.string()).optional(),
    hashtags: z.array(z.string()).optional(),
}).partial();
export type ManualDetailsInput = z.infer<typeof ManualDetailsDto>;

export const UploadDto = z.object({
    library_item_id: z.string().uuid(),
    platforms: z.array(z.enum(SUPPORTED_PLATFORMS)).min(1, "Pick at least one platform"),
    /** Required only when `auto_details` is false. */
    title: z.string().max(255).optional(),
    description: z.string().max(5000).optional().default(""),
    tags: z.array(z.string()).optional().default([]),
    hashtags: z.array(z.string()).optional().default([]),
    /** ISO 8601. When set, platform schedules the publish for that time. */
    scheduledAt: z.string().datetime().optional(),
    visibility: z.enum(["public", "unlisted", "private"]).optional().default("private"),
    /** YouTube only — defaults to "22" (People & Blogs). */
    youtube_category_id: z.string().optional(),
    /** Schedule item this upload was triggered from, if any. */
    schedule_item_id: z.string().uuid().optional(),
    /**
     * When true, fill missing fields per-platform from a Gemini analysis
     * (cached if available, fresh otherwise). Manual fields take
     * precedence — empty fields are filled, non-empty fields are kept.
     */
    auto_details: z.boolean().optional().default(false),
    /**
     * Optional — when present, these values override generated ones for
     * EVERY platform. For per-platform overrides, use the higher-level
     * "schedule" flow which carries `platform_details`.
     */
    manual_details: ManualDetailsDto.optional(),
}).refine(
    v => !!v.auto_details || (typeof v.title === "string" && v.title.trim().length > 0),
    { path: ["title"], message: "Title is required when auto_details is off" },
);

export type UploadInput = z.infer<typeof UploadDto>;

export const ScheduleItemParamDto = z.object({
    schedule_item_id: z.string().uuid(),
});

export const ListUploadsQueryDto = z.object({
    library_item_id: z.string().uuid().optional(),
    platform: z.enum(SUPPORTED_PLATFORMS).optional(),
    status: z.string().optional(),
    search: z.string().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListUploadsQueryInput = z.infer<typeof ListUploadsQueryDto>;
