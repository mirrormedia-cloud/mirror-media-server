import { z } from "zod";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const DISPLAY_TYPES = ["title", "subtitle", "description", "image", "badge", "text", "hidden_id"] as const;

export const PAGINATION_TYPES = ["page_number", "cursor", "id_based", "offset", "custom"] as const;

/**
 * Per-API pagination configuration. Every field is optional because the same shape
 * is shared across all pagination types — the service reads only the fields its
 * type understands. `passthrough()` lets future types add fields without a DTO bump.
 */
export const PaginationConfigDto = z.object({
    // Page-number type
    page_param: z.string().min(1).optional(),
    start_page: z.number().int().optional(),
    has_next_path: z.string().optional(),
    total_pages_path: z.string().optional(),
    next_page_strategy: z.enum(["increment"]).optional(),
    // Cursor type
    cursor_param: z.string().min(1).optional(),
    initial_cursor: z.string().optional(),
    next_cursor_path: z.string().optional(),
    // ID-based type
    id_param: z.string().min(1).optional(),
    initial_id: z.string().optional(),
    next_id_path: z.string().optional(),
    // "Use last item" alternative for ID-based — simpler than parsing
    // `data[data.length-1].id` inside get_value_by_path.
    next_id_from_last_item: z.boolean().optional(),
    next_id_field: z.string().optional(),
    // Offset type
    offset_param: z.string().min(1).optional(),
    start_offset: z.number().int().optional(),
    total_path: z.string().optional(),
    // Common
    limit_param: z.string().optional(),
    limit_value: z.number().int().min(1).max(1000).optional(),
    data_list_path: z.string().optional(),
    max_pages: z.number().int().min(1).max(500).optional(),
    stop_when_empty: z.boolean().optional(),
}).passthrough();

const PAGINATION_FIELDS = {
    pagination_enabled: z.boolean().optional(),
    pagination_type: z.enum(PAGINATION_TYPES).nullable().optional(),
    pagination_config: PaginationConfigDto.optional(),
};

export const BODY_MODES = ["raw", "key_value"] as const;
export const BODY_VALUE_TYPES = ["static", "variable"] as const;
export const BODY_DATA_TYPES = ["string", "number", "boolean", "object", "array"] as const;

/**
 * One row in the key-value body builder. Either a static value or a path into
 * the parent/card response. data_type drives coercion of the resolved value.
 */
export const BodyConfigEntryDto = z.object({
    key: z.string().min(1),
    value_type: z.enum(BODY_VALUE_TYPES),
    static_value: z.any().optional(),
    variable_path: z.string().optional(),
    data_type: z.enum(BODY_DATA_TYPES).optional(),
    required: z.boolean().optional(),
}).superRefine((entry, ctx) => {
    if (entry.value_type === "variable" && !entry.variable_path) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["variable_path"],
            message: "variable_path is required when value_type is 'variable'",
        });
    }
});

const BODY_FIELDS = {
    body_mode: z.enum(BODY_MODES).nullable().optional(),
    request_body_config: z.array(BodyConfigEntryDto).optional(),
};

export const CreateOttApiNodeDto = z.object({
    parent_id: z.string().uuid().nullable().optional(),
    name: z.string().min(3),
    endpoint: z.string().min(1),
    method: z.enum(HTTP_METHODS),
    request_body: z.record(z.string(), z.any()).nullable().optional(),
    param_mappings: z.record(z.string(), z.string()).optional(),
    sort_order: z.number().int().min(0).optional(),
    ...PAGINATION_FIELDS,
    ...BODY_FIELDS,
});

export const UpdateOttApiNodeDto = z.object({
    parent_id: z.string().uuid().nullable().optional(),
    name: z.string().min(3).optional(),
    endpoint: z.string().min(1).optional(),
    method: z.enum(HTTP_METHODS).optional(),
    request_body: z.record(z.string(), z.any()).nullable().optional(),
    param_mappings: z.record(z.string(), z.string()).optional(),
    sort_order: z.number().int().min(0).optional(),
    ...PAGINATION_FIELDS,
    ...BODY_FIELDS,
}).refine((v) => Object.keys(v).length > 0, { message: "No fields provided" });

export const CallApiNodeDto = z.object({
    /** When true, runs the configured pagination strategy and fetches every page
     *  up to max_pages, merging into one response. Mutually exclusive with the
     *  single-page params below. */
    fetch_all_pages: z.boolean().optional(),
    /** Single-page navigation. Set ONE of these to fetch exactly that page; the
     *  strategy uses it to build the request URL. Used by the Card view's
     *  Prev/Next buttons. The fetched page replaces the saved response. */
    page_number: z.number().int().min(1).optional(),
    cursor_value: z.string().optional(),
    id_value: z.string().optional(),
    offset_value: z.number().int().min(0).optional(),
    /** Per-call override for the configured `limit_value`. Lets the user change
     *  page size from the UI without editing the API config — the runtime
     *  value wins over `pagination_config.limit_value` for this single call. */
    limit_value: z.number().int().min(1).max(1000).optional(),
});

export const TestPaginationDto = z.object({
    pagination_type: z.enum(PAGINATION_TYPES),
    pagination_config: PaginationConfigDto,
});

