/**
 * Quick Flow — visualisation aggregator.
 *
 * Builds a flow-chart-friendly view of an OTT's API tree by joining together
 * the existing tables (api_nodes, api_responses, child_api_item_responses,
 * selected_fields, card_actions). Read-only: this endpoint never mutates,
 * it just stitches everything the front-end needs into one response so the
 * Quick Flow page renders without 6 separate fetches.
 *
 * Key derived data per node:
 *   - level         : depth from the root, used by the front-end auto-layout
 *   - api           : full api_node row (already covers pagination + body fields)
 *   - selected_fields : card field config
 *   - card_actions  : action buttons configured on this api's cards
 *   - last_log      : most recent OttApiLog (status, http_status, called_at)
 *   - sample_data   : a small slice of the saved response so the panel can
 *                     show example data without re-fetching the response
 *
 * Each parent → child relationship becomes an edge with the param_mappings
 * + body_mappings + a sample-resolved endpoint preview using card_index 0
 * of the parent's saved response.
 */

import type { FastifyRequest } from "fastify";
import { Op } from "sequelize";
import {
    OttPlatform,
    OttApiNode,
    OttApiResponse,
    OttSelectedField,
    OttApiLog,
    OttCardAction,
    OttVideoAsset,
    OttLibraryItem,
} from "../../db/models";
import { success, error } from "../../shared/http/response";
import { HttpStatus } from "../../shared/http/status";
import {
    extract_endpoint_variables,
    resolve_endpoint_variables,
    get_value_by_path,
    replace_array_index_in_path,
} from "../../utils/response_path_utils";
import { resolve_request_body } from "../ott_api/ott_api_body.service";

function ts(value: any): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Resolved values for the first card the parent's response would render —
 *  feeds the inline mockup the front-end draws inside an API node. */
interface CardPreview {
    image_url: string | null;
    title: string | null;
    subtitle: string | null;
    badge: string | null;
    /** Up to 4 secondary key/value pairs from selected_fields beyond the
     *  ones already used for image/title/subtitle/badge. */
    extra_fields: Array<{ label: string; value: string }>;
}

interface ApiFlowNode {
    id: string;
    type: "api_node";
    level: number;
    api: {
        id: string;
        name: string | undefined;
        method: string | undefined;
        endpoint: string | undefined;
        parent_id: string | null;
        status: string | undefined;
        last_http_status: number | null;
        pagination_enabled: boolean;
        pagination_type: string | null;
        pagination_config: Record<string, any>;
        card_enabled: boolean;
        quick_run: boolean;
        list_path: string | null;
        body_mode: string | null;
        request_body_config: any[];
        default_child_api_id: string | null;
        default_card_action_id: string | null;
        open_type: string;
        last_called_at: string | null;
    };
    selected_fields: Array<{
        path: string;
        label: string | null;
        display_type: string;
    }>;
    card_actions: Array<{
        id: string;
        label: string;
        action_type: string;
        child_api_id: string | null;
        open_type: string | null;
    }>;
    last_log: {
        log_id: string;
        status: string;
        http_status: number | null;
        duration_ms: number | null;
        called_at: string | null;
        error_message: string | null;
    } | null;
    sample_data: {
        response_preview: string | null;
        list_path_first_item: any;
        keys: string[];
    };
    /** Mocked-up first-card preview. Null when the API has no cards or no
     *  saved response to draw from. */
    card_preview: CardPreview | null;
}

interface OttRootFlowNode {
    id: string;
    type: "ott_root";
    level: number;
    ott: { id: string; name: string; base_url: string; favicon_url: string | null };
    summary: { root_apis: number; total_apis: number };
}

interface CaptureVideoFlowNode {
    id: string;
    type: "capture_video";
    level: number;
    captured_videos: number;
    /** Which API node ids actually produced captured videos. */
    source_api_ids: string[];
    /** Tally of the `video_type` column across the user's captured assets. */
    types: Record<string, number>;
}

