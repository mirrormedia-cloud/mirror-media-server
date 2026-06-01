import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { UploadDto, ListUploadsQueryDto } from "./social_upload.dto";
import {
    create_upload,
    list_uploads,
    list_upload_stats,
    upload_schedule_item,
    youtube_copyright_check_now,
    youtube_copyright_check_one,
} from "./social_upload.service";
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
            console.log("Error:- social_upload.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

const ScheduleItemParamDto = z.object({ schedule_item_id: z.string().uuid() });

export const socialUploadRoutes: FastifyPluginAsync = async (app) => {
    // POST /api/social/upload — push one library item to one or more platforms.
    app.post("/upload", { preHandler: validate(UploadDto) }, wrap(create_upload));
    // GET /api/social/uploads — paginated history of uploads, filterable.
    app.get("/uploads", { preHandler: validate(ListUploadsQueryDto, "query") }, wrap(list_uploads));
    // GET /api/social/uploads/stats — aggregate counts (by status + by
    // platform) across the user's ENTIRE social_uploads table. The
    // upload-history page calls this without filter params so the stat
    // cards reflect overall totals, independent of pagination. Same
    // optional filters (?platform=&status=) are accepted for callers
    // that want a filtered breakdown.
    app.get(
        "/uploads/stats",
        { preHandler: validate(ListUploadsQueryDto, "query") },
        wrap(list_upload_stats),
    );
    // POST /api/social/upload_schedule_item/:schedule_item_id — manual
    // trigger that bridges a calendar schedule item to per-platform
    // social uploads. Pulls library item + platforms + title from the
    // schedule item (and parent batch) and runs the same dispatch as
    // the library-card flow.
    app.post(
        "/upload_schedule_item/:schedule_item_id",
        { preHandler: validate(ScheduleItemParamDto, "params") },
        wrap(upload_schedule_item),
    );

    // POST /api/social/youtube/copyright_check — sweep all of the caller's
    // uploaded YouTube rows now (bypasses the 15-min cooldown). Returns the
    // per-row outcomes so the UI can show what was deleted vs. clean.
    app.post("/youtube/copyright_check", wrap(youtube_copyright_check_now));

    // POST /api/social/youtube/copyright_check/:upload_id — check one row.
    const UploadIdParamDto = z.object({ upload_id: z.string().uuid() });
    app.post(
        "/youtube/copyright_check/:upload_id",
        { preHandler: validate(UploadIdParamDto, "params") },
        wrap(youtube_copyright_check_one),
    );
};
