import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
    CaptureVideoAssetsDto,
    ListVideoAssetsQueryDto,
    DownloadVideoQueryDto,
} from "./ott_video_assets.dto";
import {
    capture_video_assets,
    list_video_assets,
    get_video_asset,
    delete_video_asset,
    bulk_delete_video_assets,
    download_video_asset,
    reset_downloaded,
} from "./ott_video_assets.service";
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
            console.log("Error:- ott_video_assets.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const ottVideoAssetsRoutes: FastifyPluginAsync = async (app) => {
    app.post(
        "/:ott_id/video_assets/capture",
        { preHandler: validate(CaptureVideoAssetsDto) },
        wrap(capture_video_assets),
    );

    app.get(
        "/:ott_id/video_assets",
        { preHandler: validate(ListVideoAssetsQueryDto, "query") },
        wrap(list_video_assets),
    );

    app.get("/:ott_id/video_assets/:video_asset_id", wrap(get_video_asset));
    app.delete("/:ott_id/video_assets/:video_asset_id", wrap(delete_video_asset));
    // Bulk delete — body: { ids: string[] }. POST so the body survives
    // proxies that strip DELETE bodies.
    app.post("/:ott_id/video_assets/bulk_delete", wrap(bulk_delete_video_assets));
    // Clear downloaded_at on all assets for this OTT (called after sync).
    app.post("/:ott_id/video_assets/reset_downloaded", wrap(reset_downloaded));

    // Download streams the upstream file directly to the response — must NOT be wrapped
    // with the envelope helper because we set Content-Type/Content-Disposition manually.
    app.get(
        "/:ott_id/video_assets/:video_asset_id/download",
        { preHandler: validate(DownloadVideoQueryDto, "query") },
        async (req, res) => {
            try {
                await download_video_asset(req, res);
            } catch (err) {
                console.log("Error:- download_video_asset", err);
                if (!res.sent) {
                    res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
                }
            }
        },
    );
};
