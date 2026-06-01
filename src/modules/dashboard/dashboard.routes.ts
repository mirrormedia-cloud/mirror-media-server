import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { get_dashboard_overview } from "./dashboard.service";
import { HttpStatus } from "../../shared/http/status";
import { serverError } from "../../shared/http/response";

const wrap = (fn: (req: FastifyRequest, res: FastifyReply) => Promise<any>) =>
    async (req: FastifyRequest, res: FastifyReply) => {
        try {
            const result = await fn(req, res);
            const code = result?.success?.code || result?.error?.code;
            res.status(code).send(result);
        } catch (err) {
            console.log("Error:- dashboard.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
    // GET /api/dashboard/overview — single endpoint that returns
    // every section the home page needs. Real DB counts only.
    app.get("/overview", wrap(get_dashboard_overview));
};
