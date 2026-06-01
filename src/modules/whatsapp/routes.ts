import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

async function get_dashboard_overview(_req: FastifyRequest, _res: FastifyReply) {
    return { success: { status: true, code: 200, message: "ok" }, data: null, error: null };
}
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

export const whatsappRoutes: FastifyPluginAsync = async (app) => {
    app.get("/message", wrap(get_dashboard_overview));
};
