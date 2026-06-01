/**
 * Per-API pagination orchestrator.
 *
 * Phase 1 supports `page_number` only — the most common case (e.g. ?page_no=1&limit=20
 * with hasNext flag in the response). The architecture here generalises so cursor / id
 * / offset can plug in via {@link compute_initial_state} + {@link compute_next_state}
 * without restructuring the loop.
 *
 * Stops on (in priority order):
 *   1. API error (non-2xx) — no retry, surfaces immediately.
 *   2. Empty list (when `stop_when_empty` is true, default true).
 *   3. has_next path is explicitly false.
 *   4. current_page >= total_pages.
 *   5. duplicate next-state (cursor/id repeats — guards against infinite loops).
 *   6. max_pages safety cap (default 50, hard cap 500 from the DTO).
 */

import { OttPlatform, OttApiNode } from "../../db/models";
import { call_external_ott_api, type ExternalCallResult } from "../../utils/ott_proxy";
import { get_value_by_path } from "../../utils/response_path_utils";
import type { PaginationConfig, PaginationType } from "./ott_api.dto";

export type StopReason =
    | "max_pages_reached"
    | "api_error"
    | "empty_list"
    | "next_cursor_missing"
    | "duplicate_cursor"
    | "next_id_missing"
    | "duplicate_id"
    | "has_next_false"
    | "total_pages_reached"
    | "total_count_reached"
    | "config_invalid"
    | "unsupported_type";

export interface PageLogEntry {
    page_number: number | null;
    cursor_value: string | null;
    id_value: string | null;
    offset_value: number | null;
    request_url: string;
    http_status: number | null;
    item_count: number;
    duration_ms: number;
    status: "success" | "failed";
    error_message: string | null;
    log_id: string;
    /** "available" when the OTT row has a cookie_string the call_external proxy
     *  attached; "missing" otherwise. Reads from the same source (ott.cookie_string)
     *  as the proxy, so it accurately reflects what was sent. */
    cookie_status: "available" | "missing";
    cookie_length: number;
}

export interface PaginationRunResult {
    /** Merged response with the data list combined across pages. */
    merged_response: any;
    /** Pages successfully fetched (excludes the failed final attempt, if any). */
    pages_fetched: number;
    total_items: number;
    stop_reason: StopReason;
    pages: PageLogEntry[];
    /** Last-call HTTP status — failures bubble up here. */
    last_http_status: number | null;
    last_error: string | null;
    final_success: boolean;
}

const DEFAULT_MAX_PAGES = 50;

/** Generic "current pagination cursor" — shape varies by type, but the loop is uniform. */
interface PaginationState {
    page_number: number | null;
    cursor: string | null;
    id_value: string | null;
    offset: number | null;
}

interface PaginationStrategy {
    initial_state(config: PaginationConfig): PaginationState;
    /** Apply the current state to the endpoint (adds/replaces query params). */
    apply_to_endpoint(endpoint: string, state: PaginationState, config: PaginationConfig): string;
    /** Decide what the next state should be given the response. Return null to stop. */
    compute_next_state(args: {
        response: any;
        state: PaginationState;
        config: PaginationConfig;
        item_count: number;
    }): { next: PaginationState | null; stop_reason: StopReason | null };
}

