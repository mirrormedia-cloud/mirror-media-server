/**
 * Firebase Cloud Messaging integration.
 *
 * One initialised app per process (lazy — boot succeeds even if creds are
 * missing, so non-push-using dev users don't have to provision Firebase).
 * Push fanout reads every active session row that has both `fcm_token` and
 * `notification_permission = 'granted'`, sends the same payload to each,
 * and clears the fcm_token on sessions whose token Firebase rejected as
 * unregistered/invalid.
 *
 * Deduplication: a 30-minute window keyed by (user_id, event_type,
 * related_id) prevents the same error from spamming a user when the upstream
 * job retries quickly. The dedup is best-effort — a race could let two go
 * through, but that's fine; we'd rather over-deliver than under-deliver on
 * a transient race.
 */

import { Op } from "sequelize";
import * as fs from "fs";
import * as path from "path";
import { Session, NotificationHistory, UserNotificationSettings, UserProfile } from "../../db/models";
import { sendWhatsappTextMessage } from "../../utils/whatsapp/send.message";

type AdminModule = typeof import("firebase-admin");

let admin: AdminModule | null = null;
let initialized = false;
let initError: string | null = null;

/**
 * Credential source: `backend/firebase-service-account.json`. The user pastes
 * the full service-account JSON downloaded from Firebase Console there. We
 * intentionally do NOT read env vars — env-var indirection produced silent
 * failures when `\n` escapes in the private key weren't preserved. Reading
 * the raw JSON file removes that whole class of bug.
 */
const SERVICE_ACCOUNT_PATH = path.join(process.cwd(), "firebase-service-account.json");

interface ServiceAccountFile {
    project_id?: string;
    client_email?: string;
    private_key?: string;
    [key: string]: unknown;
}

function loadServiceAccount(): ServiceAccountFile | null {
    try {
        if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
            initError = `firebase-service-account.json not found at ${SERVICE_ACCOUNT_PATH}`;
            return null;
        }
        const raw = fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8");
        const json = JSON.parse(raw) as ServiceAccountFile;
        if (!json.project_id || !json.client_email || !json.private_key) {
            initError = "firebase-service-account.json is missing project_id / client_email / private_key — fill the file with your Firebase service-account JSON";
            return null;
        }
        return json;
    } catch (err: any) {
        initError = `failed to read firebase-service-account.json: ${err?.message ?? err}`;
        return null;
    }
}

/**
 * Lazy-load firebase-admin so the project boots even if the package isn't
 * installed yet (dev convenience — phase-2 creates the service but a fresh
 * checkout won't have `firebase-admin` in node_modules until `npm install`).
 */
function getAdmin(): AdminModule | null {
    if (initialized) return initError ? null : admin;
    initialized = true;

    const serviceAccount = loadServiceAccount();
    if (!serviceAccount) {
        console.log(`[firebase] ${initError}`);
        return null;
    }

    try {
        // require() lets us skip module resolution when the package isn't there.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        admin = require("firebase-admin") as AdminModule;
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: serviceAccount.project_id!,
                    clientEmail: serviceAccount.client_email!,
                    privateKey: serviceAccount.private_key!,
                }),
            });
        }
        console.log(`[firebase] initialized (project_id=${serviceAccount.project_id})`);
        return admin;
    } catch (err: any) {
        initError = err?.message || "firebase-admin not installed";
        console.log(`[firebase] init failed: ${initError}`);
        admin = null;
        return null;
    }
}

export type NotificationType = "error" | "warning" | "reminder" | "info";

export interface SendPushArgs {
    user_id: string;
    title: string;
    body: string;
    type: NotificationType;
    module: string;
    event_type: string;
    related_id?: string | null;
    redirect_url?: string | null;
    /** Free-form extras delivered in the FCM `data` field. All values stringified. */
    data?: Record<string, string>;
    /**
     * Skip the 30-minute dedup window. Use for reminders fired by the cron
     * (the cron's own UNIQUE constraint on calendar_event_reminders already
     * guarantees uniqueness — dedup'ing again here would suppress them).
     */
    skip_dedup?: boolean;
    /** Optional triggering session for audit. */
    session_id?: string | null;
}

