import { z } from "zod";

const ButtonSchema = z.object({
    title: z.string().min(1).max(100),
    action: z.string().default("url"),
    url: z.string().url().optional().or(z.literal("")),
});

export const CreateAutomationDto = z.object({
    platform: z.enum(["instagram", "facebook"]).default("instagram"),
    type: z.enum(["comment"]).default("comment"),
    ig_account_id: z.string().min(1, "Account ID is required"),
    trigger_keywords: z.array(z.string().min(1)).min(1, "At least one keyword is required"),
    comment_reply: z.object({ text: z.string().min(1, "Comment reply text is required") }),
    dm_message: z.object({
        text: z.string().min(1, "DM text is required"),
        buttons: z.array(ButtonSchema).default([]),
    }),
    status: z.enum(["active", "inactive"]).default("active"),
});

export const UpdateAutomationDto = CreateAutomationDto.partial().omit({ ig_account_id: true });

export type CreateAutomationInput = z.infer<typeof CreateAutomationDto>;
export type UpdateAutomationInput = z.infer<typeof UpdateAutomationDto>;
