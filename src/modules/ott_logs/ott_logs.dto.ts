import { z } from "zod";

export const ListLogsQueryDto = z.object({
    status: z.enum(["pending", "success", "failed"]).optional(),
    api_id: z.string().uuid().optional(),
    search: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type ListLogsQueryInput = z.infer<typeof ListLogsQueryDto>;
