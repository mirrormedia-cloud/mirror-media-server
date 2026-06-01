import { z } from "zod";

export const ANALYTICS_PLATFORMS = ["all", "youtube", "facebook", "instagram"] as const;
export type AnalyticsPlatform = typeof ANALYTICS_PLATFORMS[number];

export const ANALYTICS_STATUSES = ["all", "published", "scheduled", "failed", "processing", "draft"] as const;
export type AnalyticsStatus = typeof ANALYTICS_STATUSES[number];

export const ANALYTICS_DATE_RANGES = ["today", "last_7_days", "last_30_days", "custom"] as const;
export type AnalyticsDateRange = typeof ANALYTICS_DATE_RANGES[number];

const date_string = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be YYYY-MM-DD" });

export const AnalyticsQueryDto = z.object({
    platform: z.enum(ANALYTICS_PLATFORMS).optional().default("all"),
    status: z.enum(ANALYTICS_STATUSES).optional().default("all"),
    date_range: z.enum(ANALYTICS_DATE_RANGES).optional(),
    start_date: date_string.optional(),
    end_date: date_string.optional(),
    search: z.string().max(200).optional(),
    /** Hard cap per platform — bound on enumeration AND insights work.
     *  Default 200 (channel-sized), max 1000. Pagination is implemented
     *  in the fetcher so a request for 200 items walks the platform's
     *  cursor-paginated list endpoint until either we hit the cap or
     *  the platform runs out of pages. */
    limit_per_platform: z.coerce.number().int().min(1).max(1000).optional().default(200),
    /** Force a fresh fetch even when the in-memory cache has a recent
     *  result. Set by the "Refresh Analytics" button. */
    force_refresh: z.coerce.boolean().optional(),
    /** Include the per-row `items` array in the response. The new
     *  dashboard hides the table — summary cards + donut chart only —
     *  so by default we omit `items` and save bandwidth + serialisation
     *  cost. Pass `include_items=true` to opt back in. */
    include_items: z.coerce.boolean().optional().default(false),
    /** Counts-only mode: skip every per-video insights call (the
     *  slow ones). Returns just the platform video/post/reel COUNT.
     *  Default true — that's what the new dashboard wants. Set false
     *  if you ever need per-row likes/views/reach for an export. */
    counts_only: z.coerce.boolean().optional().default(true),
});
export type AnalyticsQueryInput = z.infer<typeof AnalyticsQueryDto>;
