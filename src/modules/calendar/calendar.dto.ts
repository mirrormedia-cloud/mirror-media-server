import { z } from "zod";

export const EVENT_TYPES = [
    "content_release",
    "reminder",
    "meeting",
    "task",
    "campaign",
    "maintenance",
    "custom",
    "upload_schedule",
] as const;

export const EVENT_STATUSES = [
    "scheduled",
    "completed",
    "cancelled",
    "uploaded",
    "failed",
] as const;

export const CreateCalendarEventDto = z.object({
    title: z.string().min(3, { message: "must be at least 3 characters" }).max(255),
    description: z.string().nullable().optional(),
    startAt: z.string().datetime({ message: "must be an ISO datetime" }),
    endAt: z.string().datetime({ message: "must be an ISO datetime" }).nullable().optional(),
    all_day: z.boolean().optional(),
    event_type: z.enum(EVENT_TYPES).optional(),
    color: z.string().max(50).nullable().optional(),
    status: z.enum(EVENT_STATUSES).optional(),
    metadata: z.record(z.any()).optional(),
}).superRefine((val, ctx) => {
    if (val.endAt) {
        const s = new Date(val.startAt).getTime();
        const e = new Date(val.endAt).getTime();
        if (Number.isFinite(s) && Number.isFinite(e) && e <= s) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "must be after startAt",
                path: ["endAt"],
            });
        }
    }
});

export const UpdateCalendarEventDto = z.object({
    title: z.string().min(3).max(255).optional(),
    description: z.string().nullable().optional(),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().nullable().optional(),
    all_day: z.boolean().optional(),
    event_type: z.enum(EVENT_TYPES).optional(),
    color: z.string().max(50).nullable().optional(),
    status: z.enum(EVENT_STATUSES).optional(),
    metadata: z.record(z.any()).optional(),
});

export const ListCalendarEventsDto = z.object({
    /** ISO datetime — only return events where start_at >= this value. */
    start: z.string().datetime().optional(),
    /** ISO datetime — only return events where start_at <= this value. */
    end: z.string().datetime().optional(),
    event_type: z.enum(EVENT_TYPES).optional(),
    /** Comma-separated list — used by the upload-schedule filter. */
    event_types: z.string().optional(),
});

export type CreateCalendarEventInput = z.infer<typeof CreateCalendarEventDto>;
export type UpdateCalendarEventInput = z.infer<typeof UpdateCalendarEventDto>;
export type ListCalendarEventsInput = z.infer<typeof ListCalendarEventsDto>;