const PAGE_NUMBER_STRATEGY: PaginationStrategy = {
    initial_state(config) {
        return {
            page_number: config.start_page ?? 1,
            cursor: null,
            id_value: null,
            offset: null,
        };
    },
    apply_to_endpoint(endpoint, state, config) {
        const page_param = config.page_param ?? "page";
        const params: Record<string, string> = {
            [page_param]: String(state.page_number ?? 1),
        };
        if (config.limit_param && config.limit_value !== undefined) {
            params[config.limit_param] = String(config.limit_value);
        }
        return upsert_query_params(endpoint, params);
    },
    compute_next_state({ response, state, config, item_count }) {
        // Empty list always stops (unless explicitly disabled).
        const stop_when_empty = config.stop_when_empty !== false;
        if (stop_when_empty && item_count === 0) {
            return { next: null, stop_reason: "empty_list" };
        }
        // has_next_path explicitly false → stop.
        if (config.has_next_path) {
            const has_next = get_value_by_path(response, config.has_next_path);
            if (has_next === false) return { next: null, stop_reason: "has_next_false" };
        }
        // total_pages reached → stop.
        if (config.total_pages_path) {
            const total_pages = Number(get_value_by_path(response, config.total_pages_path));
            if (Number.isFinite(total_pages) && (state.page_number ?? 1) >= total_pages) {
                return { next: null, stop_reason: "total_pages_reached" };
            }
        }
        const next_page = (state.page_number ?? 1) + 1;
        return {
            next: { ...state, page_number: next_page },
            stop_reason: null,
        };
    },
};

const CURSOR_STRATEGY: PaginationStrategy = {
    initial_state(config) {
        const initial = config.initial_cursor ?? "";
        return {
            page_number: 1,
            cursor: initial.length > 0 ? initial : null,
            id_value: null,
            offset: null,
        };
    },
    apply_to_endpoint(endpoint, state, config) {
        const cursor_param = config.cursor_param ?? "cursor";
        const params: Record<string, string> = {};
        // First request: only attach the param if there's an initial cursor — many APIs
        // 400 on `cursor=` with an empty string. Subsequent requests always have a value.
        if (state.cursor !== null) params[cursor_param] = state.cursor;
        if (config.limit_param && config.limit_value !== undefined) {
            params[config.limit_param] = String(config.limit_value);
        }
        return Object.keys(params).length > 0 ? upsert_query_params(endpoint, params) : endpoint;
    },
    compute_next_state({ response, state, config, item_count }) {
        const stop_when_empty = config.stop_when_empty !== false;
        if (stop_when_empty && item_count === 0) {
            return { next: null, stop_reason: "empty_list" };
        }
        if (!config.next_cursor_path) {
            return { next: null, stop_reason: "config_invalid" };
        }
        const raw = get_value_by_path(response, config.next_cursor_path);
        if (raw === undefined || raw === null || raw === "" || raw === false) {
            return { next: null, stop_reason: "next_cursor_missing" };
        }
        const next_cursor = String(raw);
        if (next_cursor === state.cursor) {
            return { next: null, stop_reason: "duplicate_cursor" };
        }
        return {
            next: { ...state, cursor: next_cursor, page_number: (state.page_number ?? 1) + 1 },
            stop_reason: null,
        };
    },
};

const ID_BASED_STRATEGY: PaginationStrategy = {
    initial_state(config) {
        const initial = config.initial_id ?? "";
        return {
            page_number: 1,
            cursor: null,
            id_value: initial.length > 0 ? initial : null,
            offset: null,
        };
    },
    apply_to_endpoint(endpoint, state, config) {
        const id_param = config.id_param ?? "last_id";
        const params: Record<string, string> = {};
        if (state.id_value !== null) params[id_param] = state.id_value;
        if (config.limit_param && config.limit_value !== undefined) {
            params[config.limit_param] = String(config.limit_value);
        }
        return Object.keys(params).length > 0 ? upsert_query_params(endpoint, params) : endpoint;
    },
    compute_next_state({ response, state, config, item_count }) {
        const stop_when_empty = config.stop_when_empty !== false;
        if (stop_when_empty && item_count === 0) {
            return { next: null, stop_reason: "empty_list" };
        }
        // has_next short-circuit (some APIs combine ID-based with a flag).
        if (config.has_next_path) {
            const has_next = get_value_by_path(response, config.has_next_path);
            if (has_next === false) return { next: null, stop_reason: "has_next_false" };
        }

        // Two ways to derive the next id:
        //   (a) `next_id_from_last_item: true` + `next_id_field: "id"` → list[last][id]
        //   (b) explicit `next_id_path` → get_value_by_path(response, path)
        // (a) is the simpler UI option and avoids special-casing `[length-1]` syntax.
        let next_raw: any = undefined;
        if (config.next_id_from_last_item) {
            const list = extract_data_list(response, config.data_list_path);
            const last = list[list.length - 1];
            const field = config.next_id_field ?? "id";
            if (last !== undefined && last !== null && typeof last === "object") {
                next_raw = (last as any)[field];
            }
        } else if (config.next_id_path) {
            next_raw = get_value_by_path(response, config.next_id_path);
        } else {
            return { next: null, stop_reason: "config_invalid" };
        }

        if (next_raw === undefined || next_raw === null || next_raw === "") {
            return { next: null, stop_reason: "next_id_missing" };
        }
        const next_id = String(next_raw);
        if (next_id === state.id_value) {
            return { next: null, stop_reason: "duplicate_id" };
        }
        return {
            next: { ...state, id_value: next_id, page_number: (state.page_number ?? 1) + 1 },
            stop_reason: null,
        };
    },
};

