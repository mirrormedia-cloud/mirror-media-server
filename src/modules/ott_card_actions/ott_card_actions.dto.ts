import { z } from "zod";

const ACTION_TYPES = ["open_detail", "call_child_api", "open_url", "copy_value", "custom_button"] as const;
const BUTTON_STYLES = ["primary", "secondary", "outline", "ghost", "danger"] as const;
const OPEN_TYPES = ["drawer", "page", "modal"] as const;

export const CreateCardActionDto = z.object({
    label: z.string().min(1).max(100),
    action_type: z.enum(ACTION_TYPES),
    child_api_id: z.string().uuid().nullable().optional(),
    value_path: z.string().nullable().optional(),
    button_style: z.enum(BUTTON_STYLES).optional(),
    icon: z.string().nullable().optional(),
    open_type: z.enum(OPEN_TYPES).optional(),
    sort_order: z.number().int().min(0).optional(),
    config: z.record(z.string(), z.any()).optional(),
    is_default_card_click: z.boolean().optional(),
}).superRefine((val, ctx) => {
    if (val.action_type === "call_child_api" && !val.child_api_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["child_api_id"], message: "child_api_id is required for call_child_api" });
    }
    if ((val.action_type === "copy_value" || val.action_type === "open_url") && !val.value_path) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value_path"], message: "value_path is required for this action_type" });
    }
});

export const UpdateCardActionDto = z.object({
    label: z.string().min(1).max(100).optional(),
    action_type: z.enum(ACTION_TYPES).optional(),
    child_api_id: z.string().uuid().nullable().optional(),
    value_path: z.string().nullable().optional(),
    button_style: z.enum(BUTTON_STYLES).optional(),
    icon: z.string().nullable().optional(),
    open_type: z.enum(OPEN_TYPES).optional(),
    sort_order: z.number().int().min(0).optional(),
    config: z.record(z.string(), z.any()).optional(),
    is_active: z.boolean().optional(),
    is_default_card_click: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "No fields provided" });

export type CreateCardActionInput = z.infer<typeof CreateCardActionDto>;
export type UpdateCardActionInput = z.infer<typeof UpdateCardActionDto>;
