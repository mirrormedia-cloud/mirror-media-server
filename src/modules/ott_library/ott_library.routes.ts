import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
    SaveToLibraryDto,
    SaveBulkToLibraryDto,
    ListLibraryQueryDto,
    SaveFromCardsDto,
} from "./ott_library.dto";
import {
    save_video_asset_to_library,
    save_bulk_video_assets_to_library,
    get_library_items,
    get_library_item,
    delete_library_item,
    download_library_item,
    stream_library_item,
    save_from_cards,
    get_library_folders,
    bulk_delete_library_items,
    bulk_delete_library_folders,
} from "./ott_library.service";
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
            console.log("Error:- ott_library.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const ottLibraryRoutes: FastifyPluginAsync = async (app) => {
    // Save endpoints — synchronous. The library row exists only when
    // the R2 upload succeeded. No queue, no status state machine.
    app.post(
        "/:ott_id/library/save",
        { preHandler: validate(SaveToLibraryDto) },
        wrap(save_video_asset_to_library),
    );
    app.post(
        "/:ott_id/library/save_bulk",
        { preHandler: validate(SaveBulkToLibraryDto) },
        wrap(save_bulk_video_assets_to_library),
    );
    app.post(
        "/:ott_id/library/save_from_cards",
        { preHandler: validate(SaveFromCardsDto) },
        wrap(save_from_cards),
    );

    // Read.
    app.get(
        "/:ott_id/library",
        { preHandler: validate(ListLibraryQueryDto, "query") },
        wrap(get_library_items),
    );
    app.get("/:ott_id/library/folders", wrap(get_library_folders));
    app.get("/:ott_id/library/:library_item_id", wrap(get_library_item));

    // Delete.
    app.delete("/:ott_id/library/:library_item_id", wrap(delete_library_item));
    app.post("/:ott_id/library/bulk_delete", wrap(bulk_delete_library_items));
    app.post("/:ott_id/library/folders/bulk_delete", wrap(bulk_delete_library_folders));

    // Streaming + download — both just redirect to the row's file_url.
    app.get("/:ott_id/library/:library_item_id/download", async (req, res) => {
        try { await download_library_item(req, res); }
        catch (err) {
            console.log("Error:- download_library_item", err);
            if (!res.sent) res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    });
    app.get("/:ott_id/library/:library_item_id/stream", async (req, res) => {
        try { await stream_library_item(req, res); }
        catch (err) {
            console.log("Error:- stream_library_item", err);
            if (!res.sent) res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    });
};