interface LibraryFlowNode {
    id: string;
    type: "library";
    level: number;
    counts: {
        total: number;
        completed: number;
        failed: number;
        videos: number;
        images: number;
        thumbnails: number;
        playlists: number;
    };
}

type FlowNode = ApiFlowNode | OttRootFlowNode | CaptureVideoFlowNode | LibraryFlowNode;

type EdgeKind =
    | "api_connection"   // parent api → child api
    | "ott_to_root"      // synthetic OTT node → root API
    | "api_to_capture"   // API node → capture_video synthetic node
    | "capture_to_library"; // capture_video → library synthetic node

interface FlowEdge {
    id: string;
    source: string;
    target: string;
    type: EdgeKind;
    label: string;
    trigger_type: "card_click" | "quick_run" | "card_action" | "manual" | "system";
    open_type: string | null;
    param_mappings: Record<string, string>;
    body_mappings: any[];
    sample_resolved_endpoint: string | null;
    sample_resolved_body: Record<string, any> | null;
    /** Per-variable resolution preview — what the user would actually see on click. */
    resolved_params_preview: Record<string, any>;
}

interface FlowSummary {
    total_apis: number;
    root_apis: number;
    child_apis: number;
    paginated_apis: number;
    card_enabled_apis: number;
    quick_run_apis: number;
    failed_apis: number;
    captured_videos: number;
    library_items: number;
    library_completed: number;
    library_failed: number;
}

function compute_levels(nodes: OttApiNode[]): Map<string, number> {
    const levels = new Map<string, number>();
    const by_id = new Map<string, OttApiNode>();
    for (const n of nodes) by_id.set(n.id, n);
    function level_of(id: string): number {
        if (levels.has(id)) return levels.get(id)!;
        const n = by_id.get(id);
        if (!n || !n.parent_id) {
            levels.set(id, 0);
            return 0;
        }
        const lvl = level_of(n.parent_id) + 1;
        levels.set(id, lvl);
        return lvl;
    }
    for (const n of nodes) level_of(n.id);
    return levels;
}

/** Pull ~5 keys + a short preview from a saved response, so the front-end can
 *  show "what's in here?" without serializing the whole JSON. */
function build_sample_data(response: any, list_path: string | null | undefined): ApiFlowNode["sample_data"] {
    if (!response) return { response_preview: null, list_path_first_item: null, keys: [] };
    const preview = (() => {
        try { return JSON.stringify(response).slice(0, 200); } catch { return null; }
    })();
    const keys = response && typeof response === "object" && !Array.isArray(response)
        ? Object.keys(response).slice(0, 8)
        : [];
    // Pull the first item from the configured list_path so the front-end can
    // render a real card mockup. We resolve the path by replacing the
    // `[i]` template token with `[0]` (first item) — the same convention
    // the rest of the pipeline uses for sample preview.
    let list_path_first_item: any = null;
    if (list_path) {
        try {
            const indexed = replace_array_index_in_path(list_path, 0);
            const v = get_value_by_path(response, indexed);
            if (v !== undefined && v !== null) list_path_first_item = v;
        } catch { /* path resolution is best-effort */ }
    }
    return { response_preview: preview, list_path_first_item, keys };
}

/** Build a card preview by resolving the user's selected_fields against the
 *  first item of the parent's saved response. Returns null when there's
 *  nothing to preview (no response, no list_path, or no fields). */
