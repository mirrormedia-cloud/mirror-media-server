import { z } from "zod";

export const SaveToLibraryDto = z.object({
    video_asset_id: z.string().uuid(),
    save_video: z.boolean().optional(),
    save_image: z.boolean().optional(),
    save_thumbnail: z.boolean().optional(),
    convert_to_mp4: z.boolean().optional(),
});

export const SaveBulkToLibraryDto = z.object({
    video_asset_ids: z.array(z.string().uuid()).min(1, { message: "At least one video_asset_id is required" }),
    save_video: z.boolean().optional(),
    save_image: z.boolean().optional(),
    save_thumbnail: z.boolean().optional(),
    convert_to_mp4: z.boolean().optional(),
});

export const ListLibraryQueryDto = z.object({
    search: z.string().optional(),
    type: z.string().optional(),
    sort_by: z.enum([
        "newest",
        "oldest",
        "title_asc",
        "title_desc",
        "size_desc",
        "size_asc",
    ]).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100000).optional(),
    parent_item_key: z.string().optional(),
    parent_api_id: z.string().uuid().optional(),
    ungrouped_only: z.coerce.boolean().optional(),
});

export const SaveFromCardsDto = z.object({
    api_node_id: z.string().uuid(),
    source_response_id: z.string().uuid().nullable().optional(),
    card_indices: z.array(z.number().int().min(0)).min(1, { message: "At least one card_index is required" }),
    save_video: z.boolean().optional(),
    save_image: z.boolean().optional(),
    save_thumbnail: z.boolean().optional(),
    convert_to_mp4: z.boolean().optional(),
    parent_item_key: z.string().nullable().optional(),
    parent_title: z.string().nullable().optional(),
    parent_api_id: z.string().uuid().nullable().optional(),
});

export type SaveToLibraryInput = z.infer<typeof SaveToLibraryDto>;
export type SaveBulkToLibraryInput = z.infer<typeof SaveBulkToLibraryDto>;
export type ListLibraryQueryInput = z.infer<typeof ListLibraryQueryDto>;
export type SaveFromCardsInput = z.infer<typeof SaveFromCardsDto>;
