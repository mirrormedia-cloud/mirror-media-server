import type { FastifyRequest } from "fastify";
import { Op } from "sequelize";
import {
    OttPlatform,
    OttApiNode,
    OttApiResponse,
    OttSelectedField,
    OttChildApiItemResponse,
    OttCardAction,
} from "../../db/models";
import { card_action_dto } from "../ott_card_actions/ott_card_actions.service";
import { capture_for_node } from "../ott_video_assets/ott_video_assets.service";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import { call_external_ott_api, type ExternalCallResult } from "../../utils/ott_proxy";
import {
    get_value_by_path,
    replace_array_index_in_path,
    build_cards_from_response,
    get_item_key,
    extract_endpoint_variables,
    resolve_endpoint_variables,
    type SelectedFieldDef,
} from "../../utils/response_path_utils";
import type {
    CreateOttApiNodeInput,
    UpdateOttApiNodeInput,
    SaveSelectedFieldsInput,
    CallFromCardInput,
    SyncOttInput,
    SaveCardConfigInput,
    CardsFromContextQueryInput,
    CaptureMappingInput,
    CallApiNodeInput,
    TestPaginationInput,
    PaginationType,
} from "./ott_api.dto";
import { run_paginated_call, build_single_page_url, inspect_pagination_next_state } from "./ott_api_pagination.service";
import { resolve_request_body } from "./ott_api_body.service";

function ts(value: any): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function api_node_dto(n: OttApiNode) {
    return {
        id: n.id,
        ott_id: n.ott_id,
        parent_id: n.parent_id ?? null,
        name: n.name,
        endpoint: n.endpoint,
        method: n.method,
        request_body: n.request_body ?? null,
        param_mappings: n.param_mappings ?? {},
        list_path: n.list_path ?? null,
        card_config: n.card_config ?? {},
        card_enabled: n.card_enabled ?? false,
        quick_run: n.quick_run ?? false,
        default_child_api_id: n.default_child_api_id ?? null,
        default_card_action_id: n.default_card_action_id ?? null,
        skip_action_modal: n.skip_action_modal ?? false,
        open_type: n.open_type ?? "inline",
        sort_order: n.sort_order,
        status: n.status,
        last_http_status: n.last_http_status ?? null,
        last_error: n.last_error ?? null,
        pagination_enabled: n.pagination_enabled ?? false,
        pagination_type: n.pagination_type ?? null,
        pagination_config: n.pagination_config ?? {},
        body_mode: n.body_mode ?? null,
        request_body_config: n.request_body_config ?? [],
        lastCalledAt: ts(n.last_called_at),
        lastSyncedAt: ts(n.last_synced_at),
        createdAt: ts((n as any).createdAt),
        updatedAt: ts((n as any).updatedAt),
    };
}

function selected_field_dto(f: OttSelectedField) {
    return {
        id: f.id,
        ott_id: f.ott_id,
        api_node_id: f.api_node_id,
        path: f.path,
        label: f.label ?? null,
        display_type: f.display_type,
        sort_order: f.sort_order,
        is_visible: f.is_visible,
        createdAt: ts((f as any).createdAt),
        updatedAt: ts((f as any).updatedAt),
    };
}

/**
 * Load an OTT and verify it belongs to the authenticated user. Returns null
 * either way if (a) the OTT doesn't exist OR (b) it belongs to a different
 * user. Callers handle the null case by returning a 404 — same response
 * either way avoids leaking ownership information.
 *
 * Pass the request so we can read req.userId — the FastifyRequest type lets
 * us see it because the authenticate middleware decorates it.
 */
async function load_ott_or_error(ott_id: string, req: FastifyRequest) {
    const user_id = (req as any).userId;
    if (!user_id) return null;
    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    if (!ott) return null;
    return ott;
}

/**
 * Build cards for an API node from any response source (root response or
 * child item response). Reuses the node's saved list_path + selected_fields.
 */
export async function build_cards_for_api(api_node: OttApiNode, response: any) {
    const fields = await OttSelectedField.findAll({
        where: { api_node_id: api_node.id, is_visible: true } as any,
        order: [["sort_order", "ASC"]],
    });
    const selected: SelectedFieldDef[] = fields.map((f) => ({
        path: f.path!,
        label: f.label ?? null,
        display_type: f.display_type!,
        sort_order: f.sort_order ?? 0,
        is_visible: f.is_visible ?? true,
    }));
    return build_cards_from_response(response, api_node.list_path ?? "", selected);
}

async function build_tree(ott_id: string) {
    const nodes = await OttApiNode.findAll({
        where: { ott_id } as any,
        order: [["sort_order", "ASC"], ["createdAt", "ASC"]],
    });
    const responses = await OttApiResponse.findAll({ where: { ott_id } as any });
    const fields = await OttSelectedField.findAll({
        where: { ott_id } as any,
        order: [["sort_order", "ASC"]],
    });

    const responses_by_node = new Map<string, OttApiResponse>();
    for (const r of responses) responses_by_node.set(r.api_node_id!, r);

    const fields_by_node = new Map<string, OttSelectedField[]>();
    for (const f of fields) {
        if (!fields_by_node.has(f.api_node_id!)) fields_by_node.set(f.api_node_id!, []);
        fields_by_node.get(f.api_node_id!)!.push(f);
    }

    const dto_map = new Map<string, any>();
    for (const n of nodes) {
        const latest = responses_by_node.get(n.id);
        dto_map.set(n.id, {
            ...api_node_dto(n),
            selected_fields: (fields_by_node.get(n.id) || []).map(selected_field_dto),
            latest_response_summary: latest
                ? {
                    http_status: latest.http_status ?? null,
                    duration_ms: latest.duration_ms ?? null,
                    response_preview: latest.response_preview ?? null,
                    updatedAt: ts((latest as any).updatedAt),
                }
                : null,
            children: [] as any[],
        });
    }

    const tree: any[] = [];
    for (const n of nodes) {
        const dto = dto_map.get(n.id);
        if (n.parent_id && dto_map.has(n.parent_id)) dto_map.get(n.parent_id).children.push(dto);
        else tree.push(dto);
    }
    return tree;
}

export async function get_api_tree(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const ott = await load_ott_or_error(ott_id, req);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");
    const tree = await build_tree(ott_id);
    return success("api tree fetched successfully", { ott_id, api_tree: tree });
}

export async function create_api_node(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const body = req.body as CreateOttApiNodeInput;
    const ott = await load_ott_or_error(ott_id, req);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    if (body.parent_id) {
        const parent = await OttApiNode.findOne({ where: { id: body.parent_id, ott_id } as any });
        if (!parent) return error(HttpStatus.BAD_REQUEST, "parent_id does not belong to this OTT", "parent_id");
    }

    const created = await OttApiNode.create({
        user_id: (req as any).userId,
        ott_id,
        parent_id: body.parent_id ?? null,
        name: body.name,
        endpoint: body.endpoint,
        method: body.method,
        request_body: body.request_body ?? null,
        param_mappings: body.param_mappings ?? {},
        sort_order: body.sort_order ?? 0,
        status: "not_called",
        card_config: {},
        pagination_enabled: body.pagination_enabled ?? false,
        pagination_type: body.pagination_type ?? null,
        pagination_config: body.pagination_config ?? {},
        body_mode: body.body_mode ?? null,
        request_body_config: body.request_body_config ?? [],
    } as any);

    return success("api node created successfully", api_node_dto(created), HttpStatus.CREATED);
}

