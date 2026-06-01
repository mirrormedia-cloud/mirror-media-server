import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { ListLogsQueryDto } from "./ott_logs.dto";
import { get_logs, get_log_by_id, clear_logs } from "./ott_logs.service";
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
            console.log("Error:- ott_logs.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const ottLogsRoutes: FastifyPluginAsync = async (app) => {
    app.get("/:ott_id/logs", { preHandler: validate(ListLogsQueryDto, "query") }, wrap(get_logs));
    app.get("/:ott_id/logs/:log_id", wrap(get_log_by_id));
    app.delete("/:ott_id/logs", wrap(clear_logs));
};
