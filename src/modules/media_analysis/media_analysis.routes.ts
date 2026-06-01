import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
    AnalyzeDto,
    AnalyzeFromFileDto,
    ListAnalysisQueryDto,
    LibraryItemParamDto,
    AnalysisIdParamDto,
} from "./media_analysis.dto";
import {
    analyze,
    analyze_from_file,
    list_analysis,
    get_for_library_item,
    delete_analysis,
} from "./media_analysis.service";
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
            console.log("Error:- media_analysis.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const mediaAnalysisRoutes: FastifyPluginAsync = async (app) => {
    // POST /api/media-analysis/analyze — run (or fetch cached) analysis.
    app.post("/analyze", { preHandler: validate(AnalyzeDto) }, wrap(analyze));

    // POST /api/media-analysis/from_file — direct call: takes a local
    // file_path + platform and returns generated details (no persistence).
    // Useful for testing the prompt against an arbitrary local file.
    app.post("/from_file", { preHandler: validate(AnalyzeFromFileDto) }, wrap(analyze_from_file));

    // GET /api/media-analysis — paginated, filterable list.
    app.get("/", { preHandler: validate(ListAnalysisQueryDto, "query") }, wrap(list_analysis));

    // GET /api/media-analysis/library/:library_item_id — every analysis
    // for one library item (also returns the latest-per-platform map).
    app.get(
        "/library/:library_item_id",
        { preHandler: validate(LibraryItemParamDto, "params") },
        wrap(get_for_library_item),
    );

    // DELETE /api/media-analysis/:analysis_id — soft-delete (paranoid model).
    app.delete(
        "/:analysis_id",
        { preHandler: validate(AnalysisIdParamDto, "params") },
        wrap(delete_analysis),
    );
};