export async function update_api_node(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const body = req.body as UpdateOttApiNodeInput;

    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    if (body.parent_id !== undefined && body.parent_id !== null) {
        if (body.parent_id === api_id) return error(HttpStatus.BAD_REQUEST, "Node cannot be its own parent", "parent_id");
        const parent = await OttApiNode.findOne({ where: { id: body.parent_id, ott_id } as any });
        if (!parent) return error(HttpStatus.BAD_REQUEST, "parent_id does not belong to this OTT", "parent_id");
    }

    const patch: Record<string, any> = {};
    if (body.parent_id !== undefined) patch.parent_id = body.parent_id;
    if (body.name !== undefined) patch.name = body.name;
    if (body.endpoint !== undefined) patch.endpoint = body.endpoint;
    if (body.method !== undefined) patch.method = body.method;
    if (body.request_body !== undefined) patch.request_body = body.request_body;
    if (body.param_mappings !== undefined) patch.param_mappings = body.param_mappings;
    if (body.sort_order !== undefined) patch.sort_order = body.sort_order;
    if (body.pagination_enabled !== undefined) patch.pagination_enabled = body.pagination_enabled;
    if (body.pagination_type !== undefined) patch.pagination_type = body.pagination_type;
    if (body.pagination_config !== undefined) patch.pagination_config = body.pagination_config;
    if (body.body_mode !== undefined) patch.body_mode = body.body_mode;
    if (body.request_body_config !== undefined) patch.request_body_config = body.request_body_config;

    await node.update(patch);
    // Reload from DB so we serialize the actual persisted state — guards against
    // Sequelize sometimes returning the pre-write in-memory copy when JSONB or
    // newly-altered columns are involved.
    await node.reload();
    return success("api node updated successfully", api_node_dto(node));
}

/**
 * Fetch a single API node fresh from the database. The api-tree response contains
 * the same data, but the modal calls this on open to dodge any tree-staleness
 * between save and the next edit (e.g. saved pagination_config not appearing).
 */
export async function get_api_node(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");
    return success("api node fetched successfully", api_node_dto(node));
}

export async function delete_api_node(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");
    await node.destroy();
    return success("api node deleted successfully", { id: api_id });
}

async function persist_node_response(node: OttApiNode, ott_id: string, result: { success: boolean; status: number | null; data: any; duration_ms: number; response_preview: string | null; error_message?: string | null }) {
    if (result.success && result.data !== undefined && result.data !== null) {
        const existing = await OttApiResponse.findOne({ where: { api_node_id: node.id } as any });
        if (existing) {
            await existing.update({
                response: result.data,
                response_preview: result.response_preview,
                http_status: result.status,
                duration_ms: result.duration_ms,
            });
        } else {
            await OttApiResponse.create({
                ott_id,
                api_node_id: node.id,
                response: result.data,
                response_preview: result.response_preview,
                http_status: result.status,
                duration_ms: result.duration_ms,
            } as any);
        }
    }
    await node.update({
        status: result.success ? "success" : "failed",
        last_http_status: result.status,
        last_error: result.success ? null : result.error_message ?? `HTTP ${result.status ?? "ERR"}`,
        last_called_at: new Date(),
    });
}

export async function call_api_node(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const body = (req.body ?? {}) as CallApiNodeInput;
    const ott = await load_ott_or_error(ott_id, req);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    if (node.parent_id) {
        return error(HttpStatus.BAD_REQUEST, "Use call_from_card to call a child API");
    }

    // Resolve the request body once. Root APIs have no parent context, so the
    // resolver only handles static entries here — required variable entries
    // on a root body fail with a clear error.
    const body_resolution = resolve_request_body({
        body_mode: node.body_mode as any,
        request_body_config: node.request_body_config ?? [],
        raw_body: (node.request_body as Record<string, any> | null) ?? null,
    });
    if (body_resolution.error) {
        return error(HttpStatus.BAD_REQUEST, `Body resolution failed: ${body_resolution.error}`, "request_body_config");
    }
    const resolved_body = body_resolution.body;
    console.log("[body-resolution] root", {
        api_id: node.id,
        method: node.method,
        body_mode: node.body_mode ?? "(null)",
        config_entries: (node.request_body_config ?? []).length,
        raw_body_set: !!node.request_body,
        resolved: resolved_body,
        diagnostics: body_resolution.resolved_entries,
    });

    // Per-call limit override. The user-facing page-size selector sends a new
    // limit_value; merging it into pagination_config means every downstream
    // strategy call (build_single_page_url, run_paginated_call, inspect_*)
    // sees the new value WITHOUT having to thread an extra arg through.
    const runtime_pagination_config = body.limit_value !== undefined
        ? { ...(node.pagination_config ?? {}), limit_value: body.limit_value }
        : (node.pagination_config ?? {});

    // ── Single-page navigation (Prev/Next buttons in card view) ─────────
    // Caller passes page_number / cursor_value / id_value / offset_value to
    // jump to one specific page. Replaces the saved response so cards rebuild
    // from the freshly-fetched page.
    const wants_specific_page = (
        body.page_number !== undefined ||
        body.cursor_value !== undefined ||
        body.id_value !== undefined ||
        body.offset_value !== undefined
    );
    if (wants_specific_page && node.pagination_enabled && node.pagination_type) {
        const config = runtime_pagination_config;
        const url = build_single_page_url({
            base_endpoint: node.endpoint!,
            pagination_type: node.pagination_type as PaginationType,
            pagination_config: config,
            page_number: body.page_number ?? null,
            cursor_value: body.cursor_value ?? null,
            id_value: body.id_value ?? null,
            offset_value: body.offset_value ?? null,
        });
        if (!url) {
            return error(HttpStatus.BAD_REQUEST, `Pagination type "${node.pagination_type}" is not supported for single-page navigation`);
        }
        const result = await call_external_ott_api({
            ott,
            api_node: node,
            resolved_endpoint: url,
            request_body: resolved_body,
        });
        await persist_node_response(node, ott_id, result);
        // Surface what the next page (if any) would look like so the frontend
        // can disable the Next button when we've hit a stop condition.
        const next_state = result.success
            ? inspect_pagination_next_state({
                response: result.data,
                pagination_type: node.pagination_type as PaginationType,
                pagination_config: config,
                current_page_number: body.page_number ?? null,
                current_cursor: body.cursor_value ?? null,
                current_id: body.id_value ?? null,
                current_offset: body.offset_value ?? null,
            })
            : null;
        return success("api page fetched successfully", {
            api_id: node.id,
            status: node.status,
            success: result.success,
            http_status: result.status,
            duration_ms: result.duration_ms,
            log_id: result.log_id,
            response: result.data,
            error_message: result.error_message ?? null,
            pagination_state: {
                pagination_type: node.pagination_type,
                current_page_number: body.page_number ?? null,
                current_cursor: body.cursor_value ?? null,
                current_id: body.id_value ?? null,
                current_offset: body.offset_value ?? null,
                next_page_number: next_state?.next_page_number ?? null,
                next_cursor: next_state?.next_cursor ?? null,
                next_id: next_state?.next_id ?? null,
                next_offset: next_state?.next_offset ?? null,
                has_next: next_state?.has_next ?? false,
                item_count: next_state?.item_count ?? 0,
                stop_reason: next_state?.stop_reason ?? null,
                total_pages: next_state?.total_pages ?? null,
                total_items: next_state?.total_items ?? null,
            },
        });
    }

    // Paginated path: only when the node is configured AND the caller explicitly asks
    // for it. Default behaviour stays "fetch first page" so existing callers (Call API
    // button) don't accidentally trigger 50 upstream calls.
    if (body.fetch_all_pages && node.pagination_enabled && node.pagination_type) {
        const run = await run_paginated_call({
            ott,
            api_node: node,
            base_endpoint: node.endpoint!,
            request_body: resolved_body,
            pagination_type: node.pagination_type as PaginationType,
            pagination_config: runtime_pagination_config,
        });

        // Persist the merged response so cards/other consumers see all pages at once.
        await persist_node_response(node, ott_id, {
            success: run.final_success,
            status: run.last_http_status,
            data: run.merged_response,
            duration_ms: run.pages.reduce((sum, p) => sum + (p.duration_ms ?? 0), 0),
            response_preview: build_preview(run.merged_response),
            error_message: run.last_error,
        });

        return success("api called successfully (paginated)", {
            api_id: node.id,
            status: node.status,
            success: run.final_success,
            http_status: run.last_http_status,
            duration_ms: run.pages.reduce((sum, p) => sum + (p.duration_ms ?? 0), 0),
            log_id: run.pages[run.pages.length - 1]?.log_id ?? null,
            response: run.merged_response,
            error_message: run.last_error,
            pagination: {
                pages_fetched: run.pages_fetched,
                total_items: run.total_items,
                stop_reason: run.stop_reason,
                pages: run.pages,
            },
        });
    }

    const result = await call_external_ott_api({
        ott,
        api_node: node,
        resolved_endpoint: node.endpoint!,
        request_body: resolved_body,
    });

    await persist_node_response(node, ott_id, result);

    return success("api called successfully", {
        api_id: node.id,
        status: node.status,
        success: result.success,
        http_status: result.status,
        duration_ms: result.duration_ms,
        log_id: result.log_id,
        response: result.data,
        error_message: result.error_message ?? null,
    });
}

