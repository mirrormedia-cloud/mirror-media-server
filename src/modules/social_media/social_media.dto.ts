import { z } from "zod";

export const SUPPORTED_PLATFORMS = ["youtube", "facebook", "instagram", "tiktok", "telegram"] as const;
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

/** Telegram has no OAuth — the user pastes a bot token + channel. */
export const TelegramConnectDto = z.object({
    telegram_bot_token: z.string().trim()
        .regex(/^\d+:[A-Za-z0-9_-]{20,}$/, "Bot token looks invalid — copy it from @BotFather (format 123456:ABC…)"),
    telegram_channel_username: z.string().trim().min(1, "Channel username is required").max(200),
});
export type TelegramConnectInput = z.infer<typeof TelegramConnectDto>;

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
