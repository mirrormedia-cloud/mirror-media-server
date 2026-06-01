import { FastifyReply, FastifyRequest } from "fastify";
import { JWTHandler } from "./jwt";
import { error } from "../http/response";
import { HttpStatus } from "../http/status";
import { User, Session } from "../../db/models";

const PUBLIC_LIBRARY_MEDIA_RE = /^\/api\/ott\/[^/]+\/library\/[^/]+\/(?:stream|download)$/;

function isPublicMediaRequest(req: FastifyRequest) {
    if (req.method !== "GET") return false;
    const path = req.url.split("?")[0] ?? "";
    return PUBLIC_LIBRARY_MEDIA_RE.test(path);
}

export async function authenticate(req: FastifyRequest, res: FastifyReply) {
    try {
        // Browser <img>, <video>, and <a download> requests cannot attach the
        // localStorage JWT Authorization header. Keep the data-changing/listing
        // library APIs protected, but allow opaque-id media reads to stream.
        if (isPublicMediaRequest(req)) return;

        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith("Bearer ")) {
            return res.status(HttpStatus.UNAUTHORIZED).send(
                error(HttpStatus.UNAUTHORIZED, "Authentication required")
            );
        }

        const token = authHeader.slice(7);
        const payload = JWTHandler.verify(token) as { userId: string };

        if (!payload?.userId) {
            return res.status(HttpStatus.UNAUTHORIZED).send(
                error(HttpStatus.UNAUTHORIZED, "Invalid token")
            );
        }

        const user = await User.findOne({ where: { id: payload.userId }, raw: true });

        if (!user) {
            return res.status(HttpStatus.UNAUTHORIZED).send(
                error(HttpStatus.UNAUTHORIZED, "User not found")
            );
        }

        if (!user.email_verified) {
            return res.status(HttpStatus.UNAUTHORIZED).send(
                error(HttpStatus.UNAUTHORIZED, "Email not verified")
            );
        }

        if (!user.is_active) {
            return res.status(HttpStatus.UNAUTHORIZED).send(
                error(HttpStatus.UNAUTHORIZED, "User is not active")
            );
        }

        // Session check: a logged-out device sends the same JWT until the SPA
        // notices and clears it, AND an admin can delete sessions out from
        // under a logged-in client. Either case should bounce the request,
        // otherwise the JWT alone keeps the user authenticated until the
        // token's TTL expires — which can be days.
        const session = await Session.findOne({
            where: { jwt: token, user_id: user.id },
            raw: true,
        });

        if (!session) {
            // Session row missing entirely — admin/manual delete, or the
            // login flow failed to record one. Force re-auth either way.
            return res.status(HttpStatus.UNAUTHORIZED).send(
                error(HttpStatus.UNAUTHORIZED, "Session not found. Please sign in again")
            );
        }

        if (session.is_active === false) {
            return res.status(HttpStatus.UNAUTHORIZED).send(
                error(HttpStatus.UNAUTHORIZED, "Session ended. Please sign in again")
            );
        }

        req.userId = user.id;
        req.sessionId = session.id;

        // Cheap async write — don't await, the request shouldn't pay for it.
        // Failure here is harmless (last_seen_at is best-effort).
        Session.update(
            { last_seen_at: new Date() } as any,
            { where: { id: session.id } }
        ).catch(() => { /* ignore */ });
    } catch {
        return res.status(HttpStatus.UNAUTHORIZED).send(
            error(HttpStatus.UNAUTHORIZED, "Invalid or expired token")
        );
    }
}