/**
 * Test the first 2 pages with the given pagination config WITHOUT persisting the
 * merged response. Used by the API form's "Test Pagination" button so users can
 * verify their config before committing to a full sync.
 */
export async function test_pagination(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const body = req.body as TestPaginationInput;

    const ott = await load_ott_or_error(ott_id, req);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    // For child APIs we need to first resolve endpoint variables (e.g. <slug>)
    // using the parent's first card — same approach as sample_call. The
    // resolved URL then becomes the base_endpoint that the pagination loop
    // appends page_param/cursor/etc. to. Without this the test would fail with
    // an upstream 404 (variables unresolved).
    let base_endpoint = node.endpoint!;
    let test_parent_response: any = null;
    if (node.parent_id) {
        const parent = await OttApiNode.findOne({ where: { id: node.parent_id, ott_id } as any });
        if (!parent) return error(HttpStatus.BAD_REQUEST, "Parent API not found for this child");

        const parent_resolved = await resolve_parent_response(parent, {});
        if (!parent_resolved.data) {
            return error(
                HttpStatus.BAD_REQUEST,
                `Parent API "${parent.name}" has no saved response yet. Call the parent API first, then retry the pagination test.`,
            );
        }
        test_parent_response = parent_resolved.data;
        const endpoint_vars = extract_endpoint_variables(node.endpoint || "");
        const param_mappings = (node.param_mappings || {}) as Record<string, string>;
        const dynamic_params_used: Record<string, any> = {};
        for (const var_name of endpoint_vars) {
            const response_path = param_mappings[var_name];
            if (!response_path) {
                return error(
                    HttpStatus.BAD_REQUEST,
                    `Endpoint variable "${var_name}" has no parent response mapping — open the API form and configure it under Parent API.`,
                    "param_mappings",
                );
            }
            const indexed_path = replace_array_index_in_path(response_path, 0);
            const value = get_value_by_path(parent_resolved.data, indexed_path);
            if (value === undefined || value === null || value === "") {
                return error(
                    HttpStatus.BAD_REQUEST,
                    `Could not resolve "${var_name}" from path "${response_path}" in the parent's first card.`,
                    "param_mappings",
                );
            }
            dynamic_params_used[var_name] = value;
        }
        base_endpoint = resolve_endpoint_variables(node.endpoint || "", dynamic_params_used);
    }

    const test_body = resolve_request_body({
        body_mode: node.body_mode as any,
        request_body_config: node.request_body_config ?? [],
        raw_body: (node.request_body as Record<string, any> | null) ?? null,
        parent_response: test_parent_response,
        card_index: node.parent_id ? 0 : undefined,
    }).body;

    const run = await run_paginated_call({
        ott,
        api_node: node,
        base_endpoint,
        request_body: test_body,
        pagination_type: body.pagination_type,
        pagination_config: body.pagination_config,
        pages_cap_override: 2,
    });

    return success("pagination test completed", {
        api_id: node.id,
        pages_fetched: run.pages_fetched,
        total_items: run.total_items,
        stop_reason: run.stop_reason,
        success: run.final_success,
        last_http_status: run.last_http_status,
        last_error: run.last_error,
        pages: run.pages,
        // Preview only — not persisted.
        merged_response_preview: build_preview(run.merged_response),
    });
}

function build_preview(data: any): string | null {
    if (data === null || data === undefined) return null;
    try {
        return JSON.stringify(data).slice(0, 500);
    } catch {
        return null;
    }
}

/**
 * Resolve which response document to use as the "parent" when a child API is called.
 * Priority:
 *   1. Explicit `source_response_id` (looked up first as a root response, then as a child item response).
 *   2. If `parent_item_key` is provided, the matching child_item_response row.
 *   3. The latest root response from `ott_api_responses` for this api_node.
 */