const OFFSET_STRATEGY: PaginationStrategy = {
    initial_state(config) {
        return {
            page_number: 1,
            cursor: null,
            id_value: null,
            offset: config.start_offset ?? 0,
        };
    },
    apply_to_endpoint(endpoint, state, config) {
        const offset_param = config.offset_param ?? "offset";
        const params: Record<string, string> = {
            [offset_param]: String(state.offset ?? 0),
        };
        if (config.limit_param && config.limit_value !== undefined) {
            params[config.limit_param] = String(config.limit_value);
        }
        return upsert_query_params(endpoint, params);
    },
    compute_next_state({ response, state, config, item_count }) {
        const stop_when_empty = config.stop_when_empty !== false;
        if (stop_when_empty && item_count === 0) {
            return { next: null, stop_reason: "empty_list" };
        }
        const limit = config.limit_value ?? item_count;
        // No limit configured AND no items returned → can't advance safely. Stop.
        if (!limit) {
            return { next: null, stop_reason: "empty_list" };
        }
        const next_offset = (state.offset ?? 0) + limit;
        // Total-count gate: if response has a total, stop once we've passed it.
        if (config.total_path) {
            const total = Number(get_value_by_path(response, config.total_path));
            if (Number.isFinite(total) && next_offset >= total) {
                return { next: null, stop_reason: "total_count_reached" };
            }
        }
        return {
            next: { ...state, offset: next_offset, page_number: (state.page_number ?? 1) + 1 },
            stop_reason: null,
        };
    },
};

function get_strategy(type: PaginationType): PaginationStrategy | null {
    if (type === "page_number") return PAGE_NUMBER_STRATEGY;
    if (type === "cursor") return CURSOR_STRATEGY;
    if (type === "id_based") return ID_BASED_STRATEGY;
    if (type === "offset") return OFFSET_STRATEGY;
    // "custom" deliberately falls through — Phase 4+ scope.
    return null;
}

/**
 * Build the URL for a SINGLE page given an explicit state. Used by the
 * Prev/Next buttons in the card view to navigate one page at a time without
 * looping. Returns null if the type doesn't have a strategy.
 */
export function build_single_page_url(args: {
    base_endpoint: string;
    pagination_type: PaginationType;
    pagination_config: PaginationConfig;
    page_number?: number | null;
    cursor_value?: string | null;
    id_value?: string | null;
    offset_value?: number | null;
}): string | null {
    const strategy = get_strategy(args.pagination_type);
    if (!strategy) return null;
    const initial = strategy.initial_state(args.pagination_config);
    const state: PaginationState = {
        page_number: args.page_number ?? initial.page_number,
        cursor: args.cursor_value ?? initial.cursor,
        id_value: args.id_value ?? initial.id_value,
        offset: args.offset_value ?? initial.offset,
    };
    return strategy.apply_to_endpoint(args.base_endpoint, state, args.pagination_config);
}

