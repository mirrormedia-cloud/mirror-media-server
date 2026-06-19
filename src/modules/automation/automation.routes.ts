import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { HttpStatus } from "../../shared/http/status";
import { serverError } from "../../shared/http/response";
import {
    list_automation_rules,
    get_automation_rule,
    create_automation_rule,
    update_automation_rule,
    delete_automation_rule,
} from "./automation.service";

const wrap = (fn: (req: FastifyRequest, res: FastifyReply) => Promise<any>) =>
    async (req: FastifyRequest, res: FastifyReply) => {
        try {
            const result = await fn(req, res);
            const code = result?.success?.code || result?.error?.code || HttpStatus.OK;
            res.status(code).send(result);
        } catch (err) {
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const automationRoutes: FastifyPluginAsync = async (app) => {
    app.get("/rules", wrap(list_automation_rules));
    app.get("/rules/:id", wrap(get_automation_rule));
    app.post("/rules", wrap(create_automation_rule));
    app.put("/rules/:id", wrap(update_automation_rule));
    app.delete("/rules/:id", wrap(delete_automation_rule));
};