export async function resolve_parent_response(
    parent: OttApiNode,
    options: { source_response_id?: string | undefined; parent_item_key?: string | undefined },
): Promise<{ kind: "root" | "child" | null; id: string | null; data: any; depth: number; breadcrumb: any[] }> {
    if (options.source_response_id) {
        const child_row = await OttChildApiItemResponse.findOne({ where: { id: options.source_response_id } as any });
        if (child_row) {
            return {
                kind: "child",
                id: child_row.id,
                data: child_row.response,
                depth: child_row.depth ?? 1,
                breadcrumb: (child_row.breadcrumb as any[]) ?? [],
            };
        }
        const root_row = await OttApiResponse.findByPk(options.source_response_id);
        if (root_row) {
            return { kind: "root", id: root_row.id, data: root_row.response, depth: 0, breadcrumb: [] };
        }
    }
    if (options.parent_item_key) {
        const child_row = await OttChildApiItemResponse.findOne({
            where: { child_api_id: parent.id, item_key: options.parent_item_key } as any,
            order: [["called_at", "DESC"]],
        });
        if (child_row) {
            return {
                kind: "child",
                id: child_row.id,
                data: child_row.response,
                depth: child_row.depth ?? 1,
                breadcrumb: (child_row.breadcrumb as any[]) ?? [],
            };
        }
    }
    const root = await OttApiResponse.findOne({ where: { api_node_id: parent.id } as any });
    if (root) return { kind: "root", id: root.id, data: root.response, depth: 0, breadcrumb: [] };
    return { kind: null, id: null, data: null, depth: 0, breadcrumb: [] };
}

export async function call_api_from_card(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const body = req.body as CallFromCardInput;

    const ott = await load_ott_or_error(ott_id, req);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const child = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!child) return error(HttpStatus.NOT_FOUND, "Child API node not found");

    const parent = await OttApiNode.findOne({ where: { id: body.parent_api_id, ott_id } as any });
    if (!parent) return error(HttpStatus.NOT_FOUND, "Parent API node not found");

    if (child.parent_id !== parent.id) {
        return error(HttpStatus.BAD_REQUEST, "Child API does not belong to the given parent");
    }

    const parent_resolved = await resolve_parent_response(parent, {
        source_response_id: body.source_response_id,
        parent_item_key: body.parent_item_key,
    });
    if (!parent_resolved.data) {
        return error(HttpStatus.BAD_REQUEST, "Parent API has no saved response — call the parent API first");
    }

    const endpoint_vars = extract_endpoint_variables(child.endpoint || "");
    const param_mappings = (child.param_mappings || {}) as Record<string, string>;
    const dynamic_params_used: Record<string, any> = {};

    for (const var_name of endpoint_vars) {
        const response_path = param_mappings[var_name];
        if (!response_path) {
            return error(
                HttpStatus.BAD_REQUEST,
                `Endpoint variable "${var_name}" has no parent response mapping`,
                "param_mappings",
            );
        }
        const indexed_path = replace_array_index_in_path(response_path, body.card_index);
        const value = get_value_by_path(parent_resolved.data, indexed_path);
        if (value === undefined || value === null || value === "") {
            return error(
                HttpStatus.BAD_REQUEST,
                `Could not resolve dynamic param "${var_name}" from path: ${response_path}`,
                "param_mappings",
            );
        }
        dynamic_params_used[var_name] = value;
    }

    const resolved_endpoint = resolve_endpoint_variables(child.endpoint || "", dynamic_params_used);

    // Resolve the request body. Child APIs CAN reference parent response paths
    // via variable_path entries — `[0]` placeholders are rewritten to the actual
    // card_index, mirroring how endpoint variables resolve above.
    const child_body_resolution = resolve_request_body({
        body_mode: child.body_mode as any,
        request_body_config: child.request_body_config ?? [],
        raw_body: (child.request_body as Record<string, any> | null) ?? null,
        parent_response: parent_resolved.data,
        card_index: body.card_index,
    });
    if (child_body_resolution.error) {
        return error(
            HttpStatus.BAD_REQUEST,
            `Body resolution failed: ${child_body_resolution.error}`,
            "request_body_config",
        );
    }
    const child_resolved_body = child_body_resolution.body;
    console.log("[body-resolution] child", {
        child_api_id: child.id,
        method: child.method,
        body_mode: child.body_mode ?? "(null)",
        config_entries: (child.request_body_config ?? []).length,
        raw_body_set: !!child.request_body,
        card_index: body.card_index,
        resolved: child_resolved_body,
        diagnostics: child_body_resolution.resolved_entries,
    });

    // Per-call limit override — same pattern as call_api_node. Lets the
    // page-size selector on the nested cards page change limit on the fly.
    const child_runtime_pagination_config = body.limit_value !== undefined
        ? { ...(child.pagination_config ?? {}), limit_value: body.limit_value }
        : (child.pagination_config ?? {});

    // ── Single-page navigation (Prev/Next on the nested cards page) ──────
    // Caller passes ONE of page_number / cursor_value / id_value / offset_value
    // to jump to a specific page of the child API. The strategy applies the
    // page param on top of the already-resolved endpoint (variables done above).
    const wants_specific_page = (
        body.page_number !== undefined ||
        body.cursor_value !== undefined ||
        body.id_value !== undefined ||
        body.offset_value !== undefined
    );

    // Auto-opt-in fetch_all_pages for child APIs that have pagination configured.
    // Reasoning: clicking a parent card to load a paginated child should "just
    // work" — getting only the first page of episodes/sources/etc. is almost
    // never what the user wants, and existing frontend call sites (popup
    // dispatch, card actions, default child run, etc.) don't all pass the flag.
    // Caller can still opt-out explicitly with `fetch_all_pages: false`, OR
    // override with single-page nav params (Prev/Next), both of which take
    // precedence below.
    const should_fetch_all_pages = (
        !wants_specific_page
        && body.fetch_all_pages !== false
        && (body.fetch_all_pages === true || !!child.pagination_enabled)
        && !!child.pagination_enabled
        && !!child.pagination_type
    );

    let result: ExternalCallResult;
    let pagination_summary: { pages_fetched: number; total_items: number; stop_reason: string; pages: any[] } | null = null;
    let single_page_state: any = null;
    if (wants_specific_page && child.pagination_enabled && child.pagination_type) {
        const config = child_runtime_pagination_config;
        const url = build_single_page_url({
            base_endpoint: resolved_endpoint,
            pagination_type: child.pagination_type as PaginationType,
            pagination_config: config,
            page_number: body.page_number ?? null,
            cursor_value: body.cursor_value ?? null,
            id_value: body.id_value ?? null,
            offset_value: body.offset_value ?? null,
        });
        if (!url) {
            return error(HttpStatus.BAD_REQUEST, `Pagination type "${child.pagination_type}" is not supported for single-page navigation`);
        }
        result = await call_external_ott_api({
            ott,
            api_node: child,
            resolved_endpoint: url,
            request_body: child_resolved_body,
            dynamic_params_used,
            card_index: body.card_index,
            item_key: body.item_key ?? null,
            parent_api_id: parent.id,
            parent_api_name: parent.name,
            child_api_id: child.id,
        });
        const next = result.success
            ? inspect_pagination_next_state({
                response: result.data,
                pagination_type: child.pagination_type as PaginationType,
                pagination_config: config,
                current_page_number: body.page_number ?? null,
                current_cursor: body.cursor_value ?? null,
                current_id: body.id_value ?? null,
                current_offset: body.offset_value ?? null,
            })
            : null;
        single_page_state = {
            pagination_type: child.pagination_type,
            current_page_number: body.page_number ?? null,
            current_cursor: body.cursor_value ?? null,
            current_id: body.id_value ?? null,
            current_offset: body.offset_value ?? null,
            next_page_number: next?.next_page_number ?? null,
            next_cursor: next?.next_cursor ?? null,
            next_id: next?.next_id ?? null,
            next_offset: next?.next_offset ?? null,
            has_next: next?.has_next ?? false,
            item_count: next?.item_count ?? 0,
            stop_reason: next?.stop_reason ?? null,
            total_pages: next?.total_pages ?? null,
            total_items: next?.total_items ?? null,
        };
    } else if (should_fetch_all_pages) {
        const run = await run_paginated_call({
            ott,
            api_node: child,
            base_endpoint: resolved_endpoint,
            request_body: child_resolved_body,
            pagination_type: child.pagination_type as PaginationType,
            pagination_config: child_runtime_pagination_config,
            call_extras: {
                dynamic_params_used,
                card_index: body.card_index,
                item_key: body.item_key ?? null,
                parent_api_id: parent.id,
                parent_api_name: parent.name,
                child_api_id: child.id,
            },
        });
        // Adapt the paginated run to the ExternalCallResult shape so the rest
        // of this handler (saving, response stamping, card building) is unchanged.
        const total_duration = run.pages.reduce((sum, p) => sum + (p.duration_ms ?? 0), 0);
        const last_page = run.pages[run.pages.length - 1];
        result = {
            success: run.final_success,
            status: run.last_http_status,
            data: run.merged_response,
            duration_ms: total_duration,
            log_id: last_page?.log_id ?? "",
            error_message: run.last_error,
            request_url: last_page?.request_url ?? "",
            response_preview: build_preview(run.merged_response),
        };
        pagination_summary = {
            pages_fetched: run.pages_fetched,
            total_items: run.total_items,
            stop_reason: run.stop_reason,
            pages: run.pages,
        };
    } else {
        result = await call_external_ott_api({
            ott,
            api_node: child,
            resolved_endpoint,
            request_body: child_resolved_body,
            dynamic_params_used,
            card_index: body.card_index,
            item_key: body.item_key ?? null,
            parent_api_id: parent.id,
            parent_api_name: parent.name,
            child_api_id: child.id,
        });
    }

    const item_key = body.item_key && body.item_key.length > 0 ? body.item_key : `index_${body.card_index}`;
    const parent_item_key = body.parent_item_key ?? "";
    const status = result.success ? "success" : "failed";

    const next_breadcrumb = [
        ...(parent_resolved.breadcrumb || []),
        { api_id: parent.id, api_name: parent.name, item_key },
    ];

    const child_payload = {
        ott_id,
        parent_api_id: parent.id,
        child_api_id: child.id,
        parent_item_key,
        item_key,
        card_index: body.card_index,
        resolved_endpoint,
        response: result.data,
        http_status: result.status,
        status,
        error_message: result.error_message ?? null,
        depth: (parent_resolved.depth ?? 0) + 1,
        breadcrumb: next_breadcrumb,
        called_at: new Date(),
    } as any;

    const existing = await OttChildApiItemResponse.findOne({
        where: {
            child_api_id: child.id,
            parent_api_id: parent.id,
            parent_item_key,
            item_key,
        } as any,
    });
    let saved_child_id: string;
    if (existing) {
        await existing.update(child_payload);
        saved_child_id = existing.id;
    } else {
        const created = await OttChildApiItemResponse.create(child_payload);
        saved_child_id = created.id;
    }

    await child.update({
        status,
        last_http_status: result.status,
        last_error: result.success ? null : result.error_message ?? `HTTP ${result.status ?? "ERR"}`,
        last_called_at: new Date(),
    });

    // Build cards for the child API immediately if card_enabled. Always reads
    // the response that was just returned by the external call (which is also
    // saved in ott_child_api_item_responses) — never the root response table.
    const child_fields = await OttSelectedField.findAll({
        where: { api_node_id: child.id, is_visible: true } as any,
        order: [["sort_order", "ASC"]],
    });
    let cards_payload: {
        api_id: string;
        card_enabled: boolean;
        cards: any[];
        list_path: string | null;
        selected_fields: any[];
        quick_run: boolean;
        default_child_api_id: string | null;
        open_type: string;
    } = {
        api_id: child.id,
        card_enabled: false,
        cards: [],
        list_path: child.list_path ?? null,
        selected_fields: child_fields.map(selected_field_dto),
        quick_run: child.quick_run ?? false,
        default_child_api_id: child.default_child_api_id ?? null,
        open_type: child.open_type ?? "inline",
    };
    if (child.card_enabled && result.success && result.data !== null && result.data !== undefined) {
        cards_payload = {
            ...cards_payload,
            card_enabled: true,
            cards: await build_cards_for_api(child, result.data),
        };
    }

    console.log("[CHILD API CARD DEBUG]", {
        child_api_id: child.id,
        parent_api_id: parent.id,
        source_response_id: saved_child_id,
        has_response: result.data !== null && result.data !== undefined,
        card_enabled: child.card_enabled ?? false,
        list_path: child.list_path ?? null,
        selected_fields_count: child_fields.length,
        cards_count: cards_payload.cards.length,
        success: result.success,
        http_status: result.status,
    });

    return success(
        single_page_state
            ? "child api page fetched successfully"
            : pagination_summary
                ? "child api called successfully (paginated)"
                : "child api called successfully",
        {
            parent_api_id: parent.id,
            child_api_id: child.id,
            card_index: body.card_index,
            item_key,
            parent_item_key: parent_item_key || null,
            source_response_id: saved_child_id,
            response_id: saved_child_id,
            resolved_endpoint,
            success: result.success,
            http_status: result.status,
            duration_ms: result.duration_ms,
            log_id: result.log_id,
            response: result.data,
            error_message: result.error_message ?? null,
            cards: cards_payload,
            pagination: pagination_summary,
            pagination_state: single_page_state,
        },
    );
}