/**
 * Inspect a single-page response and report what the next state would be —
 * lets the frontend disable the "Next" button when no more pages exist.
 * Returns the next state's identifying value plus `has_next: false` when
 * any stop condition fired.
 */
export function inspect_pagination_next_state(args: {
    response: any;
    pagination_type: PaginationType;
    pagination_config: PaginationConfig;
    current_page_number?: number | null;
    current_cursor?: string | null;
    current_id?: string | null;
    current_offset?: number | null;
}): {
    has_next: boolean;
    next_page_number: number | null;
    next_cursor: string | null;
    next_id: string | null;
    next_offset: number | null;
    item_count: number;
    stop_reason: StopReason | null;
    total_pages: number | null;
    total_items: number | null;
} {
    const strategy = get_strategy(args.pagination_type);
    const items = extract_data_list(args.response, args.pagination_config.data_list_path);
    // If the response carries a total-pages / total-items count at a known
    // path, surface it so the UI can render "page 1 of N" and validate jumps.
    const total_pages = (() => {
        const p = args.pagination_config.total_pages_path;
        if (!p) return null;
        const v = Number(get_value_by_path(args.response, p));
        return Number.isFinite(v) ? v : null;
    })();
    const total_items = (() => {
        const p = (args.pagination_config as any).total_count_path as string | undefined;
        if (!p) return null;
        const v = Number(get_value_by_path(args.response, p));
        return Number.isFinite(v) ? v : null;
    })();
    const empty: ReturnType<typeof inspect_pagination_next_state> = {
        has_next: false,
        next_page_number: null,
        next_cursor: null,
        next_id: null,
        next_offset: null,
        item_count: items.length,
        stop_reason: "unsupported_type",
        total_pages,
        total_items,
    };
    if (!strategy) return empty;
    const state: PaginationState = {
        page_number: args.current_page_number ?? null,
        cursor: args.current_cursor ?? null,
        id_value: args.current_id ?? null,
        offset: args.current_offset ?? null,
    };
    const decision = strategy.compute_next_state({
        response: args.response,
        state,
        config: args.pagination_config,
        item_count: items.length,
    });
    if (decision.next === null) {
        return { ...empty, stop_reason: decision.stop_reason };
    }
    return {
        has_next: true,
        next_page_number: decision.next.page_number,
        next_cursor: decision.next.cursor,
        next_id: decision.next.id_value,
        next_offset: decision.next.offset,
        item_count: items.length,
        stop_reason: null,
        total_pages,
        total_items,
    };
}

/**
 * Add or replace query params on an endpoint string. Endpoint may already include
 * a query (e.g. `/shows?lang=hindi`) — we preserve the rest and overwrite only
 * the keys we own. Endpoints without `?` get one appended. Bare hash fragments
 * are preserved.
 */
export function upsert_query_params(endpoint: string, params: Record<string, string>): string {
    if (!endpoint) return endpoint;
    const hash_idx = endpoint.indexOf("#");
    const fragment = hash_idx >= 0 ? endpoint.slice(hash_idx) : "";
    const without_fragment = hash_idx >= 0 ? endpoint.slice(0, hash_idx) : endpoint;

    const q_idx = without_fragment.indexOf("?");
    const path = q_idx >= 0 ? without_fragment.slice(0, q_idx) : without_fragment;
    const query_string = q_idx >= 0 ? without_fragment.slice(q_idx + 1) : "";

    const search = new URLSearchParams(query_string);
    for (const [k, v] of Object.entries(params)) {
        search.set(k, v);
    }
    const next_query = search.toString();
    return next_query ? `${path}?${next_query}${fragment}` : `${path}${fragment}`;
}

/** Read the current page's items array out of `data_list_path` (or the root). */
export function extract_data_list(response: any, data_list_path: string | undefined): any[] {
    if (response === null || response === undefined) return [];
    const root = data_list_path ? get_value_by_path(response, data_list_path) : response;
    if (Array.isArray(root)) return root;
    return [];
}

