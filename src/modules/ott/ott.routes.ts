import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { CreateOttDto, UpdateOttDto } from "./ott.dto";
import {
    get_all_ott_platforms,
    create_ott_platform,
    get_ott_by_id,
    update_ott_platform,
    delete_ott_platform,
} from "./ott.service";
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
            console.log("Error:- ott.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const ottRoutes: FastifyPluginAsync = async (app) => {
    app.get("/", wrap(get_all_ott_platforms));
    app.post("/", { preHandler: validate(CreateOttDto) }, wrap(create_ott_platform));
    app.get("/:ott_id", wrap(get_ott_by_id));
    app.put("/:ott_id", { preHandler: validate(UpdateOttDto) }, wrap(update_ott_platform));
    app.delete("/:ott_id", wrap(delete_ott_platform));
};
