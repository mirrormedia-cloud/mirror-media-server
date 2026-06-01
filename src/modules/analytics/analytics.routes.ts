import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { AnalyticsQueryDto } from "./analytics.dto";
import { get_social_analytics, get_today_analytics } from "./analytics.service";
import { validate } from "../../shared/http/validate";
import { HttpStatus } from "../../shared/http/status";
import { serverError } from "../../shared/http/response";

const wrap = (fn: (req: FastifyRequest, res: FastifyReply) => Promise<any>) =>
    async (req: FastifyRequest, res: FastifyReply) => {
        try {
            const result = await fn(req, res);
            const code = result?.success?.code || result?.error?.code;
            res.status(code).send(result);
        } catch (err) {
            console.log("Error:- analytics.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
    // GET /api/analytics/social — live YouTube + Facebook + Instagram
    // analytics. Filters: platform/status/date_range/search.
    app.get(
        "/social",
        { preHandler: validate(AnalyticsQueryDto, "query") },
        wrap(get_social_analytics),
    );

    // GET /api/analytics/social/today — dedicated today-only endpoint.
    // Always runs in counts-only mode and filters to the local-day
    // window. Cheaper than /social so the frontend's Today card can
    // refresh independently. Independent cache namespace.
    app.get("/social/today", wrap(get_today_analytics));
};