export const SaveSelectedFieldsDto = z.object({
    list_path: z.string(),
    selected_fields: z.array(
        z.object({
            path: z.string().min(1),
            label: z.string().nullable().optional(),
            display_type: z.enum(DISPLAY_TYPES),
            sort_order: z.number().int().min(0),
            is_visible: z.boolean().optional(),
        }),
    ),
});

export const CallFromCardDto = z.object({
    parent_api_id: z.string().uuid(),
    card_index: z.number().int().min(0),
    item_key: z.string().optional(),
    parent_item_key: z.string().optional(),
    source_response_id: z.string().uuid().optional(),
    fetch_all_pages: z.boolean().optional(),
    /** Single-page navigation for paginated child APIs (Prev/Next on the
     *  nested cards page). Set ONE of these to fetch exactly that page; the
     *  configured strategy applies it on top of the resolved endpoint. */
    page_number: z.number().int().min(1).optional(),
    cursor_value: z.string().optional(),
    id_value: z.string().optional(),
    offset_value: z.number().int().min(0).optional(),
    /** Per-call override for the configured `limit_value`. */
    limit_value: z.number().int().min(1).max(1000).optional(),
});

export const SyncOttDto = z.object({
    mode: z.enum(["root_only", "all"]).optional(),
    /** When true, any synced node that has pagination_enabled + a configured
     *  type runs through the pagination loop and stores the merged response
     *  (covers all pages up to its max_pages cap). Default false → first page
     *  only, same behaviour as before. */
    fetch_all_pages: z.boolean().optional(),
});

const OPEN_TYPES = ["drawer", "modal", "page", "inline"] as const;

export const SaveCardConfigDto = z.object({
    card_enabled: z.boolean().optional(),
    list_path: z.string(),
    quick_run: z.boolean().optional(),
    default_child_api_id: z.string().uuid().nullable().optional(),
    default_card_action_id: z.string().uuid().nullable().optional(),
    skip_action_modal: z.boolean().optional(),
    open_type: z.enum(OPEN_TYPES).optional(),
    card_config: z.object({
        layout: z.enum(["grid", "list", "table"]).optional(),
        show_labels: z.boolean().optional(),
        image_fit: z.enum(["cover", "contain"]).optional(),
        card_size: z.enum(["small", "medium", "large"]).optional(),
    }).passthrough().optional(),
    selected_fields: z.array(
        z.object({
            path: z.string().min(1),
            label: z.string().nullable().optional(),
            display_type: z.enum(DISPLAY_TYPES),
            sort_order: z.number().int().min(0),
            is_visible: z.boolean().optional(),
        }),
    ).min(1, { message: "At least one field is required" }),
}).superRefine((val, ctx) => {
    if (val.quick_run && !val.default_child_api_id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["default_child_api_id"],
            message: "default_child_api_id is required when quick_run is true",
        });
    }
    if (val.skip_action_modal && !val.default_card_action_id && !val.default_child_api_id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["default_card_action_id"],
            message: "default_card_action_id (or default_child_api_id) is required when skip_action_modal is true",
        });
    }
});

export const CardsFromContextQueryDto = z.object({
    source_response_id: z.string().uuid(),
    item_key: z.string().optional(),
});

/**
 * Capture mapping persisted on an API node so the user can configure URL/title/thumbnail
 * paths once and then save any number of cards to the local library without redoing the
 * configuration. Paths use `[0]` placeholders relative to `list_path` (the same convention
 * the existing capture endpoint already uses) — backend rewrites `[0]` to `[card_index]`
 * per save.
 */
export const CaptureMappingDto = z.object({
    list_path: z.string().nullable().optional(),
    video_url_paths: z.array(z.string().min(1)).min(1, { message: "At least one video_url_path is required" }),
    title_path: z.string().nullable().optional(),
    description_path: z.string().nullable().optional(),
    thumbnail_path: z.string().nullable().optional(),
    quality_path: z.string().nullable().optional(),
    language_path: z.string().nullable().optional(),
    duration_path: z.string().nullable().optional(),
    save_video: z.boolean().optional(),
    save_image: z.boolean().optional(),
    save_thumbnail: z.boolean().optional(),
    convert_to_mp4: z.boolean().optional(),
});

export type CaptureMappingInput = z.infer<typeof CaptureMappingDto>;

export type CreateOttApiNodeInput = z.infer<typeof CreateOttApiNodeDto>;
export type UpdateOttApiNodeInput = z.infer<typeof UpdateOttApiNodeDto>;
export type SaveSelectedFieldsInput = z.infer<typeof SaveSelectedFieldsDto>;
export type CallFromCardInput = z.infer<typeof CallFromCardDto>;
export type CallApiNodeInput = z.infer<typeof CallApiNodeDto>;
export type TestPaginationInput = z.infer<typeof TestPaginationDto>;
export type PaginationConfig = z.infer<typeof PaginationConfigDto>;
export type PaginationType = (typeof PAGINATION_TYPES)[number];
export type BodyMode = (typeof BODY_MODES)[number];
export type BodyValueType = (typeof BODY_VALUE_TYPES)[number];
export type BodyDataType = (typeof BODY_DATA_TYPES)[number];
export type BodyConfigEntry = z.infer<typeof BodyConfigEntryDto>;
export type SyncOttInput = z.infer<typeof SyncOttDto>;
export type SaveCardConfigInput = z.infer<typeof SaveCardConfigDto>;
export type CardsFromContextQueryInput = z.infer<typeof CardsFromContextQueryDto>;
