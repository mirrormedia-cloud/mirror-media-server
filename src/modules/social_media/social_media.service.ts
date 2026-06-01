/**
 * Social media account management — port of yt-backend/src/app/youtube/service.ts
 * with the same env vars (GOOGLE_CLIENT_ID, SECRET_KEY, GOOGLE_REDIRECT_URI)
 * so existing Google Console authorized redirect URIs keep working.
 *
 * Phase 1: YouTube only. Facebook + Instagram routes return 501 with a
 * "not yet ported" hint so the frontend can surface the gap clearly.
 *
 * Tokens are stored on `social_accounts` per-user. They never leave the
 * service in raw form — `account_dto()` strips them before any caller
 * sees the row.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { google } from "googleapis";
import axios from "axios";
import { Op } from "sequelize";
import { SocialAccount } from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import type { SupportedPlatform } from "./social_media.dto";

// ── OAuth helpers ──────────────────────────────────────────────────────

const YOUTUBE_SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
];

/**
 * Build a fresh OAuth2 client per request — googleapis caches credentials
 * on the instance, and we don't want one user's tokens leaking into
 * another's request via a shared client.
 */
function youtube_oauth_client() {
    // YOUTUBE_REDIRECT_URI lets us point the YouTube callback at this
    // backend without disturbing GOOGLE_REDIRECT_URI (which Drive set up
    // pointing at the OAuth Playground for one-off refresh-token grants).
    const redirect_uri =
        process.env.YOUTUBE_REDIRECT_URI
        ?? process.env.GOOGLE_REDIRECT_URI;
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.SECRET_KEY,
        redirect_uri,
    );
}

function encode_state(payload: Record<string, any>): string {
    return Buffer.from(JSON.stringify(payload)).toString("base64");
}
function decode_state(state: string): { user_id?: string; platform?: string } {
    try {
        const json = Buffer.from(state, "base64").toString("utf8");
        const obj = JSON.parse(json);
        // yt-backend used `userId` — accept both for compat.
        return { user_id: obj.user_id ?? obj.userId, platform: obj.platform };
    } catch {
        return {};
    }
}

// ── DTO ────────────────────────────────────────────────────────────────

function ts(value: any): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Strip tokens before exposing to the API. Compute remaining seconds. */
export function account_dto(a: SocialAccount) {
    const expires_at = (a as any).expires_at as Date | null | undefined;
    const remaining_seconds = expires_at
        ? Math.max(0, Math.floor((new Date(expires_at).getTime() - Date.now()) / 1000))
        : null;
    return {
        id: a.id,
        platform: a.platform,
        account_id: a.account_id ?? null,
        account_name: a.account_name ?? null,
        page_id: a.page_id ?? null,
        page_name: a.page_name ?? null,
        channel_id: a.channel_id ?? null,
        channel_name: a.channel_name ?? null,
        scopes: a.scopes ?? [],
        status: a.status ?? "connected",
        // Token state — but never the tokens themselves.
        has_access_token: !!a.access_token,
        has_refresh_token: !!a.refresh_token,
        token_type: a.token_type ?? null,
        expiresAt: ts(expires_at),
        remaining_seconds,
        metadata: a.metadata ?? {},
        createdAt: ts((a as any).createdAt),
        updatedAt: ts((a as any).updatedAt),
    };
}

// ── Logging ────────────────────────────────────────────────────────────

function slog(step: string, data?: Record<string, any>) {
    const safe = data ? Object.fromEntries(
        Object.entries(data).map(([k, v]) =>
            /access_token|refresh_token|secret|password|cookie|authorization/i.test(k)
                ? [k, typeof v === "string" ? `<redacted:${v.length}>` : "<redacted>"]
                : [k, v],
        ),
    ) : undefined;
    console.log(`[social] ${step}${safe ? " " + JSON.stringify(safe) : ""}`);
}

// ── Listing ────────────────────────────────────────────────────────────

export async function list_accounts(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");

    const rows = await SocialAccount.findAll({
        where: { user_id } as any,
        order: [["createdAt", "DESC"]],
    });
    return success("Social accounts fetched", { accounts: rows.map(account_dto) });
}

// ── Connect: build consent URL ─────────────────────────────────────────

