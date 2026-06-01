/**
 * Two route plugins:
 *
 *   socialMediaPublicRoutes  — mounted OUTSIDE the JWT scope. Hosts the
 *                              OAuth callback that Google redirects to;
 *                              auth comes from the base64-encoded `state`
 *                              parameter, not a Bearer token.
 *
 *   socialMediaRoutes        — everything else (connect URL, status,
 *                              refresh, disconnect, list) — JWT-protected.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
    PlatformParamDto,
    ConnectQueryDto,
} from "./social_media.dto";
import {
    list_accounts,
    get_connect_url,
    youtube_callback,
    facebook_callback,
    get_platform_status,
    refresh_token,
    disconnect_platform,
} from "./social_media.service";
import { validate } from "../../shared/http/validate";
import { HttpStatus } from "../../shared/http/status";
import { serverError } from "../../shared/http/response";

const wrap = (fn: (req: FastifyRequest, res: FastifyReply) => Promise<any>) =>
    async (req: FastifyRequest, res: FastifyReply) => {
        try {
            const result = await fn(req, res);
            // The callback handler writes its own response (HTML), so it
            // returns void — only forward the envelope when one came back.
            if (!result) return;
            const code = result?.success?.code || result?.error?.code;
            res.status(code).send(result);
        } catch (err) {
            console.log("Error:- social_media.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

/**
 * PUBLIC — Google's OAuth servers hit this. Mounted at the path that
 * matches GOOGLE_REDIRECT_URI in your env (e.g. /api/social/youtube/callback).
 * No JWT required; we trust the base64-encoded state instead.
 */
export const socialMediaPublicRoutes: FastifyPluginAsync = async (app) => {
    app.get("/youtube/callback", async (req, reply) => {
        try {
            await youtube_callback(req, reply);
        } catch (err) {
            console.log("Error:- youtube_callback unhandled", err);
            if (!reply.sent) reply.header("Content-Type", "text/html").send("<script>window.close();</script>");
        }
    });
    // Facebook + Instagram share this callback. Whether the user clicked
    // "Connect Facebook" or "Connect Instagram" is encoded in `state` so
    // the popup closes with the right confirmation message.
    app.get("/facebook/callback", async (req, reply) => {
        try {
            await facebook_callback(req, reply);
        } catch (err) {
            console.log("Error:- facebook_callback unhandled", err);
            if (!reply.sent) reply.header("Content-Type", "text/html").send("<script>window.close();</script>");
        }
    });
};

/**
 * PROTECTED — JWT preHandler is added by the parent scope in app.ts.
 */
export const socialMediaRoutes: FastifyPluginAsync = async (app) => {
    // GET /api/social/accounts — every connected account for the user.
    app.get("/accounts", wrap(list_accounts));

    // GET /api/social/:platform/connect → returns the consent URL the
    // frontend should open (popup). Pass ?platform=app to make the
    // popup do an alert before closing.
    app.get(
        "/:platform/connect",
        { preHandler: [validate(PlatformParamDto, "params"), validate(ConnectQueryDto, "query")] },
        wrap(get_connect_url),
    );

    // GET /api/social/:platform/status — connected? channel name?
    // remaining seconds until token expiry?
    app.get(
        "/:platform/status",
        { preHandler: validate(PlatformParamDto, "params") },
        wrap(get_platform_status),
    );

    // POST /api/social/:platform/refresh_token — force a token refresh
    // (only useful for YouTube; auto-refresh kicks in on every API call
    // anyway, but this gives the UI a "Refresh now" affordance).
    app.post(
        "/:platform/refresh_token",
        { preHandler: validate(PlatformParamDto, "params") },
        wrap(refresh_token),
    );

    // POST /api/social/:platform/disconnect — soft-delete the account row(s).
    app.post(
        "/:platform/disconnect",
        { preHandler: validate(PlatformParamDto, "params") },
        wrap(disconnect_platform),
    );
};
