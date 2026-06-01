// No request bodies — Quick Flow is a single GET. DTO file kept for parity
// with other modules so future filter params (e.g. ?include_logs=true) can be
// added here without restructuring.
import { z } from "zod";

export const QuickFlowQueryDto = z.object({
    // Reserved for future expansion — currently no params.
}).passthrough();

export type QuickFlowQueryInput = z.infer<typeof QuickFlowQueryDto>;