export async function get_connect_url(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { platform } = req.params as { platform: SupportedPlatform };
    const { platform: caller_kind } = (req.query ?? {}) as { platform?: string };

    slog("connect_url_start", { user_id, platform, caller_kind });

    if (platform === "youtube") {
        if (!process.env.GOOGLE_CLIENT_ID || !process.env.SECRET_KEY) {
            slog("youtube_oauth_not_configured", {
                has_client_id: !!process.env.GOOGLE_CLIENT_ID,
                has_secret: !!process.env.SECRET_KEY,
                has_redirect: !!(process.env.YOUTUBE_REDIRECT_URI ?? process.env.GOOGLE_REDIRECT_URI),
            });
            return error(HttpStatus.BAD_REQUEST, "YouTube OAuth not configured. Set GOOGLE_CLIENT_ID, SECRET_KEY, YOUTUBE_REDIRECT_URI in .env");
        }
        const oauth2 = youtube_oauth_client();
        const state = encode_state({ user_id, platform: caller_kind ?? "web" });
        const url = oauth2.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: YOUTUBE_SCOPES,
            state,
        });
        slog("connect_url_built", { user_id, platform });
        return success("Consent URL created", { url, platform });
    }

    if (platform === "facebook" || platform === "instagram") {
        // Same OAuth dance for both — Instagram Business is linked to a
        // Facebook Page, so the FB consent grants both. The callback
        // creates a row for whichever platforms are actually present.
        if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET || !process.env.FACEBOOK_REDIRECT_URI) {
            slog("facebook_oauth_not_configured", {
                has_app_id: !!process.env.FACEBOOK_APP_ID,
                has_app_secret: !!process.env.FACEBOOK_APP_SECRET,
                has_redirect: !!process.env.FACEBOOK_REDIRECT_URI,
            });
            return error(HttpStatus.BAD_REQUEST, "Facebook OAuth not configured. Set FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FACEBOOK_REDIRECT_URI in .env");
        }
        const state = encode_state({ user_id, platform: caller_kind ?? "web", origin: platform });
        const params = new URLSearchParams({
            client_id: process.env.FACEBOOK_APP_ID,
            redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
            state,
            scope: FACEBOOK_SCOPES.join(","),
            response_type: "code",
        });
        const url = `https://www.facebook.com/${FACEBOOK_GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
        slog("connect_url_built", { user_id, platform });
        return success("Consent URL created", { url, platform });
    }

    return error(501, `${platform} connect not supported.`);
}

// ── Facebook OAuth (used for both Facebook Page + Instagram Business) ─

const FACEBOOK_GRAPH_VERSION = "v18.0";
const FACEBOOK_GRAPH_URL = process.env.GRAPH_URL || `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}`;
const FACEBOOK_SCOPES = [
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
    "pages_manage_metadata",
    "instagram_basic",
    "instagram_content_publish",
    "business_management",
];

interface FbPage {
    id: string;
    name: string;
    access_token: string;
}

async function fb_exchange_code_for_token(code: string): Promise<{ access_token: string; expires_in?: number }> {
    const res = await axios.get(`${FACEBOOK_GRAPH_URL}/oauth/access_token`, {
        params: {
            client_id: process.env.FACEBOOK_APP_ID,
            client_secret: process.env.FACEBOOK_APP_SECRET,
            redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
            code,
        },
    });
    return res.data;
}

async function fb_exchange_for_long_lived(short_token: string): Promise<{ access_token: string; expires_in?: number }> {
    const res = await axios.get(`${FACEBOOK_GRAPH_URL}/oauth/access_token`, {
        params: {
            grant_type: "fb_exchange_token",
            client_id: process.env.FACEBOOK_APP_ID,
            client_secret: process.env.FACEBOOK_APP_SECRET,
            fb_exchange_token: short_token,
        },
    });
    return res.data;
}

async function fb_get_pages(user_long_token: string): Promise<FbPage[]> {
    const res = await axios.get(`${FACEBOOK_GRAPH_URL}/me/accounts`, {
        params: { access_token: user_long_token },
    });
    return (res.data?.data ?? []) as FbPage[];
}

async function fb_get_instagram_business_id(page_id: string, page_token: string): Promise<string | null> {
    const res = await axios.get(`${FACEBOOK_GRAPH_URL}/${page_id}`, {
        params: { fields: "instagram_business_account", access_token: page_token },
    });
    return res.data?.instagram_business_account?.id ?? null;
}

async function fb_get_instagram_username(ig_id: string, page_token: string): Promise<string | null> {
    try {
        const res = await axios.get(`${FACEBOOK_GRAPH_URL}/${ig_id}`, {
            params: { fields: "username", access_token: page_token },
        });
        return res.data?.username ?? null;
    } catch {
        return null;
    }
}

/**
 * Public callback. Hit by Facebook after the user grants consent.
 * Exchanges code → user token → long-lived token → page tokens.
 * Creates a `facebook` row for the first Page found, plus an
 * `instagram` row when the page has a linked Instagram Business
 * account. Closes the popup window after.
 */
export async function facebook_callback(req: FastifyRequest, reply: FastifyReply) {
    const { code, state, error: oauth_error } = (req.query ?? {}) as {
        code?: string;
        state?: string;
        error?: string;
    };

    const close_popup = (msg?: string) => {
        const safe = msg ? msg.replace(/'/g, "\\'") : "";
        const body = msg
            ? `<script>alert('${safe}');window.close();</script>`
            : `<script>window.close();</script>`;
        reply.header("Content-Type", "text/html").send(body);
    };

    if (oauth_error) {
        slog("facebook_callback_oauth_error", { oauth_error });
        return close_popup(`OAuth error: ${oauth_error}`);
    }
    if (!code || !state) {
        slog("facebook_callback_missing_params", { has_code: !!code, has_state: !!state });
        return close_popup("Missing OAuth code or state");
    }

    const { user_id, platform: caller_kind, origin } = decode_state(state) as any;
    if (!user_id) {
        slog("facebook_callback_bad_state", { state_length: state.length });
        return close_popup("Invalid OAuth state");
    }

    try {
        // Step 1: code → short-lived user token.
        const short = await fb_exchange_code_for_token(code);
        slog("fb_short_token_received", { user_id, expires_in: short.expires_in });
        // Step 2: short-lived → long-lived user token.
        const long = await fb_exchange_for_long_lived(short.access_token);
        slog("fb_long_token_received", { user_id, expires_in: long.expires_in });
        const long_token = long.access_token;
        const long_expires_at = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null;

        // Step 3: pages list.
        const pages = await fb_get_pages(long_token);
        slog("fb_pages_fetched", { user_id, count: pages.length });
        if (pages.length === 0) {
            return close_popup("No Facebook Pages found on this account. Create or be admin of a Page and retry.");
        }
        const page = pages[0]!;   // pick first page; UI can offer chooser later

        // Step 4: linked Instagram Business id (optional).
        const ig_id = await fb_get_instagram_business_id(page.id, page.access_token);
        const ig_username = ig_id ? await fb_get_instagram_username(ig_id, page.access_token) : null;
        slog("fb_instagram_linked", { user_id, page_id: page.id, ig_id });

        // Step 5: persist Facebook row (upsert by user + page_id).
        const fb_where = { user_id, platform: "facebook" as const, page_id: page.id } as any;
        const fb_existing = await SocialAccount.findOne({ where: fb_where });
        if (fb_existing) {
            await fb_existing.update({
                page_name: page.name,
                account_id: page.id,
                account_name: page.name,
                access_token: page.access_token,
                refresh_token: long_token,    // long-lived user token (FB has no refresh — we re-exchange)
                token_type: "Bearer",
                expires_at: long_expires_at,
                scopes: FACEBOOK_SCOPES,
                metadata: { fb_user_long_token_expires_at: long_expires_at?.toISOString() ?? null },
                status: "connected",
            } as any);
            slog("fb_account_updated", { user_id, account_id: fb_existing.id });
        } else {
            const created = await SocialAccount.create({
                user_id,
                platform: "facebook",
                account_id: page.id,
                account_name: page.name,
                page_id: page.id,
                page_name: page.name,
                access_token: page.access_token,
                refresh_token: long_token,
                token_type: "Bearer",
                expires_at: long_expires_at,
                scopes: FACEBOOK_SCOPES,
                metadata: { fb_user_long_token_expires_at: long_expires_at?.toISOString() ?? null },
                status: "connected",
            } as any);
            slog("fb_account_created", { user_id, account_id: created.id });
        }

        // Step 6: persist Instagram row when present (uses the same Page token).
        if (ig_id) {
            const ig_where = { user_id, platform: "instagram" as const, account_id: ig_id } as any;
            const ig_existing = await SocialAccount.findOne({ where: ig_where });
            const ig_payload = {
                user_id,
                platform: "instagram" as const,
                account_id: ig_id,
                account_name: ig_username,
                page_id: page.id,         // FB Page that hosts this IG account
                page_name: page.name,
                access_token: page.access_token,   // IG publish uses the Page token
                refresh_token: long_token,
                token_type: "Bearer",
                expires_at: long_expires_at,
                scopes: ["instagram_basic", "instagram_content_publish"],
                metadata: { instagram_business_account_id: ig_id, fb_page_id: page.id },
                status: "connected",
            };
            if (ig_existing) {
                await ig_existing.update(ig_payload as any);
                slog("ig_account_updated", { user_id, account_id: ig_existing.id });
            } else {
                const created = await SocialAccount.create(ig_payload as any);
                slog("ig_account_created", { user_id, account_id: created.id });
            }
        }

        const which = origin === "instagram"
            ? (ig_id ? "Instagram Connected Successfully!" : "Facebook Page connected, but no linked Instagram Business account was found.")
            : "Facebook Connected Successfully!";
        if (caller_kind === "app") return close_popup(which);
        return close_popup();
    } catch (err: any) {
        slog("facebook_callback_failed", { user_id, error: err?.message ?? String(err), details: err?.response?.data });
        return close_popup(`Error connecting Facebook: ${err?.message ?? "unknown"}`);
    }
}

// ── Callback: exchange code, store tokens ──────────────────────────────

/**
 * Public route — Google hits it directly after the user grants consent.
 * No JWT preHandler. We pull the user_id from the base64-encoded `state`.
 *
 * Sends an HTML response that closes the popup window; matches yt-backend
 * so existing frontend OAuth flows behave the same.
 */
export async function youtube_callback(req: FastifyRequest, reply: FastifyReply) {
    const { code, state, error: oauth_error } = (req.query ?? {}) as {
        code?: string;
        state?: string;
        error?: string;
    };

    const close_popup = (msg?: string) => {
        const safe = msg ? msg.replace(/'/g, "\\'") : "";
        const body = msg
            ? `<script>alert('${safe}');window.close();</script>`
            : `<script>window.close();</script>`;
        reply.header("Content-Type", "text/html").send(body);
    };

    if (oauth_error) {
        slog("youtube_callback_oauth_error", { oauth_error });
        return close_popup(`OAuth error: ${oauth_error}`);
    }
    if (!code || !state) {
        slog("youtube_callback_missing_params", { has_code: !!code, has_state: !!state });
        return close_popup("Missing OAuth code or state");
    }

    const { user_id, platform: caller_kind } = decode_state(state);
    if (!user_id) {
        slog("youtube_callback_bad_state", { state_length: state.length });
        return close_popup("Invalid OAuth state");
    }

    try {
        const oauth2 = youtube_oauth_client();
        const { tokens } = await oauth2.getToken(code);
        oauth2.setCredentials(tokens);
        slog("youtube_tokens_received", {
            user_id,
            has_access_token: !!tokens.access_token,
            has_refresh_token: !!tokens.refresh_token,
            expiry_date: tokens.expiry_date,
        });

        // Pull the channel info so we can show "channel_name" in the UI.
        const youtube = google.youtube({ version: "v3", auth: oauth2 });
        const channel_res = await youtube.channels.list({ part: ["snippet"], mine: true });
        const channel = channel_res.data.items?.[0];
        const channel_id = channel?.id ?? null;
        const channel_title = channel?.snippet?.title ?? null;

        slog("youtube_channel_fetched", { user_id, channel_id, channel_title });

        const expires_at = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

        // Upsert by (user_id, platform, channel_id). Allows multiple
        // channels per user without overwriting each other.
        const where = { user_id, platform: "youtube" as const, channel_id } as any;
        const existing = channel_id ? await SocialAccount.findOne({ where }) : null;

        // Google's refresh tokens for unverified-app projects expire after
        // 7 days. We schedule a proactive reminder for ~6 days from now so
        // the user gets a heads-up 1 day before re-auth becomes necessary.
        // The cron below clears this column once the reminder fires.
        const reconnect_reminder_at = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);

        if (existing) {
            await existing.update({
                channel_name: channel_title,
                account_id: channel_id,
                account_name: channel_title,
                access_token: tokens.access_token ?? existing.access_token,
                // Google only sends a refresh_token on first consent (or with
                // prompt=consent); preserve the existing one if absent.
                refresh_token: tokens.refresh_token ?? existing.refresh_token,
                token_type: tokens.token_type ?? existing.token_type ?? "Bearer",
                expires_at,
                scopes: YOUTUBE_SCOPES,
                status: "connected",
                reconnect_reminder_at,
            } as any);
            slog("youtube_account_updated", { user_id, account_id: existing.id, channel_id });
        } else {
            const created = await SocialAccount.create({
                user_id,
                platform: "youtube",
                account_id: channel_id,
                account_name: channel_title,
                channel_id,
                channel_name: channel_title,
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                token_type: tokens.token_type ?? "Bearer",
                expires_at,
                scopes: YOUTUBE_SCOPES,
                metadata: {},
                status: "connected",
                reconnect_reminder_at,
            } as any);
            slog("youtube_account_created", { user_id, account_id: created.id, channel_id });
        }

        if (caller_kind === "app") {
            return close_popup("YouTube Connected Successfully!");
        }
        return close_popup();
    } catch (err: any) {
        slog("youtube_callback_failed", { user_id, error: err?.message ?? String(err) });
        return close_popup(`Error connecting to YouTube: ${err?.message ?? "unknown"}`);
    }
}

// ── Status ─────────────────────────────────────────────────────────────

export async function get_platform_status(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { platform } = req.params as { platform: SupportedPlatform };

    const rows = await SocialAccount.findAll({
        where: { user_id, platform } as any,
        order: [["createdAt", "DESC"]],
    });
    if (rows.length === 0) {
        return success(`${platform} not connected`, {
            platform,
            connected: false,
            accounts: [],
        });
    }
    return success(`${platform} connection status`, {
        platform,
        connected: true,
        accounts: rows.map(account_dto),
    });
}

// ── Refresh token (YouTube) ────────────────────────────────────────────

/**
 * Refresh one specific account's token. Reusable by the manual endpoint
 * AND the proactive token-refresh cron. Throws on failure (callers map
 * the error to their own response shape) and updates the account in-place
 * on success.
 */
export async function refresh_account_token(account: SocialAccount): Promise<SocialAccount> {
    if (account.platform === "youtube") {
        const oauth2 = youtube_oauth_client();
        if (account.refresh_token) {
            oauth2.setCredentials({ refresh_token: account.refresh_token });
        }
        const { credentials } = await oauth2.refreshAccessToken();
        slog("youtube_token_refreshed", {
            account_id: account.id,
            expiry_date: credentials.expiry_date,
        });
        // Roll the reconnect-reminder forward 6 days on every successful
        // refresh. The reminder is intended to catch users whose refresh
        // chain has been silent for ~6 days (i.e. about to hit Google's
        // 7-day refresh-token expiry on unverified apps).
        await account.update({
            access_token: credentials.access_token ?? account.access_token,
            refresh_token: credentials.refresh_token ?? account.refresh_token,
            token_type: credentials.token_type ?? account.token_type ?? "Bearer",
            expires_at: credentials.expiry_date ? new Date(credentials.expiry_date) : (account as any).expires_at,
            status: "connected",
            reconnect_reminder_at: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
        } as any);
        return account;
    }

    if (account.platform === "facebook" || account.platform === "instagram") {
        const long = await fb_exchange_for_long_lived(account.refresh_token!);
        const long_expires_at = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null;
        await account.update({
            refresh_token: long.access_token,
            expires_at: long_expires_at,
            status: "connected",
        } as any);
        slog(`${account.platform}_token_refreshed`, {
            account_id: account.id,
            expires_in: long.expires_in,
        });
        return account;
    }

    throw new Error(`${account.platform} token refresh not supported`);
}

/**
 * Force a token refresh. Returns the updated account row.
 * For YouTube the refresh is automatic on every API call as long as a
 * refresh_token is present — but exposing this manually lets the UI
 * show "Refresh now" and surfaces errors immediately.
 */
export async function refresh_token(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { platform } = req.params as { platform: SupportedPlatform };

    const account = await SocialAccount.findOne({
        where: { user_id, platform, refresh_token: { [Op.not]: null } } as any,
        order: [["createdAt", "DESC"]],
    });
    if (!account) return error(HttpStatus.NOT_FOUND, `No connected ${platform} account with a refresh token`);

    try {
        await refresh_account_token(account);
        return success("Token refreshed", account_dto(account));
    } catch (err: any) {
        slog(`${platform}_refresh_failed`, { user_id, account_id: account.id, error: err?.message });
        await account.update({ status: "expired" } as any);
        return error(HttpStatus.BAD_REQUEST, `Refresh failed: ${err?.message ?? "unknown"}`);
    }
}

// ── Disconnect ─────────────────────────────────────────────────────────

export async function disconnect_platform(req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return error(HttpStatus.UNAUTHORIZED, "Not authenticated");
    const { platform } = req.params as { platform: SupportedPlatform };

    const rows = await SocialAccount.findAll({ where: { user_id, platform } as any });
    if (rows.length === 0) {
        return success("Nothing to disconnect", { platform, removed: 0 });
    }
    let removed = 0;
    for (const r of rows) {
        try {
            await r.destroy();   // paranoid soft-delete
            removed += 1;
        } catch (err: any) {
            slog("disconnect_error", { account_id: r.id, error: err?.message });
        }
    }
    slog("disconnect_done", { user_id, platform, removed });
    return success(`${platform} disconnected`, { platform, removed });
}
