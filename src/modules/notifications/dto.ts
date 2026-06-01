import { z } from "zod";

export const RegisterTokenDto = z.object({
    fcm_token: z.string().min(10),
    notification_permission: z.enum(["default", "granted", "denied"]).optional(),
    device_type: z.string().max(30).optional(),
    device_name: z.string().max(150).optional(),
    browser: z.string().max(100).optional(),
    os: z.string().max(100).optional(),
});

export const PermissionDto = z.object({
    notification_permission: z.enum(["default", "granted", "denied"]),
});

export const HistoryQueryDto = z.object({
    page: z.coerce.number().int().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    unread_only: z.coerce.boolean().optional(),
    module: z.string().max(50).optional(),
    type: z.enum(["error", "warning", "reminder", "info"]).optional(),
    // new filters
    status: z.enum(["unread", "read", "failed"]).optional(),
    priority: z.enum(["low", "normal", "high", "critical"]).optional(),
    channel: z.enum(["app", "whatsapp", "both"]).optional(),
    search: z.string().max(200).optional(),
});

export const NotificationIdDto = z.object({
    id: z.string().uuid(),
});

export const SessionIdDto = z.object({
    session_id: z.string().uuid(),
});

export const NotificationSettingsDto = z.object({
    whatsapp_enabled: z.boolean().optional(),
    app_notification_enabled: z.boolean().optional(),
});
