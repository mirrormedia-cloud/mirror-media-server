import { z } from "zod";

const headers_schema = z.record(z.string(), z.any()).optional();

const https_url = z
    .string()
    .url()
    .refine((v) => /^https:\/\//i.test(v), { message: "Must be a valid https URL" });

// favicon_url accepts either an absolute URL OR a relative /uploads/... path
// (so a future upload endpoint can write its returned path here). We don't
// gate it on https_url because some users paste /favicon.ico or data: URLs.
const favicon_url_schema = z.string().max(2048).optional().nullable();

export const CreateOttDto = z.object({
    name: z.string().min(3),
    description: z.string().optional(),
    base_url: https_url,
    cookie_file_name: z.string().optional(),
    cookie_raw_content: z.string().optional(),
    cookie_string: z.string().optional(),
    headers: headers_schema,
    favicon_url: favicon_url_schema,
});

export const UpdateOttDto = z.object({
    name: z.string().min(3).optional(),
    description: z.string().optional().nullable(),
    base_url: https_url.optional(),
    cookie_file_name: z.string().optional().nullable(),
    cookie_raw_content: z.string().optional().nullable(),
    cookie_string: z.string().optional().nullable(),
    headers: headers_schema,
    favicon_url: favicon_url_schema,
    status: z.string().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "No fields provided" });

export type CreateOttInput = z.infer<typeof CreateOttDto>;
export type UpdateOttInput = z.infer<typeof UpdateOttDto>;
