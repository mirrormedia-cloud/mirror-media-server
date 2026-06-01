import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { HttpStatus } from "../../shared/http/status";
import { success, error, serverError } from "../../shared/http/response";
import { list as list_crons, run as run_cron, get as get_cron } from "../../cron/registry";

const wrap =
    (fn: (req: FastifyRequest) => Promise<any>, label: string) =>
        async (req: FastifyRequest, res: FastifyReply) => {
            try {
                const result = await fn(req);
                const code = result?.success?.code || result?.error?.code;
                res.status(code).send(result);
            } catch (err) {
                console.log(`Error:- ${label}`, err);
                res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
            }
        };

async function listCronsHandler(_req: FastifyRequest) {
    return success("Crons", { crons: list_crons() });
}

async function runCronHandler(req: FastifyRequest) {
    const { id } = req.params as { id: string };
    const before = get_cron(id);
    if (!before) return error(HttpStatus.NOT_FOUND, `Unknown cron: ${id}`);
    const r = await run_cron(id);
    if (!r.ok) {
        // Could be "Already running" or a real tick failure — surface the
        // summary so the UI can show it directly.
        return error(HttpStatus.CONFLICT, r.summary);
    }
    return success("Cron run", { id, summary: r.summary, state: get_cron(id) });
}

export const cronsRoutes: FastifyPluginAsync = async (app) => {
    app.get("/", wrap(listCronsHandler, "listCrons"));
    app.post("/:id/run", wrap(runCronHandler, "runCron"));
};
