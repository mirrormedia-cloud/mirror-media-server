/**
 * Resolves a request body at call time from the configured `body_mode` and
 * `request_body_config`. Two modes:
 *
 *   - "raw"        → use `request_body` (legacy / pasted JSON) as-is.
 *   - "key_value"  → walk `request_body_config` entries, resolving each one's
 *                    static_value or variable_path against the parent response,
 *                    coercing per `data_type`.
 *
 * Endpoint variables and body variables can both reference the same parent
 * response — they're resolved independently using the same path syntax that
 * call_api_from_card already uses (with `[0]` rewritten to the actual
 * card_index when applicable).
 */

import {
    get_value_by_path,
    replace_array_index_in_path,
} from "../../utils/response_path_utils";
import type { BodyConfigEntry, BodyDataType, BodyMode } from "./ott_api.dto";

export interface ResolveBodyArgs {
    body_mode: BodyMode | null | undefined;
    request_body_config: any[] | null | undefined;
    /** Pasted JSON body (only used when body_mode is "raw" or null). */
    raw_body: Record<string, any> | null | undefined;
    /**
     * Source response variable_path is resolved against. For root APIs this
     * is null/undefined → variable entries that need a path will throw.
     * For child APIs called from a card this is the parent's saved response.
     */
    parent_response?: any;
    /**
     * When provided (child APIs from a card), `[0]` placeholders in the
     * variable_path are rewritten to `[card_index]` so each card's data is
     * picked up. Mirrors how call_api_from_card resolves endpoint variables.
     */
    card_index?: number | null | undefined;
}

export interface ResolveBodyResult {
    /** Final body to send to the upstream API. null when no body should be sent. */
    body: Record<string, any> | null;
    /**
     * Per-entry diagnostic so failures + resolved values are visible in logs.
     * Length matches request_body_config when body_mode is "key_value".
     */
    resolved_entries: Array<{
        key: string;
        value_type: "static" | "variable";
        variable_path?: string;
        resolved_value: any;
        error: string | null;
    }>;
    /** Aggregated error message, or null when every required entry resolved. */
    error: string | null;
}

const VALID_BODY_MODES = new Set<BodyMode>(["raw", "key_value"]);

function coerce_value(raw: any, data_type: BodyDataType | undefined): any {
    if (raw === undefined || raw === null) return raw;
    switch (data_type) {
        case "string":
            return typeof raw === "string" ? raw : String(raw);
        case "number": {
            if (typeof raw === "number") return raw;
            const n = Number(raw);
            return Number.isFinite(n) ? n : raw;
        }
        case "boolean": {
            if (typeof raw === "boolean") return raw;
            if (typeof raw === "string") {
                const v = raw.toLowerCase();
                if (v === "true" || v === "1") return true;
                if (v === "false" || v === "0") return false;
            }
            if (typeof raw === "number") return raw !== 0;
            return raw;
        }
        case "object":
            // If it's already an object, keep it. If it's a string that parses to
            // JSON, parse it. Otherwise leave as-is and let the upstream complain.
            if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
            if (typeof raw === "string") {
                try { const parsed = JSON.parse(raw); return parsed; } catch { return raw; }
            }
            return raw;
        case "array":
            if (Array.isArray(raw)) return raw;
            if (typeof raw === "string") {
                try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : raw; } catch { return raw; }
            }
            return raw;
        default:
            // No data_type specified → leave the value alone.
            return raw;
    }
}

export function resolve_request_body(args: ResolveBodyArgs): ResolveBodyResult {
    const mode: BodyMode = (args.body_mode && VALID_BODY_MODES.has(args.body_mode))
        ? args.body_mode
        : "raw";

    if (mode === "raw") {
        return {
            body: args.raw_body ?? null,
            resolved_entries: [],
            error: null,
        };
    }

    const entries = (args.request_body_config ?? []) as BodyConfigEntry[];
    const out: Record<string, any> = {};
    const diagnostics: ResolveBodyResult["resolved_entries"] = [];
    const errors: string[] = [];

    for (const entry of entries) {
        if (!entry || !entry.key) continue;

        if (entry.value_type === "static") {
            const value = coerce_value(entry.static_value, entry.data_type);
            // Skip undefined static values when not required — useful for
            // optional flags the user wants to omit.
            if (value === undefined) {
                if (entry.required) {
                    errors.push(`Required static body field "${entry.key}" is missing`);
                    diagnostics.push({
                        key: entry.key,
                        value_type: "static",
                        resolved_value: undefined,
                        error: "missing static_value",
                    });
                    continue;
                }
                diagnostics.push({
                    key: entry.key,
                    value_type: "static",
                    resolved_value: undefined,
                    error: null,
                });
                continue;
            }
            out[entry.key] = value;
            diagnostics.push({
                key: entry.key,
                value_type: "static",
                resolved_value: value,
                error: null,
            });
            continue;
        }

        // value_type === "variable"
        if (!entry.variable_path) {
            errors.push(`Body field "${entry.key}" is variable but variable_path is empty`);
            diagnostics.push({
                key: entry.key,
                value_type: "variable",
                resolved_value: undefined,
                error: "missing variable_path",
            });
            continue;
        }
        if (args.parent_response === undefined || args.parent_response === null) {
            // Root APIs without a parent context can't resolve variable bodies.
            // Only fail loud when the entry is required — optional ones get omitted.
            const msg = `Body field "${entry.key}" needs a parent response to resolve "${entry.variable_path}"`;
            if (entry.required) errors.push(msg);
            diagnostics.push({
                key: entry.key,
                value_type: "variable",
                variable_path: entry.variable_path,
                resolved_value: undefined,
                error: "no parent_response context",
            });
            continue;
        }

        const indexed_path = (args.card_index === undefined || args.card_index === null)
            ? entry.variable_path
            : replace_array_index_in_path(entry.variable_path, args.card_index);
        const raw_value = get_value_by_path(args.parent_response, indexed_path);
        if (raw_value === undefined || raw_value === null || raw_value === "") {
            const msg = `Body field "${entry.key}" path "${entry.variable_path}" resolved to empty`;
            if (entry.required) errors.push(msg);
            diagnostics.push({
                key: entry.key,
                value_type: "variable",
                variable_path: entry.variable_path,
                resolved_value: raw_value,
                error: "resolved to empty",
            });
            continue;
        }

        const coerced = coerce_value(raw_value, entry.data_type);
        out[entry.key] = coerced;
        diagnostics.push({
            key: entry.key,
            value_type: "variable",
            variable_path: entry.variable_path,
            resolved_value: coerced,
            error: null,
        });
    }

    return {
        body: Object.keys(out).length > 0 ? out : null,
        resolved_entries: diagnostics,
        error: errors.length > 0 ? errors.join("; ") : null,
    };
}
