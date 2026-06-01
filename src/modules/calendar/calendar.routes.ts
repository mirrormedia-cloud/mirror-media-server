import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
    CreateCalendarEventDto,
    UpdateCalendarEventDto,
    ListCalendarEventsDto,
} from "./calendar.dto";
import {
    list_events,
    get_event,
    create_event,
    update_event,
    delete_event,
    clear_all,
} from "./calendar.service";
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
            console.log("Error:- calendar.routes", err);
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(serverError(err));
        }
    };

export const calendarRoutes: FastifyPluginAsync = async (app) => {
    app.get("/events", { preHandler: validate(ListCalendarEventsDto, "query") }, wrap(list_events));
    app.post("/events", { preHandler: validate(CreateCalendarEventDto) }, wrap(create_event));
    app.get("/events/:event_id", wrap(get_event));
    app.put("/events/:event_id", { preHandler: validate(UpdateCalendarEventDto) }, wrap(update_event));
    app.delete("/events/:event_id", wrap(delete_event));
    // Wipe every event + every upload-schedule batch+item for the user.
    app.post("/clear_all", wrap(clear_all));
};
