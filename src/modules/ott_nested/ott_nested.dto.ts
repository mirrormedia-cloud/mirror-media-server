import { z } from "zod";

export const GetNestedQueryDto = z.object({
    card_index: z.coerce.number().int().min(0).optional(),
    source_response_id: z.string().uuid().optional(),
    parent_item_key: z.string().optional(),
    force_sync: z.union([z.literal("true"), z.literal("false"), z.boolean()]).optional(),
});

export type GetNestedQueryInput = z.infer<typeof GetNestedQueryDto>;
