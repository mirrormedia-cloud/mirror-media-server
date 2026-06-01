import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
    PreviewScheduleDto,
    CreateScheduleDto,
    ListSchedulesQueryDto,
} from "./upload_schedule.dto";
import {
    preview_schedule,
    create_schedule,
    update_schedule,
    list_schedules,
    get_schedule,
    cancel_schedule,
    delete_schedule,
    get_library_schedule_status,
} from "./upload_schedule.service";
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
            console.log("Error:- upload_schedule.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const uploadScheduleRoutes: FastifyPluginAsync = async (app) => {
    app.post("/upload_schedules/preview", { preHandler: validate(PreviewScheduleDto) }, wrap(preview_schedule));
    app.post("/upload_schedules", { preHandler: validate(CreateScheduleDto) }, wrap(create_schedule));
    app.get("/upload_schedules", { preHandler: validate(ListSchedulesQueryDto, "query") }, wrap(list_schedules));
    app.get("/upload_schedules/:batch_id", wrap(get_schedule));
    // PUT replaces a draft batch's schedule wholesale (items + linked
    // calendar events are wiped and rebuilt). Status must be 'draft'.
    app.put("/upload_schedules/:batch_id", { preHandler: validate(CreateScheduleDto) }, wrap(update_schedule));
    app.post("/upload_schedules/:batch_id/cancel", wrap(cancel_schedule));
    app.delete("/upload_schedules/:batch_id", wrap(delete_schedule));

    // Sidecar — library schedule status. Lives under /api/calendar so it stays
    // under the calendar JWT scope; the library page calls it to decorate cards.
    app.get("/library_schedule_status", wrap(get_library_schedule_status));
};
