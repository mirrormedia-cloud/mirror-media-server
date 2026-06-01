import type { FastifyRequest } from "fastify";
import { OttPlatform, OttApiNode, OttSelectedField, OttApiResponse } from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import { normalize_cookie_input } from "../../utils/cookie_parser";
import type { CreateOttInput, UpdateOttInput } from "./ott.dto";

function timestamp_dto(value: any): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function platform_summary_dto(p: OttPlatform, extras: { total_apis?: number; total_selected_sections?: number } = {}) {
    return {
        id: p.id,
        user_id: (p as any).user_id ?? null,
        name: p.name,
        description: p.description ?? null,
        base_url: p.base_url,
        cookie_file_name: p.cookie_file_name ?? null,
        favicon_url: (p as any).favicon_url ?? null,
        headers: p.headers ?? {},
        status: p.status,
        total_apis: extras.total_apis ?? 0,
        total_selected_sections: extras.total_selected_sections ?? 0,
        lastSyncedAt: timestamp_dto((p as any).last_synced_at),
        createdAt: timestamp_dto((p as any).createdAt ?? (p as any).created_at),
        updatedAt: timestamp_dto((p as any).updatedAt ?? (p as any).updated_at),
    };
}

function platform_detail_dto(p: OttPlatform) {
    return {
        id: p.id,
        user_id: (p as any).user_id ?? null,
        name: p.name,
        description: p.description ?? null,
        base_url: p.base_url,
        cookie_file_name: p.cookie_file_name ?? null,
        favicon_url: (p as any).favicon_url ?? null,
        headers: p.headers ?? {},
        status: p.status,
        lastSyncedAt: timestamp_dto((p as any).last_synced_at),
        createdAt: timestamp_dto((p as any).createdAt ?? (p as any).created_at),
        updatedAt: timestamp_dto((p as any).updatedAt ?? (p as any).updated_at),
    };
}

export async function get_all_ott_platforms(req: FastifyRequest) {
    // user_id comes from the authenticate middleware (req.userId). Filtering
    // here is the primary user-isolation gate for the OTT list endpoint.
    const user_id = (req as any).userId;
    const platforms = await OttPlatform.findAll({
        where: { user_id } as any,
        order: [["createdAt", "DESC"]],
    });

    const ids = platforms.map((p) => p.id);
    const [api_counts, field_counts, latest_responses] = await Promise.all([
        ids.length
            ? OttApiNode.findAll({
                where: { ott_id: ids } as any,
                attributes: ["ott_id"],
                raw: true,
            })
            : Promise.resolve([] as any[]),
        ids.length
            ? OttSelectedField.findAll({
                where: { ott_id: ids, is_visible: true } as any,
                attributes: ["ott_id", "api_node_id"],
                raw: true,
            })
            : Promise.resolve([] as any[]),
        ids.length
            ? OttApiResponse.findAll({
                where: { ott_id: ids } as any,
                attributes: ["ott_id", "updatedAt"],
                raw: true,
            })
            : Promise.resolve([] as any[]),
    ]);

    const api_count_by_ott = new Map<string, number>();
    for (const row of api_counts as any[]) {
        api_count_by_ott.set(row.ott_id, (api_count_by_ott.get(row.ott_id) ?? 0) + 1);
    }

    const sections_by_ott = new Map<string, Set<string>>();
    for (const row of field_counts as any[]) {
        if (!sections_by_ott.has(row.ott_id)) sections_by_ott.set(row.ott_id, new Set());
        sections_by_ott.get(row.ott_id)!.add(row.api_node_id);
    }

    const latest_by_ott = new Map<string, Date>();
    for (const row of latest_responses as any[]) {
        const t = row.updatedAt ? new Date(row.updatedAt) : null;
        if (!t) continue;
        const cur = latest_by_ott.get(row.ott_id);
        if (!cur || cur < t) latest_by_ott.set(row.ott_id, t);
    }

    const data = platforms.map((p) => {
        const explicit = (p as any).last_synced_at as Date | null | undefined;
        const inferred = latest_by_ott.get(p.id);
        const last_synced = explicit ?? inferred ?? null;
        return {
            ...platform_summary_dto(p, {
                total_apis: api_count_by_ott.get(p.id) ?? 0,
                total_selected_sections: sections_by_ott.get(p.id)?.size ?? 0,
            }),
            lastSyncedAt: timestamp_dto(last_synced),
        };
    });

    return success("otts fetched successfully", data);
}

export async function create_ott_platform(req: FastifyRequest) {
    const body = req.body as CreateOttInput;
    const user_id = (req as any).userId;
    const cookie_string = body.cookie_string
        ? normalize_cookie_input(body.cookie_string)
        : body.cookie_raw_content
            ? normalize_cookie_input(body.cookie_raw_content)
            : null;

    // Uniqueness is now per-user — two different users can each have an OTT
    // named "Kuku TV" without collision.
    const exists = await OttPlatform.findOne({ where: { name: body.name, user_id } as any });
    if (exists) return error(HttpStatus.CONFLICT, "An OTT with this name already exists", "name");

    const created = await OttPlatform.create({
        user_id,
        name: body.name,
        description: body.description ?? null,
        base_url: body.base_url,
        cookie_file_name: body.cookie_file_name ?? null,
        cookie_raw_content: body.cookie_raw_content ?? null,
        cookie_string,
        headers: body.headers ?? {},
        favicon_url: body.favicon_url ?? null,
        status: "active",
    } as any);

    return success("ott created successfully", platform_detail_dto(created), HttpStatus.CREATED);
}

