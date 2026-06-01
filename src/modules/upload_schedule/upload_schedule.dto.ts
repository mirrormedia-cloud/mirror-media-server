import { z } from "zod";

export const SUPPORTED_PLATFORMS = ["facebook", "youtube", "instagram"] as const;
export type SupportedPlatform = typeof SUPPORTED_PLATFORMS[number];

export const FREQUENCIES = ["every_day", "every_week", "every_month", "custom_range"] as const;
export type Frequency = typeof FREQUENCIES[number];

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

const time_string = z.string().regex(TIME_REGEX, { message: "must be HH:MM (24h)" });
const date_string = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be YYYY-MM-DD" });

const PreviewBaseDto = z.object({
    ott_id: z.string().uuid(),
    library_item_ids: z.array(z.string().uuid()).min(1, { message: "at least one library item is required" }),
    scheduled: z.boolean().optional().default(true),
    platforms: z.array(z.enum(SUPPORTED_PLATFORMS)).min(1, { message: "at least one platform is required" }),
    frequency: z.enum(FREQUENCIES).optional().nullable(),
    release_count: z.coerce.number().int().min(1).max(50).optional().default(1),
    upload_times: z.array(time_string).optional().default([]),
    start_date: date_string.optional().nullable(),
    end_date: date_string.optional().nullable(),
    weekdays: z.array(z.coerce.number().int().min(0).max(6)).optional().default([]),
    month_days: z.array(z.coerce.number().int().min(1).max(31)).optional().default([]),
    color: z.string().max(50).optional().nullable(),
    title_prefix: z.string().max(255).optional().nullable(),
    description: z.string().optional().nullable(),
    tags: z.array(z.string()).optional().default([]),
    name: z.string().max(255).optional().nullable(),
    /** Free-form pass-through. Used by the Media modal to record the source
     *  story folder (parent_item_key, parent_api_id, parent_title) so the
     *  schedules detail page can show "Story Folder: ..." without a join. */
    metadata: z.record(z.any()).optional(),

    /**
     * When true, missing per-platform fields (title, description, caption,
     * tags, hashtags) are filled from a Gemini analysis at preview / save
     * time. Manually-supplied fields are preserved per-field.
     */
    auto_details: z.boolean().optional().default(false),

    /**
     * Manual values that override generated ones for every platform. For
     * per-platform overrides, pass `platform_details` instead.
     */
    manual_details: z.object({
        title: z.string().max(500).optional(),
        description: z.string().max(10000).optional(),
        caption: z.string().max(10000).optional(),
        tags: z.array(z.string()).optional(),
        hashtags: z.array(z.string()).optional(),
    }).partial().optional(),

    /**
     * Per-platform manual overrides. Wins over both `manual_details` and
     * the generated values, per-field. Shape:
     *   { youtube: { title, description, tags, hashtags },
     *     instagram: { caption, hashtags }, ... }
     */
    platform_details: z.record(z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        caption: z.string().optional(),
        tags: z.array(z.string()).optional(),
        hashtags: z.array(z.string()).optional(),
    }).partial()).optional(),
});

const refine_schedule = (val: z.infer<typeof PreviewBaseDto>, ctx: z.RefinementCtx) => {
    if (val.scheduled === false) return; // draft — schedule fields not required
    if (!val.frequency) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["frequency"], message: "is required when scheduled is true" });
    }
    if (!val.start_date) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["start_date"], message: "is required when scheduled is true" });
    }
    if (!val.upload_times || val.upload_times.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["upload_times"], message: "must include at least one time" });
    }
    if (val.frequency === "custom_range") {
        if (!val.end_date) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["end_date"], message: "is required for custom_range" });
        } else if (val.start_date && val.end_date < val.start_date) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["end_date"], message: "must be on or after start_date" });
        }
    }
};

export const PreviewScheduleDto = PreviewBaseDto.superRefine(refine_schedule);
export const CreateScheduleDto = PreviewBaseDto.superRefine(refine_schedule);

export type PreviewScheduleInput = z.infer<typeof PreviewScheduleDto>;
export type CreateScheduleInput = z.infer<typeof CreateScheduleDto>;

export const ListSchedulesQueryDto = z.object({
    ott_id: z.string().uuid().optional(),
    status: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListSchedulesQueryInput = z.infer<typeof ListSchedulesQueryDto>;
