/**
 * Top-level library browser routes (NOT scoped to a single OTT).
 *
 * Lives under /api/library/* and powers the unified /dashboard/library
 * page, where each OTT renders as a folder. Per-OTT operations stay in
 * ott_library.routes (mounted at /api/ott).
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
    list_user_library_otts,
    bulk_delete_otts_library_contents,
} from "../ott_library/ott_library.service";
import {
    init_local_uploads,
    create_folder,
    rename_folder,
    delete_folder,
    rename_item,
    delete_item,
    list_folders,
    folder_breadcrumbs,
    paste,
} from "./local_uploads_crud.service";
import { HttpStatus } from "../../shared/http/status";
import { serverError } from "../../shared/http/response";

const wrap = (fn: (req: FastifyRequest, res: FastifyReply) => Promise<any>) =>
    async (req: FastifyRequest, res: FastifyReply) => {
        try {
            const result = await fn(req, res);
            const code = result?.success?.code || result?.error?.code;
            res.status(code).send(result);
        } catch (err) {
            console.log("Error:- library_browser.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const libraryBrowserRoutes: FastifyPluginAsync = async (app) => {
    // GET /api/library/otts — every OTT this user owns + per-type counts.
    app.get("/otts", wrap(list_user_library_otts));
    // POST /api/library/otts/bulk_delete_contents — body: { ott_ids: string[] }.
    // Wipes saved library files/rows for the listed OTTs but leaves the
    // OTT platform rows intact. Used by the multi-select toolbar in the
    // unified library browser.
    app.post("/otts/bulk_delete_contents", wrap(bulk_delete_otts_library_contents));

    // Legacy `/upload_local_files` endpoint was removed in the R2
    // migration. Use `POST /api/library/local-uploads/:ott_id/upload`
    // for new uploads.

    // ── Local-Uploads CRUD (Windows-Explorer-style file management) ──
    //
    // File UPLOADS no longer go through this module — the frontend
    // PUTs bytes directly to R2 via signed URLs:
    //   POST /api/storage/r2/signed-upload-url   (get presigned PUT)
    //   PUT  <upload_url>                        (R2, no backend hop)
    //   POST /api/storage/r2/complete-upload     (create library row)
    //
    // Everything below is metadata-only: folders, renames, deletes,
    // and the cut/copy/paste of existing rows.
    app.get("/local-uploads/init", wrap(init_local_uploads));
    app.get("/local-uploads/:ott_id/folders", wrap(list_folders));
    app.post("/local-uploads/:ott_id/folders", wrap(create_folder));
    app.get("/local-uploads/:ott_id/folders/:key/breadcrumbs", wrap(folder_breadcrumbs));
    app.patch("/local-uploads/:ott_id/folders/:key", wrap(rename_folder));
    app.delete("/local-uploads/:ott_id/folders/:key", wrap(delete_folder));
    app.patch("/local-uploads/:ott_id/items/:item_id", wrap(rename_item));
    app.delete("/local-uploads/:ott_id/items/:item_id", wrap(delete_item));
    app.post("/local-uploads/:ott_id/paste", wrap(paste));
};