export interface SendPushResult {
    total_tokens: number;
    success_count: number;
    failed_count: number;
    sent_push: boolean;
    history_id: string | null;
    deduped?: boolean;
    /** True when in-app push + history were suppressed by the user's settings. */
    in_app_suppressed?: boolean;
    /** True when a WhatsApp message was successfully delivered alongside the push. */
    sent_whatsapp?: boolean;
}

const DEDUP_WINDOW_MS = 30 * 60 * 1000;

const TYPE_HEADER: Record<NotificationType, string> = {
    error: "🔴 Alert",
    warning: "⚠️ Warning",
    reminder: "⏰ Reminder",
    info: "ℹ️ Notification",
};

/** Build the WhatsApp text body shown to the user. Markdown-style * for bold. */
function buildWhatsappBody(args: SendPushArgs): string {
    const lines: string[] = [];
    lines.push(`${TYPE_HEADER[args.type] ?? "ℹ️ Notification"} — *Mirror Media Cloud*`);
    lines.push("");
    lines.push(`*${args.title}*`);
    if (args.body) {
        lines.push("");
        lines.push(args.body);
    }
    if (args.module) {
        lines.push("");
        lines.push(`_Module:_ ${args.module}`);
    }
    if (args.redirect_url) {
        lines.push(`_Open:_ ${args.redirect_url}`);
    }
    lines.push("");
    lines.push("— Mirror Media Cloud");
    return lines.join("\n");
}

const INVALID_TOKEN_CODES = new Set([
    "messaging/invalid-registration-token",
    "messaging/registration-token-not-registered",
    "messaging/invalid-argument",
]);

/** Truncate so we never blow past FCM's payload caps. */
function trunc(s: string, max: number): string {
    if (!s) return s;
    return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Strip null/undefined and force every value to string. FCM data fields are string-only. */
function flattenData(input: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) {
        if (v === null || v === undefined) continue;
        out[k] = String(v);
    }
    return out;
}

/**
 * Check the dedup window. Returns true if we recently sent the same
 * (user_id, event_type, related_id) combo and should suppress this one.
 */
async function isDuplicate(args: SendPushArgs): Promise<boolean> {
    if (args.skip_dedup) return false;
    const since = new Date(Date.now() - DEDUP_WINDOW_MS);
    const existing = await NotificationHistory.findOne({
        where: {
            user_id: args.user_id,
            event_type: args.event_type,
            // related_id can be null — Sequelize handles `null` correctly with eq.
            related_id: args.related_id ?? null,
            created_at: { [Op.gte]: since },
        } as any,
        raw: true,
    });
    return !!existing;
}

