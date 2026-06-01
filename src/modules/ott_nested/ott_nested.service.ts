import type { FastifyRequest } from "fastify";
import {
    OttPlatform,
    OttApiNode,
    OttApiResponse,
    OttSelectedField,
    OttCardAction,
    OttChildApiItemResponse,
    OttVideoAsset,
} from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import { call_external_ott_api } from "../../utils/ott_proxy";
import {
    get_value_by_path,
    replace_array_index_in_path,
    build_cards_from_response,
    extract_endpoint_variables,
    resolve_endpoint_variables,
    type SelectedFieldDef,
} from "../../utils/response_path_utils";
import { card_action_dto } from "../ott_card_actions/ott_card_actions.service";
import { resolve_parent_response } from "../ott_api/ott_api.service";
import { resolve_request_body } from "../ott_api/ott_api_body.service";
import type { GetNestedQueryInput } from "./ott_nested.dto";

function ts(value: any): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function api_summary(n: OttApiNode) {
    return {
        id: n.id,
        name: n.name,
        endpoint: n.endpoint,
        method: n.method,
        list_path: n.list_path ?? null,
        param_mappings: n.param_mappings ?? {},
        status: n.status,
        last_http_status: n.last_http_status ?? null,
        last_error: n.last_error ?? null,
        lastCalledAt: ts(n.last_called_at),
    };
}

async function build_cards_for(node: OttApiNode, response: any) {
    const fields = await OttSelectedField.findAll({
        where: { api_node_id: node.id, is_visible: true } as any,
        order: [["sort_order", "ASC"]],
    });
    const selected: SelectedFieldDef[] = fields.map((f) => ({
        path: f.path!,
        label: f.label ?? null,
        display_type: f.display_type!,
        sort_order: f.sort_order ?? 0,
        is_visible: f.is_visible ?? true,
    }));
    const cards = build_cards_from_response(response, node.list_path ?? "", selected);
    return cards;
}

export async function get_nested_data(req: FastifyRequest) {
    const { ott_id, parent_api_id, item_key, child_api_id } = req.params as {
        ott_id: string;
        parent_api_id: string;
        item_key: string;
        child_api_id: string;
    };
    const query = (req.query || {}) as GetNestedQueryInput;
    const decoded_item_key = decodeURIComponent(item_key);
    const card_index = typeof query.card_index === "number" ? query.card_index : 0;
    const force_sync = query.force_sync === true || query.force_sync === "true";

    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id: (req as any).userId } as any });
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const parent = await OttApiNode.findOne({ where: { id: parent_api_id, ott_id } as any });
    if (!parent) return error(HttpStatus.NOT_FOUND, "Parent API not found");

    const child = await OttApiNode.findOne({ where: { id: child_api_id, ott_id } as any });
    if (!child) return error(HttpStatus.NOT_FOUND, "Child API not found");

    if (child.parent_id !== parent.id) {
        return error(HttpStatus.BAD_REQUEST, "Child API does not belong to the given parent");
    }

    // Resolve parent response (root or nested child item).
    const parent_resolved = await resolve_parent_response(parent, {
        source_response_id: query.source_response_id,
        parent_item_key: query.parent_item_key,
    });
    if (!parent_resolved.data) {
        return error(
            HttpStatus.BAD_REQUEST,
            "Parent API has no saved response. Call the parent API first.",
        );
    }

    // Build the parent card so the page can display the selected item.
    const parent_cards = await build_cards_for(parent, parent_resolved.data);
    const parent_card =
        parent_cards.find((c) => c.item_key === decoded_item_key && c.index === card_index)
        || parent_cards.find((c) => c.item_key === decoded_item_key)
        || parent_cards[card_index]
        || null;

    // Try cached child response first (unless force_sync).
    const cache_query = {
        child_api_id: child.id,
        parent_api_id: parent.id,
        parent_item_key: query.parent_item_key ?? "",
        item_key: decoded_item_key,
    };

    let cached = false;
    let child_row: OttChildApiItemResponse | null = null;
    if (!force_sync) {
        child_row = await OttChildApiItemResponse.findOne({ where: cache_query as any });
        if (child_row) cached = true;
    }

    let child_response_data: any = null;
    let resolved_endpoint: string | null = null;
    let log_id: string | null = null;
    let call_success: boolean | null = null;
    let http_status: number | null = null;
    let error_message: string | null = null;

    if (child_row) {
        child_response_data = child_row.response;
        resolved_endpoint = child_row.resolved_endpoint ?? null;
        call_success = child_row.status === "success";
        http_status = child_row.http_status ?? null;
        error_message = child_row.error_message ?? null;
    } else {
        // No cached response: resolve variables from parent response and call.
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

        const final_endpoint = resolve_endpoint_variables(child.endpoint || "", dynamic_params_used);
        // Resolve request body via the same builder used by call_api_from_card.
        // Without this, body_mode=key_value entries would be dropped on this
        // path (the nested cards page) and POST/PUT/PATCH would go out empty.
        const body_resolution = resolve_request_body({
            body_mode: child.body_mode as any,
            request_body_config: child.request_body_config ?? [],
            raw_body: (child.request_body as Record<string, any> | null) ?? null,
            parent_response: parent_resolved.data,
            card_index,
        });
        if (body_resolution.error) {
            return error(
                HttpStatus.BAD_REQUEST,
                `Body resolution failed: ${body_resolution.error}`,
                "request_body_config",
            );
        }
        console.log("[body-resolution] nested", {
            child_api_id: child.id,
            method: child.method,
            body_mode: child.body_mode ?? "(null)",
            config_entries: (child.request_body_config ?? []).length,
            card_index,
            resolved: body_resolution.body,
        });
        const result = await call_external_ott_api({
            ott,
            api_node: child,
            resolved_endpoint: final_endpoint,
            request_body: body_resolution.body,
            dynamic_params_used,
            card_index,
            item_key: decoded_item_key,
            parent_api_id: parent.id,
            parent_api_name: parent.name,
            child_api_id: child.id,
        });

        const next_breadcrumb = [
            ...(parent_resolved.breadcrumb || []),
            { api_id: parent.id, api_name: parent.name, item_key: decoded_item_key },
        ];

        const child_payload = {
            ott_id,
            parent_api_id: parent.id,
            child_api_id: child.id,
            parent_item_key: query.parent_item_key ?? "",
            item_key: decoded_item_key,
            card_index,
            resolved_endpoint: final_endpoint,
            response: result.data,
            http_status: result.status,
            status: result.success ? "success" : "failed",
            error_message: result.error_message ?? null,
            depth: (parent_resolved.depth ?? 0) + 1,
            breadcrumb: next_breadcrumb,
            called_at: new Date(),
        } as any;

        // Upsert (compound key may already exist if force_sync).
        const existing = await OttChildApiItemResponse.findOne({ where: cache_query as any });
        if (existing) {
            await existing.update(child_payload);
            child_row = existing;
        } else {
            child_row = await OttChildApiItemResponse.create(child_payload);
        }

        await child.update({
            status: result.success ? "success" : "failed",
            last_http_status: result.status,
            last_error: result.success ? null : result.error_message ?? `HTTP ${result.status ?? "ERR"}`,
            last_called_at: new Date(),
        });

        child_response_data = result.data;
        resolved_endpoint = final_endpoint;
        log_id = result.log_id;
        call_success = result.success;
        http_status = result.status;
        error_message = result.error_message ?? null;
    }

    // Build child cards if the child API is configured.
    const child_cards = await build_cards_for(child, child_response_data);

    // Card actions configured on the child API.
    const child_actions = await OttCardAction.findAll({
        where: { api_node_id: child.id, is_active: true } as any,
        order: [["sort_order", "ASC"], ["createdAt", "ASC"]],
    });
    const default_action_id = (child.card_config as any)?.default_card_click_action_id ?? null;

    return success("nested data fetched successfully", {
        ott_id,
        parent_api: api_summary(parent),
        child_api: api_summary(child),
        parent_card,
        parent_card_index: card_index,
        parent_item_key: query.parent_item_key ?? null,
        source_response_id: child_row?.id ?? null,
        upstream_source_response_id: parent_resolved.id,
        upstream_source_type: parent_resolved.kind,
        breadcrumb: child_row?.breadcrumb ?? [],
        depth: child_row?.depth ?? (parent_resolved.depth ?? 0) + 1,
        cached,
        child_response: child_response_data,
        child_resolved_endpoint: resolved_endpoint,
        child_http_status: http_status,
        child_call_success: call_success,
        child_error_message: error_message,
        child_log_id: log_id,
        child_cards,
        child_actions: child_actions.map(card_action_dto),
        default_card_click_action_id: default_action_id,
    });
}

