import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { CreateCardActionDto, UpdateCardActionDto } from "./ott_card_actions.dto";
import {
    get_card_actions,
    create_card_action,
    update_card_action,
    delete_card_action,
} from "./ott_card_actions.service";
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
            console.log("Error:- ott_card_actions.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const ottCardActionsRoutes: FastifyPluginAsync = async (app) => {
    app.get("/:ott_id/apis/:api_id/card_actions", wrap(get_card_actions));
    app.post("/:ott_id/apis/:api_id/card_actions", { preHandler: validate(CreateCardActionDto) }, wrap(create_card_action));
    app.put("/:ott_id/apis/:api_id/card_actions/:action_id", { preHandler: validate(UpdateCardActionDto) }, wrap(update_card_action));
    app.delete("/:ott_id/apis/:api_id/card_actions/:action_id", wrap(delete_card_action));
};
