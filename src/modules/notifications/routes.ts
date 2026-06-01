import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { validate } from "../../shared/http/validate";
import { HttpStatus } from "../../shared/http/status";
import { serverError } from "../../shared/http/response";
import {
    RegisterTokenDto,
    PermissionDto,
    HistoryQueryDto,
    NotificationIdDto,
    SessionIdDto,
    NotificationSettingsDto,
} from "./dto";
import {
    registerToken,
    updatePermission,
    getHistory,
    getUnreadCount,
    getNotificationById,
    markRead,
    markAllRead,
    deleteNotification,
    clearReadNotifications,
    listSessions,
    logoutSession,
    getNotificationSettings,
    updateNotificationSettings,
    sendTestWhatsApp,
    sendTestBroadcast,
} from "./service";

const wrap =
    (fn: (req: FastifyRequest) => Promise<any>, label: string) =>
        async (req: FastifyRequest, res: FastifyReply) => {
            try {
                const result = await fn(req);
                const code = result?.success?.code || result?.error?.code;
                res.status(code).send(result);
            } catch (err) {
                console.log(`Error:- ${label}`, err);
                res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
            }
        };

export const notificationPublicRoutes: FastifyPluginAsync = async (app) => {
    app.get("/test-broadcast", wrap(sendTestBroadcast, "sendTestBroadcast"));
};

export const notificationRoutes: FastifyPluginAsync = async (app) => {
    // Token / permission
    app.post("/register-token", { preHandler: validate(RegisterTokenDto) }, wrap(registerToken, "registerToken"));
    app.post("/permission", { preHandler: validate(PermissionDto) }, wrap(updatePermission, "updatePermission"));

    // History + count
    app.get("/history", { preHandler: validate(HistoryQueryDto, "query") }, wrap(getHistory, "getHistory"));
    app.get("/unread-count", wrap(getUnreadCount, "getUnreadCount"));
    app.get("/:id", { preHandler: validate(NotificationIdDto, "params") }, wrap(getNotificationById, "getNotificationById"));

    // Mark read (POST kept for bell backward compat, PATCH added for new page)
    app.post("/:id/read", { preHandler: validate(NotificationIdDto, "params") }, wrap(markRead, "markRead"));
    app.patch("/:id/read", { preHandler: validate(NotificationIdDto, "params") }, wrap(markRead, "markRead"));
    app.post("/read-all", wrap(markAllRead, "markAllRead"));
    app.patch("/mark-all-read", wrap(markAllRead, "markAllRead"));

    // Delete
    app.delete("/:id", { preHandler: validate(NotificationIdDto, "params") }, wrap(deleteNotification, "deleteNotification"));
    app.delete("/clear-read", wrap(clearReadNotifications, "clearReadNotifications"));

    // Settings
    app.get("/settings", wrap(getNotificationSettings, "getNotificationSettings"));
    app.patch("/settings", { preHandler: validate(NotificationSettingsDto) }, wrap(updateNotificationSettings, "updateNotificationSettings"));

    // WhatsApp test
    app.post("/test-whatsapp", wrap(sendTestWhatsApp, "sendTestWhatsApp"));

    // Sessions
    app.get("/sessions", wrap(listSessions, "listSessions"));
    app.post("/sessions/:session_id/logout", { preHandler: validate(SessionIdDto, "params") }, wrap(logoutSession, "logoutSession"));
};