export async function sync_ott_apis(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const body = (req.body || {}) as SyncOttInput;
    const mode = body.mode ?? "root_only";
    const fetch_all_pages = body.fetch_all_pages === true;

    const ott = await load_ott_or_error(ott_id, req);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const where: any = { ott_id };
    if (mode === "root_only") where.parent_id = null;

    const nodes = await OttApiNode.findAll({ where, order: [["sort_order", "ASC"], ["createdAt", "ASC"]] });

    const synced: any[] = [];
    for (const node of nodes) {
        // Paginated path: only when fetch_all_pages is requested AND the node
        // has pagination configured. Other nodes always do a single first-page
        // fetch — matches existing behaviour for un-configured APIs.
        if (fetch_all_pages && node.pagination_enabled && node.pagination_type && !node.parent_id) {
            const sync_paginated_body = resolve_request_body({
                body_mode: node.body_mode as any,
                request_body_config: node.request_body_config ?? [],
                raw_body: (node.request_body as Record<string, any> | null) ?? null,
            }).body;
            const run = await run_paginated_call({
                ott,
                api_node: node,
                base_endpoint: node.endpoint!,
                request_body: sync_paginated_body,
                pagination_type: node.pagination_type as PaginationType,
                pagination_config: node.pagination_config ?? {},
            });
            const total_duration = run.pages.reduce((sum, p) => sum + (p.duration_ms ?? 0), 0);
            const last_log_id = run.pages[run.pages.length - 1]?.log_id ?? "";
            await persist_node_response(node, ott_id, {
                success: run.final_success,
                status: run.last_http_status,
                data: run.merged_response,
                duration_ms: total_duration,
                response_preview: build_preview(run.merged_response),
                error_message: run.last_error,
            });
            await node.update({ last_synced_at: new Date() });
            // Auto-capture new video assets if this node has a capture_mapping.
            if (run.final_success && run.merged_response) {
                const mapping = (node.card_config as any)?.capture_mapping;
                if (mapping && Array.isArray(mapping.video_url_paths) && mapping.video_url_paths.length > 0) {
                    capture_for_node({ ott_id, api_node_id: node.id!, response: run.merged_response, mapping }).catch(() => {});
                }
            }
            synced.push({
                api_id: node.id,
                name: node.name,
                success: run.final_success,
                http_status: run.last_http_status,
                duration_ms: total_duration,
                log_id: last_log_id,
                pagination: {
                    pages_fetched: run.pages_fetched,
                    total_items: run.total_items,
                    stop_reason: run.stop_reason,
                },
            });
            continue;
        }

        const sync_body = resolve_request_body({
            body_mode: node.body_mode as any,
            request_body_config: node.request_body_config ?? [],
            raw_body: (node.request_body as Record<string, any> | null) ?? null,
        }).body;
        const result = await call_external_ott_api({
            ott,
            api_node: node,
            resolved_endpoint: node.endpoint!,
            request_body: sync_body,
        });
        await persist_node_response(node, ott_id, result);
        await node.update({ last_synced_at: new Date() });
        // Auto-capture new video assets if this node has a capture_mapping.
        if (result.success && result.data) {
            const mapping = (node.card_config as any)?.capture_mapping;
            if (mapping && Array.isArray(mapping.video_url_paths) && mapping.video_url_paths.length > 0) {
                capture_for_node({ ott_id, api_node_id: node.id!, response: result.data, mapping }).catch(() => {});
            }
        }
        synced.push({
            api_id: node.id,
            name: node.name,
            success: result.success,
            http_status: result.status,
            duration_ms: result.duration_ms,
            log_id: result.log_id,
            pagination: null,
        });
    }

    await ott.update({ last_synced_at: new Date() });

    return success("sync completed", {
        ott_id,
        mode,
        fetch_all_pages,
        total: synced.length,
        results: synced,
    });
}