/**
 * GET /api/ott/:ott_id/cards/:parent_api_id/:item_key/:child_api_id
 *
 * Same data as `get_nested_data` but reshaped to the spec the new NestedCardsPage
 * expects, plus a `captured_videos` array of video assets that were captured from
 * this child API's saved responses.
 */
export async function get_nested_cards_page(req: FastifyRequest) {
    const inner_result = await get_nested_data(req);
    if (!inner_result?.success) return inner_result;

    const data = (inner_result as any).data;
    const captured_videos = await OttVideoAsset.findAll({
        where: { ott_id: data.ott_id, api_node_id: data.child_api.id } as any,
        order: [["createdAt", "DESC"]],
        limit: 50,
    });

    return success("nested cards fetched successfully", {
        ott_id: data.ott_id,
        parent_api: data.parent_api,
        child_api: data.child_api,
        parent_card: data.parent_card,
        parent_card_index: data.parent_card_index,
        parent_item_key: data.parent_item_key,
        response_id: data.source_response_id,
        source_response_id: data.source_response_id,
        upstream_source_response_id: data.upstream_source_response_id,
        breadcrumb: data.breadcrumb,
        depth: data.depth,
        cached: data.cached,
        child_response: data.child_response,
        child_resolved_endpoint: data.child_resolved_endpoint,
        child_http_status: data.child_http_status,
        child_call_success: data.child_call_success,
        child_error_message: data.child_error_message,
        child_log_id: data.child_log_id,
        cards_data: {
            api_id: data.child_api.id,
            card_enabled: data.child_cards.length > 0 || (data.child_api.list_path !== null),
            list_path: data.child_api.list_path,
            cards: data.child_cards,
            actions: data.child_actions,
            default_card_click_action_id: data.default_card_click_action_id,
        },
        captured_videos: captured_videos.map((v) => ({
            id: v.id,
            title: v.title ?? null,
            video_url: v.video_url,
            video_type: v.video_type ?? null,
            quality: v.quality ?? null,
            thumbnail: v.thumbnail ?? null,
            createdAt: ts((v as any).createdAt),
        })),
    });
}