function build_card_preview(args: {
    list_path_first_item: any;
    selected_fields: OttSelectedField[];
    card_actions: OttCardAction[];
    list_path: string | null | undefined;
}): CardPreview | null {
    const { list_path_first_item, selected_fields } = args;
    if (!list_path_first_item || selected_fields.length === 0) return null;

    const resolve = (field: OttSelectedField): string | null => {
        const path = field.path ?? "";
        // The selected_field path is rooted at the LIST item, so we walk
        // it relative to first_item rather than from the response root.
        // Strip the list_path prefix + leading `.` so e.g.
        // `shows[0].image` becomes just `image` when list_path is `shows[0]`.
        let rel = path;
        if (args.list_path && path.startsWith(args.list_path)) {
            rel = path.slice(args.list_path.length).replace(/^[.[]/, m => m === "[" ? "[" : "");
        }
        rel = rel.replace(/^\.+/, "");
        if (!rel) return null;
        try {
            const v = get_value_by_path(list_path_first_item, rel);
            if (v === undefined || v === null) return null;
            return typeof v === "string" ? v : String(v);
        } catch { return null; }
    };

    let image_url: string | null = null;
    let title: string | null = null;
    let subtitle: string | null = null;
    let badge: string | null = null;
    const used = new Set<string>();
    const extras: Array<{ label: string; value: string }> = [];

    // First pass — pick canonical fields by display_type.
    for (const f of selected_fields) {
        const v = resolve(f);
        if (!v) continue;
        const dt = f.display_type ?? "";
        if (dt === "image" && !image_url) { image_url = v; used.add(f.id); continue; }
        if (dt === "title" && !title) { title = v; used.add(f.id); continue; }
        if (dt === "subtitle" && !subtitle) { subtitle = v; used.add(f.id); continue; }
        if ((dt === "badge" || dt === "tag") && !badge) { badge = v; used.add(f.id); continue; }
    }
    // Second pass — fill remaining canonical slots from any field that
    // resolved, in the order the user configured them. Lets cards with
    // no explicit display_type still preview meaningfully.
    for (const f of selected_fields) {
        if (used.has(f.id)) continue;
        const v = resolve(f);
        if (!v) continue;
        if (!title) { title = v; used.add(f.id); continue; }
        if (!subtitle) { subtitle = v; used.add(f.id); continue; }
        if (extras.length < 4) {
            extras.push({ label: f.label || (f.path ?? "").split(".").pop() || "field", value: v });
            used.add(f.id);
        }
    }

    if (!image_url && !title && !subtitle && extras.length === 0) return null;
    return { image_url, title, subtitle, badge, extra_fields: extras };
}

function build_edge(
    parent: OttApiNode,
    child: OttApiNode,
    parent_response: any,
    actions: OttCardAction[],
): FlowEdge {
    const param_mappings = (child.param_mappings || {}) as Record<string, string>;
    const endpoint_vars = extract_endpoint_variables(child.endpoint || "");

    // Sample-resolve the endpoint using card_index 0 of the parent's saved
    // response so the user sees a realistic preview ("/show/my-show" instead
    // of "/show/<slug>"). Falls back to the unresolved endpoint when the
    // parent has no response yet.
    const dynamic_params: Record<string, any> = {};
    let preview_ok = !!parent_response;
    for (const v of endpoint_vars) {
        const path = param_mappings[v];
        if (!path || !parent_response) { preview_ok = false; continue; }
        const indexed = replace_array_index_in_path(path, 0);
        const value = get_value_by_path(parent_response, indexed);
        if (value === undefined || value === null || value === "") { preview_ok = false; continue; }
        dynamic_params[v] = value;
    }
    const sample_resolved_endpoint = preview_ok && Object.keys(dynamic_params).length > 0
        ? resolve_endpoint_variables(child.endpoint || "", dynamic_params)
        : null;

    // Body preview using the same parent + card_index 0.
    const body_resolution = resolve_request_body({
        body_mode: child.body_mode as any,
        request_body_config: child.request_body_config ?? [],
        raw_body: (child.request_body as Record<string, any> | null) ?? null,
        parent_response,
        card_index: 0,
    });

    // Trigger heuristic: if the parent has card_enabled + quick_run + this is
    // the default child, the connection fires automatically on card click.
    // Otherwise it's a manual / action-driven connection.
    const trigger_type: FlowEdge["trigger_type"] = (() => {
        if (parent.card_enabled && parent.quick_run && parent.default_child_api_id === child.id) return "quick_run";
        const has_action_for_child = actions.some(a =>
            a.api_node_id === parent.id && a.child_api_id === child.id && a.action_type === "call_child_api",
        );
        if (has_action_for_child) return "card_action";
        if (parent.card_enabled) return "card_click";
        return "manual";
    })();

    const label = trigger_type === "quick_run"
        ? "quick run"
        : trigger_type === "card_action"
            ? "card action"
            : trigger_type === "card_click"
                ? "card click"
                : "manual";

    return {
        id: `${parent.id}__${child.id}`,
        source: parent.id,
        target: child.id,
        type: "api_connection",
        label,
        trigger_type,
        open_type: child.open_type ?? null,
        param_mappings,
        body_mappings: child.request_body_config ?? [],
        sample_resolved_endpoint,
        sample_resolved_body: body_resolution.body,
        resolved_params_preview: dynamic_params,
    };
}

export async function get_quick_flow(req: FastifyRequest) {
    const { ott_id } = req.params as { ott_id: string };

    const ott = await OttPlatform.findOne({ where: { id: ott_id, user_id: (req as any).userId } as any });
    if (!ott) return error(HttpStatus.NOT_FOUND, "OTT not found");

    const [nodes, responses, fields, actions, latest_logs] = await Promise.all([
        OttApiNode.findAll({ where: { ott_id } as any, order: [["sort_order", "ASC"], ["createdAt", "ASC"]] }),
        OttApiResponse.findAll({ where: { ott_id } as any }),
        OttSelectedField.findAll({ where: { ott_id } as any, order: [["sort_order", "ASC"]] }),
        OttCardAction.findAll({ where: { ott_id } as any, order: [["sort_order", "ASC"]] }),
        // Cap at 1 latest per api_node — we only need per-node freshness. A
        // window function would be cleaner but Sequelize-level support is iffy;
        // grouping in JS is fine for the tens-of-nodes scale this hits.
        OttApiLog.findAll({
            where: { ott_id } as any,
            order: [["createdAt", "DESC"]],
            limit: 200,
        }),
    ]);

    const responses_by_node = new Map<string, OttApiResponse>();
    for (const r of responses) responses_by_node.set(r.api_node_id!, r);

    const fields_by_node = new Map<string, OttSelectedField[]>();
    for (const f of fields) {
        const arr = fields_by_node.get(f.api_node_id!) ?? [];
        arr.push(f);
        fields_by_node.set(f.api_node_id!, arr);
    }

    const actions_by_parent = new Map<string, OttCardAction[]>();
    for (const a of actions) {
        const arr = actions_by_parent.get(a.api_node_id!) ?? [];
        arr.push(a);
        actions_by_parent.set(a.api_node_id!, arr);
    }

    // First log per node ordered by createdAt DESC — that's the latest.
    const latest_log_by_node = new Map<string, OttApiLog>();
    for (const l of latest_logs) {
        if (!l.api_node_id || latest_log_by_node.has(l.api_node_id)) continue;
        latest_log_by_node.set(l.api_node_id, l);
    }

    const levels = compute_levels(nodes);

    const api_flow_nodes: ApiFlowNode[] = nodes.map(n => {
        const log = latest_log_by_node.get(n.id);
        const node_actions = actions_by_parent.get(n.id) ?? [];
        const node_fields = fields_by_node.get(n.id) ?? [];
        const response = responses_by_node.get(n.id);
        const sample_data = build_sample_data(response?.response, n.list_path);
        const card_preview = n.card_enabled
            ? build_card_preview({
                list_path_first_item: sample_data.list_path_first_item,
                selected_fields: node_fields,
                card_actions: node_actions,
                list_path: n.list_path,
            })
            : null;
        return {
            id: n.id,
            type: "api_node",
            // Shift by +1 to leave room for the synthetic OTT root at level 0.
            level: (levels.get(n.id) ?? 0) + 1,
            api: {
                id: n.id,
                name: n.name,
                method: n.method,
                endpoint: n.endpoint,
                parent_id: n.parent_id ?? null,
                status: n.status,
                last_http_status: n.last_http_status ?? null,
                pagination_enabled: n.pagination_enabled ?? false,
                pagination_type: n.pagination_type ?? null,
                pagination_config: n.pagination_config ?? {},
                card_enabled: n.card_enabled ?? false,
                quick_run: n.quick_run ?? false,
                list_path: n.list_path ?? null,
                body_mode: n.body_mode ?? null,
                request_body_config: n.request_body_config ?? [],
                default_child_api_id: n.default_child_api_id ?? null,
                default_card_action_id: n.default_card_action_id ?? null,
                open_type: n.open_type ?? "inline",
                last_called_at: ts(n.last_called_at),
            },
            selected_fields: node_fields.map(f => ({
                path: f.path!,
                label: f.label ?? null,
                display_type: f.display_type!,
            })),
            card_actions: node_actions.map(a => ({
                id: a.id,
                label: a.label!,
                action_type: a.action_type!,
                child_api_id: a.child_api_id ?? null,
                open_type: a.open_type ?? null,
            })),
            last_log: log ? {
                log_id: log.id,
                status: log.status!,
                http_status: log.http_status ?? null,
                duration_ms: log.duration_ms ?? null,
                called_at: ts((log as any).createdAt),
                error_message: log.error_message ?? null,
            } : null,
            sample_data,
            card_preview,
        };
    });

    const flow_edges: FlowEdge[] = [];
    for (const child of nodes) {
        if (!child.parent_id) continue;
        const parent = nodes.find(n => n.id === child.parent_id);
        if (!parent) continue;
        const parent_response = responses_by_node.get(parent.id)?.response ?? null;
        flow_edges.push(build_edge(parent, child, parent_response, actions));
    }

    // ── Synthetic boundary nodes ─────────────────────────────────────────
    // OTT root sits at level 0 and connects to every root API. Capture
    // video + library sit at the far right, downstream of any API node
    // that produced a captured asset, so the user sees the FULL pipeline
    // from "OTT" to "Library".
    const max_api_level = api_flow_nodes.reduce((acc, n) => Math.max(acc, n.level), 0);

    // Per-API breakdown so the front-end can highlight which APIs feed
    // capture (and so we can build edges from each capture-producing API
    // to the synthetic capture node).
    const captured = await OttVideoAsset.findAll({
        where: { ott_id } as any,
        attributes: ["api_node_id", "video_type"],
        raw: true,
    }) as unknown as Array<{ api_node_id: string | null; video_type: string | null }>;
    const capture_source_ids = new Set<string>();
    const capture_types: Record<string, number> = {};
    for (const c of captured) {
        if (c.api_node_id) capture_source_ids.add(c.api_node_id);
        const t = (c.video_type || "unknown").toLowerCase();
        capture_types[t] = (capture_types[t] || 0) + 1;
    }

    // Post-R2 the status column was dropped. A row counts as completed
    // when it has a `file_url` (R2 upload succeeded); a video row
    // without one is legacy data we surface as failed. Folder
    // placeholders are excluded so they don't inflate the totals.
    const lib_rows = await OttLibraryItem.findAll({
        where: { ott_id, save_type: { [Op.ne]: "folder_placeholder" } } as any,
        attributes: ["file_url", "save_type"],
        raw: true,
    }) as unknown as Array<{ file_url: string | null; save_type: string | null }>;
    const lib_counts = {
        total: lib_rows.length,
        completed: 0,
        failed: 0,
        videos: 0,
        images: 0,
        thumbnails: 0,
        playlists: 0,
    };
    for (const r of lib_rows) {
        if (r.file_url) lib_counts.completed += 1;
        else if (r.save_type === "video") lib_counts.failed += 1;
        if (r.save_type === "video") lib_counts.videos += 1;
        else if (r.save_type === "image") lib_counts.images += 1;
        else if (r.save_type === "thumbnail") lib_counts.thumbnails += 1;
        else if (r.save_type === "playlist") lib_counts.playlists += 1;
    }

    const ott_root_node: OttRootFlowNode = {
        id: `ott:${ott.id}`,
        type: "ott_root",
        level: 0,
        ott: {
            id: ott.id,
            name: ott.name ?? "OTT",
            base_url: ott.base_url ?? "",
            favicon_url: (ott as any).favicon_url ?? null,
        },
        summary: {
            root_apis: nodes.filter(n => !n.parent_id).length,
            total_apis: nodes.length,
        },
    };

    // Edges from OTT root to every root API.
    for (const n of nodes) {
        if (n.parent_id) continue;
        flow_edges.push({
            id: `ott:${ott.id}__${n.id}`,
            source: ott_root_node.id,
            target: n.id,
            type: "ott_to_root",
            label: "root",
            trigger_type: "system",
            open_type: null,
            param_mappings: {},
            body_mappings: [],
            sample_resolved_endpoint: null,
            sample_resolved_body: null,
            resolved_params_preview: {},
        });
    }

    const synthetic_nodes: FlowNode[] = [ott_root_node];

    // Capture-video synthetic node — only when at least one asset exists.
    if (captured.length > 0) {
        const capture_node: CaptureVideoFlowNode = {
            id: `capture:${ott.id}`,
            type: "capture_video",
            level: max_api_level + 1,
            captured_videos: captured.length,
            source_api_ids: Array.from(capture_source_ids),
            types: capture_types,
        };
        synthetic_nodes.push(capture_node);
        for (const src_api_id of capture_source_ids) {
            flow_edges.push({
                id: `${src_api_id}__capture`,
                source: src_api_id,
                target: capture_node.id,
                type: "api_to_capture",
                label: "capture video",
                trigger_type: "system",
                open_type: null,
                param_mappings: {},
                body_mappings: [],
                sample_resolved_endpoint: null,
                sample_resolved_body: null,
                resolved_params_preview: {},
            });
        }
    }

    // Library synthetic node — drawn whether or not items exist (helps the
    // user discover the feature). Edge from capture only if capture also
    // exists, otherwise wired to every API node that has saved a library
    // row directly (rare but possible).
    const has_capture_node = captured.length > 0;
    const library_node: LibraryFlowNode = {
        id: `library:${ott.id}`,
        type: "library",
        level: max_api_level + 2,
        counts: lib_counts,
    };
    synthetic_nodes.push(library_node);
    if (has_capture_node) {
        flow_edges.push({
            id: `capture:${ott.id}__library:${ott.id}`,
            source: `capture:${ott.id}`,
            target: library_node.id,
            type: "capture_to_library",
            label: "save to library",
            trigger_type: "system",
            open_type: null,
            param_mappings: {},
            body_mappings: [],
            sample_resolved_endpoint: null,
            sample_resolved_body: null,
            resolved_params_preview: {},
        });
    }

    const flow_nodes: FlowNode[] = [...synthetic_nodes, ...api_flow_nodes];

    const summary: FlowSummary = {
        total_apis: nodes.length,
        root_apis: nodes.filter(n => !n.parent_id).length,
        child_apis: nodes.filter(n => !!n.parent_id).length,
        paginated_apis: nodes.filter(n => n.pagination_enabled).length,
        card_enabled_apis: nodes.filter(n => n.card_enabled).length,
        quick_run_apis: nodes.filter(n => n.quick_run).length,
        failed_apis: nodes.filter(n => n.status === "failed").length,
        captured_videos: captured.length,
        library_items: lib_counts.total,
        library_completed: lib_counts.completed,
        library_failed: lib_counts.failed,
    };

    return success("quick flow fetched successfully", {
        ott: {
            id: ott.id,
            name: ott.name,
            base_url: ott.base_url,
            description: ott.description,
        },
        nodes: flow_nodes,
        edges: flow_edges,
        summary,
    });
}
