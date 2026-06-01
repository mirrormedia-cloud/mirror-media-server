import { z } from "zod";

export const SUPPORTED_PLATFORMS = ["youtube", "facebook", "instagram"] as const;
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export const PlatformParamSchema = z.object({
    platform: z.enum(SUPPORTED_PLATFORMS),
});
export const PlatformParamDto = PlatformParamSchema;
export type PlatformParamInput = z.infer<typeof PlatformParamSchema>;

/**
 * `state` carries the user_id (from JWT) + an originating "platform"
 * (web vs app) base64-encoded so the OAuth callback knows which user
 * to attach the tokens to. Matches yt-backend's encoding so existing
 * Google Console authorized redirect URIs keep working.
 */
export const ConnectQueryDto = z.object({
    /** Web vs app — controls how the popup is closed. */
    platform: z.enum(["web", "app"]).optional(),
});
export type ConnectQueryInput = z.infer<typeof ConnectQueryDto>;

export const CallbackQueryDto = z.object({
    code: z.string().min(1),
    state: z.string().min(1),
    error: z.string().optional(),
});
export type CallbackQueryInput = z.infer<typeof CallbackQueryDto>;

export const AccountIdParamDto = z.object({
    account_id: z.string().uuid(),
});
export type AccountIdParamInput = z.infer<typeof AccountIdParamDto>;