export async function save_selected_fields(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const body = req.body as SaveSelectedFieldsInput;

    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    await node.update({ list_path: body.list_path });

    await OttSelectedField.destroy({ where: { api_node_id: api_id } as any });

    const created = await OttSelectedField.bulkCreate(
        body.selected_fields.map((f) => ({
            ott_id,
            api_node_id: api_id,
            path: f.path,
            label: f.label ?? null,
            display_type: f.display_type,
            sort_order: f.sort_order,
            is_visible: f.is_visible !== false,
        })) as any[],
    );

    return success("selected fields saved successfully", {
        api_id,
        list_path: body.list_path,
        selected_fields: created.map(selected_field_dto),
    });
}

export async function get_selected_fields(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    const fields = await OttSelectedField.findAll({
        where: { api_node_id: api_id } as any,
        order: [["sort_order", "ASC"]],
    });

    return success("selected fields fetched successfully", {
        api_id,
        list_path: node.list_path ?? null,
        selected_fields: fields.map(selected_field_dto),
    });
}

/**
 * Run a one-off sample call against an API node so the card builder can
 * extract field paths. For root APIs this just runs the API; for child APIs
 * it auto-resolves the parent's saved response and runs `call_from_card`
 * against the first parent card.
 */
export async function sample_call(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };

    const ott = await load_ott_or_error(ott_id, req);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    // ── Root API: just call it. ──────────────────────────────────────────
    if (!node.parent_id) {
        const sample_root_body = resolve_request_body({
            body_mode: node.body_mode as any,
            request_body_config: node.request_body_config ?? [],
            raw_body: (node.request_body as Record<string, any> | null) ?? null,
        }).body;
        const result = await call_external_ott_api({
            ott,
            api_node: node,
            resolved_endpoint: node.endpoint!,
            request_body: sample_root_body,
        });
        await persist_node_response(node, ott_id, result);
        return success("sample call completed", {
            api_id,
            source: "root",
            success: result.success,
            http_status: result.status,
            duration_ms: result.duration_ms,
            log_id: result.log_id,
            response: result.data,
            error_message: result.error_message ?? null,
        });
    }

    // ── Child API: resolve parent + first card and call_from_card. ──────
    const parent = await OttApiNode.findOne({ where: { id: node.parent_id, ott_id } as any });
    if (!parent) return error(HttpStatus.BAD_REQUEST, "Parent API not found for this child");

    const parent_resolved = await resolve_parent_response(parent, {});
    if (!parent_resolved.data) {
        return error(
            HttpStatus.BAD_REQUEST,
            `Parent API "${parent.name}" has no saved response yet. Call the parent API first, then retry.`,
        );
    }

    // Use index 0 for the sample so we have a deterministic first card.
    const card_index = 0;
    const endpoint_vars = extract_endpoint_variables(node.endpoint || "");
    const param_mappings = (node.param_mappings || {}) as Record<string, string>;
    const dynamic_params_used: Record<string, any> = {};
    for (const var_name of endpoint_vars) {
        const response_path = param_mappings[var_name];
        if (!response_path) {
            return error(
                HttpStatus.BAD_REQUEST,
                `Endpoint variable "${var_name}" has no parent response mapping`,
                "param_mappings",
            );
        }
        const indexed_path = replace_array_index_in_path(response_path, card_index);
        const value = get_value_by_path(parent_resolved.data, indexed_path);
        if (value === undefined || value === null || value === "") {
            return error(
                HttpStatus.BAD_REQUEST,
                `Could not resolve dynamic param "${var_name}" from path: ${response_path}`,
                "param_mappings",
            );
        }
        dynamic_params_used[var_name] = value;
    }
    const final_endpoint = resolve_endpoint_variables(node.endpoint || "", dynamic_params_used);

    // Find a usable item_key from the parent's first card so we can cache the row.
    const parent_fields = await OttSelectedField.findAll({
        where: { api_node_id: parent.id, is_visible: true } as any,
        order: [["sort_order", "ASC"]],
    });
    const parent_selected: SelectedFieldDef[] = parent_fields.map((f) => ({
        path: f.path!,
        label: f.label ?? null,
        display_type: f.display_type!,
        sort_order: f.sort_order ?? 0,
        is_visible: f.is_visible ?? true,
    }));
    const parent_cards = build_cards_from_response(parent_resolved.data, parent.list_path ?? "", parent_selected);
    const item_key = parent_cards[0]?.item_key || `index_${card_index}`;

    const sample_child_body = resolve_request_body({
        body_mode: node.body_mode as any,
        request_body_config: node.request_body_config ?? [],
        raw_body: (node.request_body as Record<string, any> | null) ?? null,
        parent_response: parent_resolved.data,
        card_index,
    }).body;
    const result = await call_external_ott_api({
        ott,
        api_node: node,
        resolved_endpoint: final_endpoint,
        request_body: sample_child_body,
        dynamic_params_used,
        card_index,
        item_key,
        parent_api_id: parent.id,
        parent_api_name: parent.name,
        child_api_id: node.id,
    });

    const status = result.success ? "success" : "failed";
    const child_payload = {
        ott_id,
        parent_api_id: parent.id,
        child_api_id: node.id,
        parent_item_key: "",
        item_key,
        card_index,
        resolved_endpoint: final_endpoint,
        response: result.data,
        http_status: result.status,
        status,
        error_message: result.error_message ?? null,
        depth: 1,
        breadcrumb: [{ api_id: parent.id, api_name: parent.name, item_key }],
        called_at: new Date(),
    } as any;

    const existing = await OttChildApiItemResponse.findOne({
        where: { child_api_id: node.id, parent_api_id: parent.id, parent_item_key: "", item_key } as any,
    });
    let saved_id: string;
    if (existing) {
        await existing.update(child_payload);
        saved_id = existing.id;
    } else {
        const created = await OttChildApiItemResponse.create(child_payload);
        saved_id = created.id;
    }

    await node.update({
        status,
        last_http_status: result.status,
        last_error: result.success ? null : result.error_message ?? `HTTP ${result.status ?? "ERR"}`,
        last_called_at: new Date(),
    });

    return success("sample call completed", {
        api_id,
        source: "child",
        source_response_id: saved_id,
        parent_api_id: parent.id,
        parent_api_name: parent.name,
        item_key,
        card_index,
        success: result.success,
        http_status: result.status,
        duration_ms: result.duration_ms,
        log_id: result.log_id,
        resolved_endpoint: final_endpoint,
        response: result.data,
        error_message: result.error_message ?? null,
    });
}