export async function sendPushToUser(args: SendPushArgs): Promise<SendPushResult> {
    if (await isDuplicate(args)) {
        return { total_tokens: 0, success_count: 0, failed_count: 0, sent_push: false, history_id: null, deduped: true };
    }

    // Per-user channel toggles. Missing row = defaults (app on, whatsapp off).
    const settings = (await UserNotificationSettings.findOne({
        where: { user_id: args.user_id } as any,
        raw: true,
    })) as any;
    const appEnabled = settings ? settings.app_notification_enabled !== false : true;
    const whatsappEnabled = !!settings?.whatsapp_enabled;

    // If WhatsApp is enabled, fan out alongside the push. Best-effort: a
    // WhatsApp failure must not block the in-app delivery, and vice versa.
    let sent_whatsapp = false;
    if (whatsappEnabled) {
        const profile = (await UserProfile.findOne({
            where: { user_id: args.user_id } as any,
            raw: true,
        })) as any;
        const code = String(profile?.whatsapp_country_code ?? "").replace(/[^0-9]/g, "");
        const number = String(profile?.whatsapp_no ?? "").replace(/[^0-9]/g, "");
        if (code && number) {
            try {
                const r = await sendWhatsappTextMessage(code + number, buildWhatsappBody(args));
                sent_whatsapp = !!r?.status;
            } catch (err: any) {
                console.log("[whatsapp] send failed:", err?.message ?? err);
            }
        } else {
            console.log(`[whatsapp] skipped for user ${args.user_id}: profile is missing whatsapp_country_code or whatsapp_no`);
        }
    }

    // In-app channel is OFF — skip the FCM fanout AND the NotificationHistory
    // write so the bell stays silent. WhatsApp above is independent.
    if (!appEnabled) {
        return {
            total_tokens: 0,
            success_count: 0,
            failed_count: 0,
            sent_push: false,
            history_id: null,
            in_app_suppressed: true,
            sent_whatsapp,
        };
    }

    // Look up the session rows whose tokens we'll target. Doing this BEFORE
    // recording history so the row's sent_push flag reflects reality.
    const allSessions = await Session.findAll({
        where: {
            user_id: args.user_id,
            is_active: true,
            notification_permission: "granted",
            fcm_token: { [Op.ne]: null },
        } as any,
        attributes: ["id", "fcm_token", "device_type", "device_name", "browser", "os", "fcm_token_updated_at"],
        // newest fcm_token first so the per-device dedupe below keeps the
        // most-recently-registered token when a single device has multiple
        // active sessions (e.g., browser tab + installed PWA).
        order: [["fcm_token_updated_at", "DESC"]],
        raw: true,
    });

    // Dedupe to ONE token per device. Same physical device with multiple
    // active sessions (web tab + PWA install, or re-login spawning a new
    // session row) was previously generating duplicate banners on that
    // device. Keying by device_type|device_name|browser|os keeps each
    // distinct device but collapses repeats on the same one.
    const seenDevices = new Set<string>();
    const sessions: Array<{ id: string; fcm_token: string | null }> = [];
    for (const s of allSessions as any[]) {
        if (!s.fcm_token) continue;
        const key = [s.device_type ?? "", s.device_name ?? "", s.browser ?? "", s.os ?? ""].join("|");
        if (seenDevices.has(key)) continue;
        seenDevices.add(key);
        sessions.push({ id: s.id, fcm_token: s.fcm_token });
    }
    const tokens = [...new Set(sessions.map((s) => s.fcm_token!).filter((t) => !!t))];
    const adm = getAdmin();

    let success_count = 0;
    let failed_count = 0;
    let sent_push = false;

    if (tokens.length > 0 && adm) {
        try {
            // `notification` + `data` payload. Reason: when the PWA is fully
            // closed, Chrome's push handler may not give our SW enough wall
            // time to run user code (onBackgroundMessage → showNotification).
            // With a top-level `notification` field, the Firebase SDK
            // auto-displays it via its own internal push handler — works
            // even if the SW would otherwise be slow / killed. In foreground
            // tabs, the SDK does NOT auto-display; only `onMessage` fires,
            // which our page-level handler turns into a toast. Net result:
            // one banner per push regardless of app state.
            //
            // `data` is duplicated for the page-side `onMessage` handler
            // (read `data.type`/`data.event_type` to pick toast variant).
            const payload: any = {
                tokens,
                notification: {
                    title: trunc(args.title, 100),
                    body: trunc(args.body, 240),
                },
                data: flattenData({
                    title: trunc(args.title, 100),
                    body: trunc(args.body, 240),
                    type: args.type,
                    module: args.module,
                    event_type: args.event_type,
                    related_id: args.related_id,
                    redirect_url: args.redirect_url,
                    ...(args.data ?? {}),
                }),
                webpush: {
                    // Click target. Both Chrome's auto-display path AND our
                    // SW's notificationclick handler honour this URL.
                    fcmOptions: args.redirect_url ? { link: args.redirect_url } : undefined,
                    // Icon/badge — Chrome merges these into the auto-displayed
                    // notification so we get our branding regardless of who
                    // renders it.
                    //
                    // requireInteraction:
                    //   - Desktop Chrome: notification stays on screen until
                    //     dismissed. Important for errors that can't be missed.
                    //     Mobile silently ignores this flag.
                    //   - We apply it to error/warning only; info/reminder
                    //     uses the default auto-dismiss so the user isn't
                    //     bombarded with sticky banners.
                    //
                    // vibrate:
                    //   - Mobile only — desktop ignores. Pattern is [vibrate,
                    //     pause, vibrate] in ms. Pairs with priority so a
                    //     phone in Doze mode wakes the screen briefly when
                    //     the push finally delivers.
                    notification: {
                        // ?v=2 busts Chrome's push-icon cache after the icon
                        // file was added/changed. Bump this whenever icons change.
                        icon: "/icons/icon-192.png?v=2",
                        badge: "/icons/icon-192.png?v=2",
                        requireInteraction: args.type === "error" || args.type === "warning",
                        vibrate: [200, 100, 200],
                        // Per-push unique tag. The previous event_type-based tag
                        // caused Android to coalesce multiple pushes into one
                        // entry — the merged notification frequently rendered
                        // without the icon and silently replaced the earlier
                        // one (because renotify was false for non-errors).
                        // Unique tag + renotify:true = each push is its own row.
                        tag: `${args.event_type || "n"}-${Date.now()}`,
                        renotify: true,
                    },
                    // Highest priority + 1-hour delivery window. `Urgency:
                    // high` tells the browser's push service to deliver
                    // even when the device is in Doze / battery saver
                    // (vs `normal` which can be queued indefinitely).
                    headers: {
                        Urgency: "high",
                        TTL: "3600",
                    },
                },
            };

            const resp = await adm.messaging().sendEachForMulticast(payload);
            success_count = resp.successCount;
            failed_count = resp.failureCount;
            sent_push = success_count > 0;

            // Walk the per-token responses and null-out the fcm_token on
            // sessions whose token Firebase declared unregistered/invalid.
            // Log the exact error code + message for everything that wasn't
            // a success — without this we have no signal whether tokens
            // are getting rejected because they're stale (auto-recoverable
            // by re-registering) vs the payload is malformed (caller's bug)
            // vs the project setup is wrong (Cloud Messaging API disabled,
            // VAPID mismatch, etc.) — three very different fixes.
            const invalidSessionIds: string[] = [];
            const errorSummary: Array<{ session_id: string; code: string; message: string }> = [];
            resp.responses.forEach((r, idx) => {
                if (r.success) return;
                const code = (r.error as any)?.code ?? "unknown";
                const message = (r.error as any)?.message ?? "";
                const sess = sessions[idx];
                if (!sess) return;
                errorSummary.push({ session_id: sess.id, code, message });
                if (INVALID_TOKEN_CODES.has(code)) {
                    invalidSessionIds.push(sess.id);
                }
            });
            if (errorSummary.length > 0) {
                console.log("[firebase] per-token errors:", JSON.stringify(errorSummary, null, 2));
            }
            if (invalidSessionIds.length > 0) {
                await Session.update(
                    {
                        fcm_token: null,
                        fcm_token_updated_at: null,
                        notification_permission: "default",
                    } as any,
                    { where: { id: { [Op.in]: invalidSessionIds } } as any }
                );
                console.log(`[firebase] cleared ${invalidSessionIds.length} invalid token(s)`);
            }
        } catch (err: any) {
            // Firebase outage / credential failure — record in history with
            // sent_push=false so the bell still shows the event.
            failed_count = tokens.length;
            console.log("[firebase] send failed:", err?.message ?? err);
        }
    }

    const history = await NotificationHistory.create({
        user_id: args.user_id,
        session_id: args.session_id ?? null,
        type: args.type,
        module: args.module,
        title: trunc(args.title, 255),
        message: args.body,
        event_type: args.event_type,
        related_id: args.related_id ?? null,
        redirect_url: args.redirect_url ?? null,
        sent_push,
        is_read: false,
    } as any);

    return {
        total_tokens: tokens.length,
        success_count,
        failed_count,
        sent_push,
        history_id: history.id,
        sent_whatsapp,
    };
}

/** Test helper — verify firebase is wired up at app boot or via an admin route. */
export function isFirebaseReady(): boolean {
    return getAdmin() !== null;
}
