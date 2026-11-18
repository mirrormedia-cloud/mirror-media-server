import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { HttpStatus } from "../../shared/http/status";
import { serverError } from "../../shared/http/response";
import { get_auto_post, save_auto_post, preview_auto_post, post_now_auto_post } from "./auto_post.service";

const wrap = (fn: (req: FastifyRequest) => Promise<any>, label: string) =>
    async (req: FastifyRequest, res: FastifyReply) => {
        try {
            const result = await fn(req);
            const code = result?.success?.code || result?.error?.code || HttpStatus.OK;
            res.status(code).send(result);
        } catch (err) {
            console.log(`Error:- ${label}`, err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const autoPostRoutes: FastifyPluginAsync = async (app) => {
    app.get("/", wrap(get_auto_post, "getAutoPost"));
    app.put("/", wrap(save_auto_post, "saveAutoPost"));
    app.post("/preview", wrap(preview_auto_post, "previewAutoPost"));
    app.post("/post-now", wrap(post_now_auto_post, "postNowAutoPost"));
};
