import { z } from "zod";

export const CaptureVideoAssetsDto = z.object({
    api_node_id: z.string().uuid(),
    source_response_id: z.string().uuid().nullable().optional(),
    parent_api_id: z.string().uuid().nullable().optional(),
    item_key: z.string().nullable().optional(),
    list_path: z.string().nullable().optional(),
    video_url_paths: z.array(z.string().min(1)).min(1, { message: "At least one video_url_path is required" }),
    title_path: z.string().nullable().optional(),
    description_path: z.string().nullable().optional(),
    thumbnail_path: z.string().nullable().optional(),
    quality_path: z.string().nullable().optional(),
    language_path: z.string().nullable().optional(),
    duration_path: z.string().nullable().optional(),
});

export const ListVideoAssetsQueryDto = z.object({
    search: z.string().optional(),
    video_type: z.string().optional(),
    api_node_id: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const DownloadVideoQueryDto = z.object({
    mode: z.enum(["playlist"]).optional(),
});

export type CaptureVideoAssetsInput = z.infer<typeof CaptureVideoAssetsDto>;
export type ListVideoAssetsQueryInput = z.infer<typeof ListVideoAssetsQueryDto>;
export type DownloadVideoQueryInput = z.infer<typeof DownloadVideoQueryDto>;