export async function get_card_config(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    const fields = await OttSelectedField.findAll({
        where: { api_node_id: api_id } as any,
        order: [["sort_order", "ASC"]],
    });

    return success("card config fetched successfully", {
        api_id,
        card_enabled: node.card_enabled ?? false,
        list_path: node.list_path ?? null,
        quick_run: node.quick_run ?? false,
        default_child_api_id: node.default_child_api_id ?? null,
        default_card_action_id: node.default_card_action_id ?? null,
        skip_action_modal: node.skip_action_modal ?? false,
        open_type: node.open_type ?? "inline",
        card_config: node.card_config ?? {},
        selected_fields: fields.map(selected_field_dto),
    });
}

export async function save_card_config(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const body = req.body as SaveCardConfigInput;

    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    if (body.default_child_api_id) {
        const child = await OttApiNode.findOne({
            where: { id: body.default_child_api_id, ott_id } as any,
        });
        if (!child) {
            return error(HttpStatus.BAD_REQUEST, "default_child_api_id does not belong to this OTT", "default_child_api_id");
        }
        if (child.parent_id !== api_id) {
            return error(HttpStatus.BAD_REQUEST, "default_child_api_id must be a direct child of this API", "default_child_api_id");
        }
    }

    await node.update({
        card_enabled: body.card_enabled ?? true,
        list_path: body.list_path,
        quick_run: body.quick_run ?? false,
        default_child_api_id: body.default_child_api_id ?? null,
        default_card_action_id: body.default_card_action_id ?? null,
        skip_action_modal: body.skip_action_modal ?? false,
        open_type: body.open_type ?? "inline",
        card_config: body.card_config ?? {},
    });

    await OttSelectedField.destroy({ where: { api_node_id: api_id } as any });
    const created = await OttSelectedField.bulkCreate(
        body.selected_fields.map((f) => ({
            ott_id,
            api_node_id: api_id,
            path: f.path,
            label: f.label ?? null,
            display_type: f.display_type,
            sort_order: f.sort_order,
            is_visible: f.is_visible !== false,
        })) as any[],
    );

    return success("card config saved successfully", {
        api_id,
        card_enabled: node.card_enabled ?? true,
        list_path: node.list_path ?? null,
        quick_run: node.quick_run ?? false,
        default_child_api_id: node.default_child_api_id ?? null,
        default_card_action_id: node.default_card_action_id ?? null,
        skip_action_modal: node.skip_action_modal ?? false,
        open_type: node.open_type ?? "inline",
        card_config: node.card_config ?? {},
        selected_fields: created.map(selected_field_dto),
    });
}

export async function get_cards_from_context(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const query = (req.query || {}) as CardsFromContextQueryInput;

    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    const row = await OttChildApiItemResponse.findOne({
        where: { id: query.source_response_id, child_api_id: api_id } as any,
    });
    if (!row) {
        return error(
            HttpStatus.NOT_FOUND,
            "No saved child response found for this api/source_response_id",
            "source_response_id",
        );
    }

    if (!node.card_enabled) {
        return success("card not configured", {
            api_id,
            source_response_id: row.id,
            item_key: row.item_key,
            card_enabled: false,
            list_path: node.list_path ?? null,
            quick_run: node.quick_run ?? false,
            default_child_api_id: node.default_child_api_id ?? null,
            open_type: node.open_type ?? "inline",
            response: row.response,
            cards: [],
            message: "Card is not configured for this child API.",
        });
    }

    const cards = await build_cards_for_api(node, row.response);
    return success("cards from context fetched successfully", {
        api_id,
        source_response_id: row.id,
        item_key: row.item_key,
        card_enabled: true,
        list_path: node.list_path ?? null,
        quick_run: node.quick_run ?? false,
        default_child_api_id: node.default_child_api_id ?? null,
        open_type: node.open_type ?? "inline",
        card_config: node.card_config ?? {},
        response: row.response,
        cards,
    });
}

export async function get_api_response(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    // Root API: read from ott_api_responses.
    if (!node.parent_id) {
        const latest = await OttApiResponse.findOne({ where: { api_node_id: api_id } as any });
        if (!latest) return success("no saved response", { api_id, response: null, source: "root" });
        return success("api response fetched successfully", {
            api_id,
            source: "root",
            source_response_id: latest.id,
            http_status: latest.http_status ?? null,
            duration_ms: latest.duration_ms ?? null,
            response_preview: latest.response_preview ?? null,
            response: latest.response,
            updatedAt: ts((latest as any).updatedAt),
        });
    }

    // Child API: pull the most recent cached child item response so the card builder
    // can extract sample fields without requiring the user to call_from_card again.
    const latest_child = await OttChildApiItemResponse.findOne({
        where: { child_api_id: api_id } as any,
        order: [["called_at", "DESC"]],
    });
    if (!latest_child) {
        return success("no saved response", {
            api_id,
            response: null,
            source: "child",
            message: "Child APIs are sampled by clicking a card on the parent. Run `sample_call` to do that automatically.",
        });
    }
    return success("api response fetched successfully", {
        api_id,
        source: "child",
        source_response_id: latest_child.id,
        item_key: latest_child.item_key,
        parent_item_key: latest_child.parent_item_key ?? null,
        http_status: latest_child.http_status ?? null,
        response: latest_child.response,
        updatedAt: ts((latest_child as any).called_at ?? (latest_child as any).updatedAt),
    });
}

