import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { GetNestedQueryDto } from "./ott_nested.dto";
import { get_nested_data, get_nested_cards_page } from "./ott_nested.service";
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
            console.log("Error:- ott_nested.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const ottNestedRoutes: FastifyPluginAsync = async (app) => {
    app.get(
        "/:ott_id/nested/:parent_api_id/:item_key/:child_api_id",
        { preHandler: validate(GetNestedQueryDto, "query") },
        wrap(get_nested_data),
    );

    // New canonical route used by NestedCardsPage. Same query parameters,
    // shaped payload includes cards_data{} and captured_videos[].
    app.get(
        "/:ott_id/cards/:parent_api_id/:item_key/:child_api_id",
        { preHandler: validate(GetNestedQueryDto, "query") },
        wrap(get_nested_cards_page),
    );
};
