import { z } from "zod";

export const SignedUploadUrlDto = z.object({
    file_name: z.string().min(1).max(500),
    file_type: z.string().min(1).max(50),
    content_type: z.string().min(1).max(200),
    folder: z.string().min(1).max(200).optional(),
});
export type SignedUploadUrlInput = z.infer<typeof SignedUploadUrlDto>;

export const CompleteUploadDto = z.object({
    key: z.string().min(1).max(1000),
    file_url: z.string().min(1).max(2000).optional(),
    file_type: z.string().min(1).max(50),
    mime_type: z.string().max(200).optional(),
    file_size: z.number().int().nonnegative().optional(),
    // Library row context — when supplied, /complete-upload inserts a
    // row into ott_library_items so the file becomes visible. Without
    // these, the endpoint is a no-op acknowledgement.
    ott_id: z.string().uuid().optional(),
    title: z.string().max(500).optional(),
    file_name: z.string().max(500).optional(),
    file_ext: z.string().max(20).optional(),
    parent_item_key: z.string().max(200).nullable().optional(),
    parent_title: z.string().max(200).nullable().optional(),
    save_type: z.enum(["video", "image", "thumbnail", "audio", "playlist"]).optional(),
    /**
     * Webkitdirectory-style relative path for folder uploads
     * ("MyShow/Season 1/ep1.mp4"). When set, the backend creates a
     * folder-placeholder chain for the leading directory segments
     * (rooted at `parent_item_key` when supplied) and pins the new
     * library row under the leaf folder. Files without a relative
     * path land directly in `parent_item_key`.
     */
    relative_path: z.string().max(1000).optional(),
});
export type CompleteUploadInput = z.infer<typeof CompleteUploadDto>;