export async function get_api_cards(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    const [latest, fields, actions] = await Promise.all([
        OttApiResponse.findOne({ where: { api_node_id: api_id } as any }),
        OttSelectedField.findAll({ where: { api_node_id: api_id } as any, order: [["sort_order", "ASC"]] }),
        OttCardAction.findAll({
            where: { api_node_id: api_id, is_active: true } as any,
            order: [["sort_order", "ASC"], ["createdAt", "ASC"]],
        }),
    ]);

    const default_action_id = (node.card_config as any)?.default_card_click_action_id ?? null;
    const action_payload = actions.map(card_action_dto);
    const base_payload = {
        api_id,
        api_name: node.name,
        card_enabled: node.card_enabled ?? false,
        quick_run: node.quick_run ?? false,
        default_child_api_id: node.default_child_api_id ?? null,
        default_card_action_id: node.default_card_action_id ?? null,
        skip_action_modal: node.skip_action_modal ?? false,
        open_type: node.open_type ?? "inline",
        list_path: node.list_path ?? null,
        card_config: node.card_config ?? {},
        actions: action_payload,
        default_card_click_action_id: default_action_id,
    };

    if (!latest || !node.card_enabled) {
        return success("no cards", {
            ...base_payload,
            cards: [],
            message: !node.card_enabled
                ? "Card is not configured for this API."
                : "No saved response yet — call the API first.",
        });
    }

    const selected: SelectedFieldDef[] = fields.map((f) => ({
        path: f.path!,
        label: f.label ?? null,
        display_type: f.display_type!,
        sort_order: f.sort_order ?? 0,
        is_visible: f.is_visible ?? true,
    }));

    const cards = build_cards_from_response(latest.response, node.list_path ?? "", selected);

    return success("cards fetched successfully", { ...base_payload, cards });
}

export async function get_ott_cards(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const ott = await load_ott_or_error(ott_id, req);
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const root_nodes = await OttApiNode.findAll({
        where: { ott_id, parent_id: null } as any,
        order: [["sort_order", "ASC"], ["createdAt", "ASC"]],
    });

    const ids = root_nodes.map((n) => n.id);
    const [responses, fields, actions] = await Promise.all([
        ids.length
            ? OttApiResponse.findAll({ where: { api_node_id: { [Op.in]: ids } } as any })
            : Promise.resolve([] as OttApiResponse[]),
        ids.length
            ? OttSelectedField.findAll({
                where: { api_node_id: { [Op.in]: ids } } as any,
                order: [["sort_order", "ASC"]],
            })
            : Promise.resolve([] as OttSelectedField[]),
        ids.length
            ? OttCardAction.findAll({
                where: { api_node_id: { [Op.in]: ids }, is_active: true } as any,
                order: [["sort_order", "ASC"], ["createdAt", "ASC"]],
            })
            : Promise.resolve([] as OttCardAction[]),
    ]);

    const responses_by_node = new Map<string, OttApiResponse>();
    for (const r of responses) responses_by_node.set(r.api_node_id!, r);
    const fields_by_node = new Map<string, OttSelectedField[]>();
    for (const f of fields) {
        if (!fields_by_node.has(f.api_node_id!)) fields_by_node.set(f.api_node_id!, []);
        fields_by_node.get(f.api_node_id!)!.push(f);
    }
    const actions_by_node = new Map<string, OttCardAction[]>();
    for (const a of actions) {
        if (!actions_by_node.has(a.api_node_id!)) actions_by_node.set(a.api_node_id!, []);
        actions_by_node.get(a.api_node_id!)!.push(a);
    }

    const sections = root_nodes
        .map((n) => {
            if (!n.card_enabled) return null;
            const node_fields = fields_by_node.get(n.id) ?? [];
            if (!node_fields.length) return null;
            const latest = responses_by_node.get(n.id);
            if (!latest) return null;
            const selected: SelectedFieldDef[] = node_fields.map((f) => ({
                path: f.path!,
                label: f.label ?? null,
                display_type: f.display_type!,
                sort_order: f.sort_order ?? 0,
                is_visible: f.is_visible ?? true,
            }));
            const cards = build_cards_from_response(latest.response, n.list_path ?? "", selected);
            const node_actions = (actions_by_node.get(n.id) ?? []).map(card_action_dto);
            const default_action_id = (n.card_config as any)?.default_card_click_action_id ?? null;
            return {
                api_id: n.id,
                api_name: n.name,
                card_enabled: true,
                quick_run: n.quick_run ?? false,
                default_child_api_id: n.default_child_api_id ?? null,
                default_card_action_id: n.default_card_action_id ?? null,
                skip_action_modal: n.skip_action_modal ?? false,
                open_type: n.open_type ?? "inline",
                list_path: n.list_path ?? null,
                card_config: n.card_config ?? {},
                actions: node_actions,
                default_card_click_action_id: default_action_id,
                cards,
            };
        })
        .filter((s): s is {
            api_id: string;
            api_name: string | undefined;
            card_enabled: boolean;
            quick_run: boolean;
            default_child_api_id: string | null;
            default_card_action_id: string | null;
            skip_action_modal: boolean;
            open_type: string;
            list_path: string | null;
            card_config: Record<string, any>;
            actions: any[];
            default_card_click_action_id: string | null;
            cards: any[];
        } => s !== null);

    return success("ott cards fetched successfully", { ott_id, sections });
}

// Helper exported for completeness — used internally by call_api_from_card via item_key.
export { get_item_key };

// ── Capture mapping (stored on api_node.card_config.capture_mapping) ─────

export async function get_capture_mapping(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");
    const mapping = (node.card_config as any)?.capture_mapping ?? null;
    return success("capture mapping fetched", {
        api_id,
        list_path: node.list_path ?? null,
        mapping,
    });
}

export async function save_capture_mapping(req: FastifyRequest) {
    const { ott_id, api_id } = req.params as { ott_id: string; api_id: string };
    const body = req.body as CaptureMappingInput;
    const node = await OttApiNode.findOne({ where: { id: api_id, ott_id } as any });
    if (!node) return error(HttpStatus.NOT_FOUND, "API node not found");

    const next_config = {
        ...(node.card_config as Record<string, any> ?? {}),
        capture_mapping: {
            list_path: body.list_path ?? null,
            video_url_paths: body.video_url_paths,
            title_path: body.title_path ?? null,
            description_path: body.description_path ?? null,
            thumbnail_path: body.thumbnail_path ?? null,
            quality_path: body.quality_path ?? null,
            language_path: body.language_path ?? null,
            duration_path: body.duration_path ?? null,
            save_video: body.save_video !== false,
            save_image: body.save_image !== false,
            save_thumbnail: body.save_thumbnail !== false,
            convert_to_mp4: body.convert_to_mp4 !== false,
        },
    };
    await node.update({ card_config: next_config });

    return success("capture mapping saved", {
        api_id,
        mapping: next_config.capture_mapping,
    });
}