/** Build a stable string key for a state so we can detect duplicate-state loops. */
function state_signature(state: PaginationState): string {
    return [state.page_number ?? "_", state.cursor ?? "_", state.id_value ?? "_", state.offset ?? "_"].join("|");
}

interface RunArgs {
    ott: OttPlatform;
    api_node: OttApiNode;
    base_endpoint: string;
    request_body: any;
    pagination_type: PaginationType;
    pagination_config: PaginationConfig;
    /** Hard cap on pages for one-off test runs (overrides config.max_pages). */
    pages_cap_override?: number;
    /** Extra fields forwarded to the call logger (parent api id / name / etc.). */
    call_extras?: {
        dynamic_params_used?: Record<string, any>;
        card_index?: number | null | undefined;
        item_key?: string | null | undefined;
        parent_api_id?: string | null | undefined;
        parent_api_name?: string | null | undefined;
        child_api_id?: string | null | undefined;
    };
}

export async function run_paginated_call(args: RunArgs): Promise<PaginationRunResult> {
    const { ott, api_node, base_endpoint, request_body, pagination_type, pagination_config, pages_cap_override, call_extras = {} } = args;

    const strategy = get_strategy(pagination_type);
    if (!strategy) {
        return {
            merged_response: null,
            pages_fetched: 0,
            total_items: 0,
            stop_reason: "unsupported_type",
            pages: [],
            last_http_status: null,
            last_error: `pagination_type "${pagination_type}" is not implemented yet`,
            final_success: false,
        };
    }

    // Defensive: warn loud and stop early if data_list_path isn't configured.
    // Without it the loop reads `[]` from every response, hits `stop_when_empty`,
    // and exits after page 1 — looking like "pagination is broken" when it's
    // really a config issue. Same for missing pagination_config entirely.
    const data_list_path = pagination_config.data_list_path;
    if (!data_list_path) {
        return {
            merged_response: null,
            pages_fetched: 0,
            total_items: 0,
            stop_reason: "config_invalid",
            pages: [],
            last_http_status: null,
            last_error: "data_list_path is required — set it to the response field that holds the items array (e.g. \"data\", \"shows\", \"result.items\").",
            final_success: false,
        };
    }

    // Cookie status is computed once — cookies don't change per page since the
    // proxy reads them off the same OTT row on every call.
    const cookie_string = String(ott.cookie_string ?? "");
    const cookie_status: "available" | "missing" = cookie_string.length > 0 ? "available" : "missing";
    const cookie_length = cookie_string.length;

    const max_pages = pages_cap_override ?? pagination_config.max_pages ?? DEFAULT_MAX_PAGES;

    let state: PaginationState | null = strategy.initial_state(pagination_config);
    const seen_states = new Set<string>();
    const pages: PageLogEntry[] = [];
    const merged_items: any[] = [];
    let last_response: any = null;
    let last_http_status: number | null = null;
    let last_error: string | null = null;
    let stop_reason: StopReason = "max_pages_reached";

    while (state !== null) {
        if (pages.length >= max_pages) {
            stop_reason = "max_pages_reached";
            break;
        }
        const sig = state_signature(state);
        if (seen_states.has(sig)) {
            stop_reason = pagination_type === "cursor" ? "duplicate_cursor" : "duplicate_id";
            break;
        }
        seen_states.add(sig);

        const resolved_endpoint = strategy.apply_to_endpoint(base_endpoint, state, pagination_config);
        const result: ExternalCallResult = await call_external_ott_api({
            ott,
            api_node,
            resolved_endpoint,
            request_body,
            ...call_extras,
        });
        last_http_status = result.status;
        last_error = result.error_message ?? null;
        const items = result.success ? extract_data_list(result.data, data_list_path) : [];

        pages.push({
            page_number: state.page_number,
            cursor_value: state.cursor,
            id_value: state.id_value,
            offset_value: state.offset,
            request_url: result.request_url,
            http_status: result.status,
            item_count: items.length,
            duration_ms: result.duration_ms,
            status: result.success ? "success" : "failed",
            error_message: result.error_message ?? null,
            log_id: result.log_id,
            cookie_status,
            cookie_length,
        });
        // Visible in backend terminal so you can verify pagination + cookies
        // each call without opening Debug Console.
        console.log(
            `[pagination] ${pagination_type} page ${state.page_number ?? "—"} ` +
            `→ HTTP ${result.status} · ${items.length} items · ${result.duration_ms}ms · ` +
            `cookies:${cookie_status}${cookie_length ? `(${cookie_length}ch)` : ""}`,
        );

        if (!result.success) {
            stop_reason = "api_error";
            break;
        }

        last_response = result.data;
        merged_items.push(...items);

        const next = strategy.compute_next_state({
            response: result.data,
            state,
            config: pagination_config,
            item_count: items.length,
        });
        if (next.next === null) {
            stop_reason = next.stop_reason ?? "max_pages_reached";
            break;
        }
        state = next.next;
    }

    const merged = build_merged_response({
        last_response,
        merged_items,
        data_list_path,
        pagination_type,
        pages_fetched: pages.filter(p => p.status === "success").length,
        total_items: merged_items.length,
        stop_reason,
    });

    const successful_pages = pages.filter(p => p.status === "success").length;
    return {
        merged_response: merged,
        pages_fetched: successful_pages,
        total_items: merged_items.length,
        stop_reason,
        pages,
        last_http_status,
        last_error,
        final_success: pages.length > 0 && pages[pages.length - 1]!.status === "success",
    };
}

