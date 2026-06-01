import { FastifyRequest } from "fastify";
import { Op } from "sequelize";
import { Session, NotificationHistory, User, UserNotificationSettings, UserProfile } from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import { sendPushToUser } from "../../services/notification/firebase-notification.service";
import { sendWhatsappTextMessage } from "../../utils/whatsapp/send.message";
import { config } from "../../config";

// ─── Token / Permission ────────────────────────────────────────────────────

export async function registerToken(req: FastifyRequest) {
    try {
        const body = req.body as {
            fcm_token: string;
            notification_permission?: "default" | "granted" | "denied";
            device_type?: string;
            device_name?: string;
            browser?: string;
            os?: string;
        };

        if (!req.sessionId) {
            return error(HttpStatus.UNAUTHORIZED, "Session not found — sign out and back in");
        }

        // A physical device can only belong to one user at a time. Clear this
        // FCM token from every other session (any user) so that a test-broadcast
        // or any fanout doesn't deliver the same push N times to one device
        // just because it was previously logged into N different accounts.
        await Session.update(
            { fcm_token: null, fcm_token_updated_at: null } as any,
            { where: { fcm_token: body.fcm_token, id: { [Op.ne]: req.sessionId } } as any }
        );

        const patch: Record<string, any> = {
            fcm_token: body.fcm_token,
            fcm_token_updated_at: new Date(),
            notification_permission: body.notification_permission ?? "granted",
        };
        if (body.device_type) patch.device_type = body.device_type;
        if (body.device_name) patch.device_name = body.device_name;
        if (body.browser) patch.browser = body.browser;
        if (body.os) patch.os = body.os;

        await Session.update(patch as any, {
            where: { id: req.sessionId, user_id: req.userId } as any,
        });

        return success("Token registered");
    } catch (err) {
        console.log("Error:- registerToken", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function updatePermission(req: FastifyRequest) {
    try {
        const { notification_permission } = req.body as {
            notification_permission: "default" | "granted" | "denied";
        };

        if (!req.sessionId) {
            return error(HttpStatus.UNAUTHORIZED, "Session not found — sign out and back in");
        }

        const patch: Record<string, any> = { notification_permission };
        if (notification_permission === "denied") {
            patch.fcm_token = null;
            patch.fcm_token_updated_at = null;
        }

        await Session.update(patch as any, {
            where: { id: req.sessionId, user_id: req.userId } as any,
        });

        return success("Permission updated");
    } catch (err) {
        console.log("Error:- updatePermission", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

// ─── History / Read ────────────────────────────────────────────────────────

export async function getHistory(req: FastifyRequest) {
    try {
        const q = req.query as {
            page?: number;
            page_size?: number;
            unread_only?: boolean;
            module?: string;
            type?: string;
            status?: "unread" | "read" | "failed";
            priority?: string;
            channel?: string;
            search?: string;
        };

        const page = q.page ?? 1;
        const page_size = q.page_size ?? 20;
        const offset = (page - 1) * page_size;

        const where: Record<string, any> = { user_id: req.userId };

        // legacy unread_only kept for NotificationBell compatibility
        if (q.unread_only) where.is_read = false;

        // new status filter (takes precedence over unread_only)
        if (q.status === "unread") {
            where.is_read = false;
            where.error_message = null;
        } else if (q.status === "read") {
            where.is_read = true;
        } else if (q.status === "failed") {
            where.error_message = { [Op.ne]: null };
        }

        if (q.module) where.module = q.module;
        if (q.type) where.type = q.type;
        if (q.priority) where.priority = q.priority;
        if (q.channel) where.channel = q.channel;

        if (q.search) {
            const like = { [Op.iLike]: `%${q.search}%` };
            where[Op.or as any] = [
                { title: like },
                { message: like },
                { module: like },
            ];
        }

        const { rows, count } = await NotificationHistory.findAndCountAll({
            where,
            order: [["created_at", "DESC"]],
            limit: page_size,
            offset,
            raw: true,
        });

        const unread_count = await NotificationHistory.count({
            where: { user_id: req.userId, is_read: false } as any,
        });

        return success("History fetched", {
            items: rows,
            total: count,
            unread_count,
            page,
            page_size,
        });
    } catch (err) {
        console.log("Error:- getHistory", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function getUnreadCount(req: FastifyRequest) {
    try {
        const count = await NotificationHistory.count({
            where: { user_id: req.userId, is_read: false } as any,
        });
        return success("Unread count fetched", { count });
    } catch (err) {
        console.log("Error:- getUnreadCount", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function getNotificationById(req: FastifyRequest) {
    try {
        const { id } = req.params as { id: string };
        const item = await NotificationHistory.findOne({
            where: { id, user_id: req.userId } as any,
            raw: true,
        });
        if (!item) return error(HttpStatus.NOT_FOUND, "Notification not found");
        return success("Notification fetched", item);
    } catch (err) {
        console.log("Error:- getNotificationById", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function markRead(req: FastifyRequest) {
    try {
        const { id } = req.params as { id: string };
        const [affected] = await NotificationHistory.update(
            { is_read: true, read_at: new Date() } as any,
            { where: { id, user_id: req.userId } as any }
        );
        if (affected === 0) return error(HttpStatus.NOT_FOUND, "Notification not found");
        return success("Marked as read");
    } catch (err) {
        console.log("Error:- markRead", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function markAllRead(req: FastifyRequest) {
    try {
        await NotificationHistory.update(
            { is_read: true, read_at: new Date() } as any,
            { where: { user_id: req.userId, is_read: false } as any }
        );
        return success("All marked as read");
    } catch (err) {
        console.log("Error:- markAllRead", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function deleteNotification(req: FastifyRequest) {
    try {
        const { id } = req.params as { id: string };
        const deleted = await NotificationHistory.destroy({
            where: { id, user_id: req.userId } as any,
        });
        if (deleted === 0) return error(HttpStatus.NOT_FOUND, "Notification not found");
        const unread_count = await NotificationHistory.count({
            where: { user_id: req.userId, is_read: false } as any,
        });
        return success("Notification deleted", { unread_count });
    } catch (err) {
        console.log("Error:- deleteNotification", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function clearReadNotifications(req: FastifyRequest) {
    try {
        const deleted = await NotificationHistory.destroy({
            where: { user_id: req.userId, is_read: true } as any,
        });
        return success(`Cleared ${deleted} read notification${deleted !== 1 ? "s" : ""}`);
    } catch (err) {
        console.log("Error:- clearReadNotifications", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

// ─── Sessions ─────────────────────────────────────────────────────────────

export async function listSessions(req: FastifyRequest) {
    try {
        const rows = await Session.findAll({
            where: { user_id: req.userId, is_active: true } as any,
            attributes: [
                "id", "device_type", "device_name", "browser", "os", "ip_address",
                "notification_permission", "last_seen_at", "login_time",
            ],
            order: [["last_seen_at", "DESC"]],
            raw: true,
        });
        return success("Sessions fetched", {
            items: rows.map((r: any) => ({
                ...r,
                is_current: r.id === req.sessionId,
                push_enabled: r.notification_permission === "granted",
            })),
        });
    } catch (err) {
        console.log("Error:- listSessions", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function logoutSession(req: FastifyRequest) {
    try {
        const { session_id } = req.params as { session_id: string };
        const [affected] = await Session.update(
            {
                is_active: false,
                logout_time: new Date(),
                fcm_token: null,
                fcm_token_updated_at: null,
                notification_permission: "default",
                jwt: null,
            } as any,
            { where: { id: session_id, user_id: req.userId } as any }
        );
        if (affected === 0) return error(HttpStatus.NOT_FOUND, "Session not found");
        return success("Session ended");
    } catch (err) {
        console.log("Error:- logoutSession", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

// ─── Notification Settings ─────────────────────────────────────────────────

export async function getNotificationSettings(req: FastifyRequest) {
    try {
        const profile = await UserProfile.findOne({
            where: { user_id: req.userId } as any,
            attributes: ["whatsapp_country_code", "whatsapp_no"],
            raw: true,
        });
        const eligable_for_whatsapp = !!(
            String((profile as any)?.whatsapp_country_code ?? "").trim() &&
            String((profile as any)?.whatsapp_no ?? "").trim()
        );

        const settings = await UserNotificationSettings.findOne({
            where: { user_id: req.userId } as any,
            raw: true,
        });

        if (!settings) {
            return success("Settings fetched", {
                whatsapp_enabled: false,
                app_notification_enabled: true,
                whatsapp_api_configured: isWhatsAppConfigured(),
                eligable_for_whatsapp,
            });
        }

        return success("Settings fetched", {
            whatsapp_enabled: (settings as any).whatsapp_enabled,
            app_notification_enabled: (settings as any).app_notification_enabled,
            whatsapp_api_configured: isWhatsAppConfigured(),
            eligable_for_whatsapp,
        });
    } catch (err) {
        console.log("Error:- getNotificationSettings", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

export async function updateNotificationSettings(req: FastifyRequest) {
    try {
        const body = req.body as {
            whatsapp_enabled?: boolean;
            app_notification_enabled?: boolean;
        };

        // Always compute eligibility for the response so clients don't lose the key
        // after PATCH (mobile UI depends on it for toggle state).
        const profile = await UserProfile.findOne({
            where: { user_id: req.userId } as any,
            attributes: ["whatsapp_country_code", "whatsapp_no"],
            raw: true,
        });
        const eligable_for_whatsapp = !!(
            String((profile as any)?.whatsapp_country_code ?? "").trim() &&
            String((profile as any)?.whatsapp_no ?? "").trim()
        );

        // When enabling WhatsApp, verify the user has a WhatsApp number in their profile.
        if (body.whatsapp_enabled === true) {
            if (!eligable_for_whatsapp) {
                return error(HttpStatus.BAD_REQUEST, "Add your WhatsApp number in Profile before enabling WhatsApp notifications");
            }
        }

        await UserNotificationSettings.upsert({
            user_id: req.userId,
            ...(body.whatsapp_enabled !== undefined && { whatsapp_enabled: body.whatsapp_enabled }),
            ...(body.app_notification_enabled !== undefined && { app_notification_enabled: body.app_notification_enabled }),
        } as any);

        const updated = await UserNotificationSettings.findOne({
            where: { user_id: req.userId } as any,
            raw: true,
        });

        return success("Settings updated", {
            whatsapp_enabled: (updated as any)?.whatsapp_enabled ?? false,
            app_notification_enabled: (updated as any)?.app_notification_enabled ?? true,
            whatsapp_api_configured: isWhatsAppConfigured(),
            eligable_for_whatsapp,
        });
    } catch (err) {
        console.log("Error:- updateNotificationSettings", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

function isWhatsAppConfigured(): boolean {
    try {
        return !!(
            (config as any).whatsapp?.accessToken &&
            (config as any).whatsapp?.phoneNumberId
        );
    } catch {
        return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
    }
}

export async function sendTestWhatsApp(req: FastifyRequest) {
    try {
        if (!isWhatsAppConfigured()) {
            return error(HttpStatus.BAD_REQUEST, "WhatsApp API is not configured on this server");
        }

        const settings = await UserNotificationSettings.findOne({
            where: { user_id: req.userId } as any,
            raw: true,
        });

        if (!settings || !(settings as any).whatsapp_enabled) {
            return error(HttpStatus.BAD_REQUEST, "WhatsApp notifications are not enabled. Enable them in settings first.");
        }

        const profile = await UserProfile.findOne({
            where: { user_id: req.userId } as any,
            raw: true,
        });
        const country = ((profile as any)?.whatsapp_country_code ?? "").replace("+", "");
        const number = country + ((profile as any)?.whatsapp_no ?? "");
        if (!number) {
            return error(HttpStatus.BAD_REQUEST, "No WhatsApp number in your profile. Add it in Profile settings first.");
        }

        const result = await sendWhatsappTextMessage(
            number,
            "Mirror Media Cloud Notification Test\n\nWhatsApp notifications are enabled successfully."
        );

        if (!result.status) {
            return error(HttpStatus.INTERNAL_SERVER_ERROR, `WhatsApp send failed: ${result.message}`);
        }

        return success("Test WhatsApp message sent successfully");
    } catch (err) {
        console.log("Error:- sendTestWhatsApp", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}

// ─── Test Broadcast ────────────────────────────────────────────────────────

const TEST_BROADCAST_USER_CAP = 500;

const TEST_BROADCAST_WHATSAPP_NUMBER = "919265739309";

export async function sendTestBroadcast(req: FastifyRequest) {
    try {
        const users = await User.findAll({
            where: { is_active: true, email_verified: true } as any,
            attributes: ["id", "email"],
            order: [["createdAt", "ASC"]],
            limit: TEST_BROADCAST_USER_CAP,
            raw: true,
        });

        // Numbers that have already been WhatsApp'd by the per-user fanout —
        // used to skip the post-loop info ping so we don't deliver twice to
        // the same phone when a user's profile matches the dev test number.
        const broadcast_whatsapp_recipients = new Set<string>();

        // Pre-load WhatsApp-enabled users' profiles so we can record which
        // numbers will receive a per-user WhatsApp inside sendPushToUser.
        const enabled_settings = await UserNotificationSettings.findAll({
            where: { user_id: { [Op.in]: users.map((u: any) => u.id) }, whatsapp_enabled: true } as any,
            attributes: ["user_id"],
            raw: true,
        });
        const enabled_user_ids = new Set<string>(enabled_settings.map((s: any) => s.user_id));
        if (enabled_user_ids.size > 0) {
            const profiles = await UserProfile.findAll({
                where: { user_id: { [Op.in]: Array.from(enabled_user_ids) } } as any,
                attributes: ["user_id", "whatsapp_country_code", "whatsapp_no"],
                raw: true,
            });
            for (const p of profiles as any[]) {
                const code = String(p.whatsapp_country_code ?? "").replace(/[^0-9]/g, "");
                const number = String(p.whatsapp_no ?? "").replace(/[^0-9]/g, "");
                if (code && number) broadcast_whatsapp_recipients.add(code + number);
            }
        }

        const results: Array<{
            user_id: string;
            email: string | null;
            total_tokens: number;
            sent_push: boolean;
        }> = [];

        for (const u of users as any[]) {
            try {
                const r = await sendPushToUser({
                    user_id: u.id,
                    title: "Test Notification",
                    body: "If you can see this, web push is wired up end-to-end.",
                    type: "info",
                    module: "system",
                    event_type: "test_broadcast",
                    related_id: req.userId ?? "test",
                    redirect_url: "/dashboard",
                    skip_dedup: true,
                });
                results.push({
                    user_id: u.id,
                    email: u.email ?? null,
                    total_tokens: r.total_tokens,
                    sent_push: r.sent_push,
                });
            } catch (err) {
                console.log("Error:- sendTestBroadcast user", u.id, err);
                results.push({ user_id: u.id, email: u.email ?? null, total_tokens: 0, sent_push: false });
            }
        }

        // One-shot info ping to the dev test number so the broadcast endpoint
        // exercises the WhatsApp send path independently of any user's
        // toggle. Skipped if the number was already messaged by the per-user
        // loop above — otherwise the dev sees two identical WhatsApps.
        if (!broadcast_whatsapp_recipients.has(TEST_BROADCAST_WHATSAPP_NUMBER)) {
            try {
                const info_body = [
                    "ℹ️ Notification — *Mirror Media Cloud*",
                    "",
                    "*Test Broadcast*",
                    "",
                    "Broadcast complete — WhatsApp send path is healthy.",
                    "",
                    "— Mirror Media Cloud",
                ].join("\n");
                await sendWhatsappTextMessage(TEST_BROADCAST_WHATSAPP_NUMBER, info_body);
            } catch (err) {
                console.log("Error:- sendTestBroadcast whatsapp ping", err);
            }
        }

        return success("Test broadcast complete", {
            total_users: users.length,
            users_with_push: results.filter(r => r.sent_push).length,
            users_without_tokens: results.filter(r => r.total_tokens === 0).length,
            cap: TEST_BROADCAST_USER_CAP,
            results,
        });
    } catch (err) {
        console.log("Error:- sendTestBroadcast", err);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong");
    }
}