export async function get_ott_by_id(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const user_id = (req as any).userId;
    // findOne with user_id scoped — anyone hitting another user's OTT id sees
    // the same "OTT not found" response, which doubles as ownership protection
    // (no info leak about whether the id exists for someone else).
    const platform = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    if (!platform) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const [api_nodes, fields] = await Promise.all([
        OttApiNode.findAll({ where: { ott_id } as any, order: [["sort_order", "ASC"], ["createdAt", "ASC"]] }),
        OttSelectedField.findAll({ where: { ott_id } as any, order: [["sort_order", "ASC"]] }),
    ]);

    const responses = await OttApiResponse.findAll({ where: { ott_id } as any });
    const responses_by_node = new Map<string, OttApiResponse>();
    for (const r of responses) responses_by_node.set(r.api_node_id!, r);

    const fields_by_node = new Map<string, OttSelectedField[]>();
    for (const f of fields) {
        if (!fields_by_node.has(f.api_node_id!)) fields_by_node.set(f.api_node_id!, []);
        fields_by_node.get(f.api_node_id!)!.push(f);
    }

    const node_dto = (n: OttApiNode): any => {
        const latest = responses_by_node.get(n.id);
        const node_fields = (fields_by_node.get(n.id) || []).map((f) => ({
            id: f.id,
            ott_id: f.ott_id,
            api_node_id: f.api_node_id,
            path: f.path,
            label: f.label ?? null,
            display_type: f.display_type,
            sort_order: f.sort_order,
            is_visible: f.is_visible,
            createdAt: timestamp_dto((f as any).createdAt),
            updatedAt: timestamp_dto((f as any).updatedAt),
        }));
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
            // Card config fields — also missing from this duplicate DTO. Without
            // them, OttManagePage falls back to defaults and various cards-tab
            // features (quick_run, default child API, open_type) misbehave.
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
            // Pagination fields — without these the frontend's Cards tab can't
            // see pagination_enabled and the Prev/Next buttons stay hidden.
            pagination_enabled: n.pagination_enabled ?? false,
            pagination_type: n.pagination_type ?? null,
            pagination_config: n.pagination_config ?? {},
            // Body builder fields — same parity rule as pagination (the API
            // form modal uses these to render the body section on edit).
            body_mode: n.body_mode ?? null,
            request_body_config: n.request_body_config ?? [],
            selected_fields: node_fields,
            latest_response_summary: latest
                ? {
                    http_status: latest.http_status ?? null,
                    duration_ms: latest.duration_ms ?? null,
                    response_preview: latest.response_preview ?? null,
                    updatedAt: timestamp_dto((latest as any).updatedAt),
                }
                : null,
            children: [] as any[],
            lastCalledAt: timestamp_dto(n.last_called_at),
            lastSyncedAt: timestamp_dto(n.last_synced_at),
            createdAt: timestamp_dto((n as any).createdAt),
            updatedAt: timestamp_dto((n as any).updatedAt),
        };
    };

    const node_map = new Map<string, ReturnType<typeof node_dto>>();
    api_nodes.forEach((n) => node_map.set(n.id, node_dto(n)));
    const tree: any[] = [];
    for (const n of api_nodes) {
        const dto = node_map.get(n.id)!;
        if (n.parent_id && node_map.has(n.parent_id)) {
            node_map.get(n.parent_id)!.children.push(dto);
        } else {
            tree.push(dto);
        }
    }

    return success("ott fetched successfully", {
        ...platform_detail_dto(platform),
        api_tree: tree,
    });
}

export async function update_ott_platform(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const body = req.body as UpdateOttInput;
    const user_id = (req as any).userId;

    const platform = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    if (!platform) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const patch: Record<string, any> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.base_url !== undefined) patch.base_url = body.base_url;
    if (body.cookie_file_name !== undefined) patch.cookie_file_name = body.cookie_file_name;
    if (body.headers !== undefined) patch.headers = body.headers;
    if (body.favicon_url !== undefined) patch.favicon_url = body.favicon_url;
    if (body.status !== undefined) patch.status = body.status;

    if (body.cookie_raw_content !== undefined) {
        patch.cookie_raw_content = body.cookie_raw_content;
        if (body.cookie_string === undefined) {
            patch.cookie_string = body.cookie_raw_content
                ? normalize_cookie_input(body.cookie_raw_content)
                : null;
        }
    }
    if (body.cookie_string !== undefined) {
        patch.cookie_string = body.cookie_string ? normalize_cookie_input(body.cookie_string) : null;
    }

    await platform.update(patch);
    const fresh = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    return success("ott updated successfully", platform_detail_dto(fresh!));
}

export async function delete_ott_platform(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };
    const user_id = (req as any).userId;
    const platform = await OttPlatform.findOne({ where: { id: ott_id, user_id } as any });
    if (!platform) return error(HttpStatus.NOT_FOUND, "OTT not found");
    await platform.destroy();
    return success("ott deleted successfully", { id: ott_id });
}