/**
 * Compose a merged response by overwriting the `data_list_path` with combined items.
 * Keeps the rest of the last page's response intact (so `pagination`/`meta` keys stay
 * available for downstream features) and stamps `pagination_meta`.
 */
function build_merged_response(args: {
    last_response: any;
    merged_items: any[];
    data_list_path: string | undefined;
    pagination_type: PaginationType;
    pages_fetched: number;
    total_items: number;
    stop_reason: StopReason;
}): any {
    const meta = {
        pagination_enabled: true,
        pagination_type: args.pagination_type,
        pages_fetched: args.pages_fetched,
        total_items: args.total_items,
        stop_reason: args.stop_reason,
    };

    if (args.last_response === null || args.last_response === undefined) {
        return {
            ...(args.data_list_path ? { [args.data_list_path]: args.merged_items } : { data: args.merged_items }),
            pagination_meta: meta,
        };
    }

    if (!args.data_list_path) {
        // No data_list_path → either the response itself was the array (rare) or the
        // user didn't configure it. Prefer to return the original response with the
        // merged array under `data` plus metadata.
        if (Array.isArray(args.last_response)) {
            return { data: args.merged_items, pagination_meta: meta };
        }
        return { ...args.last_response, pagination_meta: meta };
    }

    const cloned = clone_with_path_overwrite(args.last_response, args.data_list_path, args.merged_items);
    if (cloned && typeof cloned === "object" && !Array.isArray(cloned)) {
        (cloned as any).pagination_meta = meta;
        return cloned;
    }
    return { data: args.merged_items, pagination_meta: meta };
}

/**
 * Walk down `path` and replace the value at the end with `replacement`. Returns
 * a new top-level object — intermediate nodes along the path are also cloned so
 * mutating the returned tree doesn't affect the original. Anything off-path is
 * shared by reference (avoids deep-cloning huge responses).
 */
function clone_with_path_overwrite(root: any, path: string, replacement: any): any {
    const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
    if (parts.length === 0) return replacement;
    const out = root && typeof root === "object" ? (Array.isArray(root) ? [...root] : { ...root }) : {};
    let cursor: any = out;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i]!;
        const existing = cursor[key];
        const next = existing && typeof existing === "object" ? (Array.isArray(existing) ? [...existing] : { ...existing }) : {};
        cursor[key] = next;
        cursor = next;
    }
    cursor[parts[parts.length - 1]!] = replacement;
    return out;
}
