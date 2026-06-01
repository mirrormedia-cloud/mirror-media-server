import axios, { AxiosRequestConfig } from "axios";
import { OttPlatform, OttApiNode, OttApiLog } from "../db/models";
import { mask_cookie_debug } from "./cookie_parser";

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type AllowedMethod = (typeof ALLOWED_METHODS)[number];

const PRIVATE_HOST_PATTERNS = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^0\./,
    /^169\.254\./,
    /^::1$/,
    /^fe80:/i,
    /^fc00:/i,
];

function is_private_host(hostname: string): boolean {
    return PRIVATE_HOST_PATTERNS.some((p) => p.test(hostname));
}

function safe_request_url(base_url: string, resolved_endpoint: string): URL {
    const trimmed_base = (base_url || "").replace(/\/$/, "");
    const trimmed_endpoint = (resolved_endpoint || "").replace(/^\//, "");
    const full = `${trimmed_base}/${trimmed_endpoint}`;
    return new URL(full);
}

export interface ExternalCallParams {
    ott: OttPlatform;
    api_node: OttApiNode;
    resolved_endpoint: string;
    request_body?: any;
    dynamic_params_used?: Record<string, any>;
    card_index?: number | null | undefined;
    item_key?: string | null | undefined;
    parent_api_id?: string | null | undefined;
    parent_api_name?: string | null | undefined;
    child_api_id?: string | null | undefined;
}

export interface ExternalCallResult {
    success: boolean;
    status: number | null;
    data: any;
    duration_ms: number;
    log_id: string;
    error_message?: string | null;
    request_url: string;
    response_preview: string | null;
}

function build_response_preview(data: any): string | null {
    if (data === null || data === undefined) return null;
    try {
        const str = typeof data === "string" ? data : JSON.stringify(data);
        return str.slice(0, 500);
    } catch {
        return null;
    }
}

export async function call_external_ott_api(params: ExternalCallParams): Promise<ExternalCallResult> {
    const {
        ott,
        api_node,
        resolved_endpoint,
        request_body = null,
        dynamic_params_used = {},
        card_index = null,
        item_key = null,
        parent_api_id = null,
        parent_api_name = null,
        child_api_id = null,
    } = params;

    const started_at = new Date();
    const start_time = Date.now();

    const cookie_string = ott.cookie_string || "";
    const cookie_meta = mask_cookie_debug(cookie_string);

    const stored_headers: Record<string, string> = {};
    const raw_headers = (ott.headers || {}) as Record<string, any>;
    for (const [k, v] of Object.entries(raw_headers)) {
        const cleaned_key = String(k).trim().replace(/^["']|["']$/g, "");
        if (cleaned_key) stored_headers[cleaned_key] = String(v);
    }

    const method = String(api_node.method || "GET").toUpperCase() as AllowedMethod;

    const log = await OttApiLog.create({
        ott_id: ott.id,
        api_node_id: api_node.id,
        parent_api_id,
        child_api_id,
        api_name: api_node.name,
        parent_api_name,
        original_endpoint: api_node.endpoint,
        resolved_endpoint,
        request_url: "",
        method,
        request_headers: stored_headers,
        cookie_status: cookie_meta.cookie_status,
        cookie_length: cookie_meta.cookie_length,
        cookie_names: cookie_meta.cookie_names,
        dynamic_params_used,
        request_body,
        status: "pending",
        card_index,
        item_key,
        started_at,
    } as any);

    let url: URL;
    try {
        url = safe_request_url(ott.base_url || "", resolved_endpoint);
    } catch {
        const failed_at = new Date();
        await log.update({
            status: "failed",
            error_message: "Invalid URL",
            ended_at: failed_at,
            duration_ms: Date.now() - start_time,
        });
        return {
            success: false,
            status: null,
            data: null,
            duration_ms: Date.now() - start_time,
            log_id: log.id,
            error_message: "Invalid URL",
            request_url: "",
            response_preview: null,
        };
    }

    if (url.protocol !== "https:") {
        const ended_at = new Date();
        await log.update({
            status: "failed",
            request_url: url.toString(),
            error_message: "Only https URLs are allowed",
            ended_at,
            duration_ms: Date.now() - start_time,
        });
        return {
            success: false,
            status: null,
            data: null,
            duration_ms: Date.now() - start_time,
            log_id: log.id,
            error_message: "Only https URLs are allowed",
            request_url: url.toString(),
            response_preview: null,
        };
    }

    if (is_private_host(url.hostname)) {
        const ended_at = new Date();
        await log.update({
            status: "failed",
            request_url: url.toString(),
            error_message: "Private/loopback hosts are not allowed",
            ended_at,
            duration_ms: Date.now() - start_time,
        });
        return {
            success: false,
            status: null,
            data: null,
            duration_ms: Date.now() - start_time,
            log_id: log.id,
            error_message: "Private/loopback hosts are not allowed",
            request_url: url.toString(),
            response_preview: null,
        };
    }

    let base_host: string;
    try {
        base_host = new URL(ott.base_url || "").hostname.toLowerCase();
    } catch {
        const ended_at = new Date();
        await log.update({
            status: "failed",
            request_url: url.toString(),
            error_message: "Invalid OTT base_url",
            ended_at,
            duration_ms: Date.now() - start_time,
        });
        return {
            success: false,
            status: null,
            data: null,
            duration_ms: Date.now() - start_time,
            log_id: log.id,
            error_message: "Invalid OTT base_url",
            request_url: url.toString(),
            response_preview: null,
        };
    }

    if (url.hostname.toLowerCase() !== base_host) {
        const ended_at = new Date();
        await log.update({
            status: "failed",
            request_url: url.toString(),
            error_message: `Resolved hostname (${url.hostname}) does not match OTT base_url (${base_host})`,
            ended_at,
            duration_ms: Date.now() - start_time,
        });
        return {
            success: false,
            status: null,
            data: null,
            duration_ms: Date.now() - start_time,
            log_id: log.id,
            error_message: "Resolved hostname does not match OTT base_url",
            request_url: url.toString(),
            response_preview: null,
        };
    }

    if (!ALLOWED_METHODS.includes(method)) {
        const ended_at = new Date();
        await log.update({
            status: "failed",
            request_url: url.toString(),
            error_message: `Method ${method} not allowed`,
            ended_at,
            duration_ms: Date.now() - start_time,
        });
        return {
            success: false,
            status: null,
            data: null,
            duration_ms: Date.now() - start_time,
            log_id: log.id,
            error_message: `Method ${method} not allowed`,
            request_url: url.toString(),
            response_preview: null,
        };
    }

    const final_headers: Record<string, string> = { ...stored_headers };
    if (!final_headers["User-Agent"] && !final_headers["user-agent"]) {
        final_headers["User-Agent"] =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
    }
    if (cookie_string) final_headers["Cookie"] = cookie_string;

    await log.update({ request_url: url.toString() });

    const axios_config: AxiosRequestConfig = {
        url: url.toString(),
        method,
        headers: final_headers,
        // No timeout — long-running upstream OTT calls must run to completion.
        timeout: 0,
        validateStatus: () => true,
    };
    const will_send_body = ["POST", "PUT", "PATCH"].includes(method) && request_body !== null && request_body !== undefined;
    if (will_send_body) {
        axios_config.data = request_body;
    }
    // One-line trace so it's visible exactly what's going upstream — request body
    // was a recurring "did it actually get passed?" question. Body itself is
    // already persisted on the OttApiLog row for this call (debug console).
    console.log(
        `[upstream] ${method} ${url.toString()} · cookie:${cookie_string ? "yes" : "no"} · ` +
        `body:${will_send_body ? JSON.stringify(request_body).slice(0, 200) : "(none)"}`,
    );

    try {
        const response = await axios(axios_config);
        const ended_at = new Date();
        const duration_ms = Date.now() - start_time;
        const success = response.status >= 200 && response.status < 300;
        const preview = build_response_preview(response.data);

        await log.update({
            status: success ? "success" : "failed",
            http_status: response.status,
            response: response.data ?? null,
            response_preview: preview,
            error_message: success ? null : `HTTP ${response.status}`,
            ended_at,
            duration_ms,
        });

        return {
            success,
            status: response.status,
            data: response.data ?? null,
            duration_ms,
            log_id: log.id,
            error_message: success ? null : `HTTP ${response.status}`,
            request_url: url.toString(),
            response_preview: preview,
        };
    } catch (err: any) {
        const ended_at = new Date();
        const duration_ms = Date.now() - start_time;
        const message: string = err?.message || "External API call failed";
        const status: number | null = err?.response?.status ?? null;
        const data: any = err?.response?.data ?? null;
        const preview = build_response_preview(data);

        await log.update({
            status: "failed",
            http_status: status,
            response: data,
            response_preview: preview,
            error_message: message,
            error_details: {
                name: err?.name ?? "Error",
                code: err?.code ?? null,
                message,
            },
            ended_at,
            duration_ms,
        });

        return {
            success: false,
            status,
            data,
            duration_ms,
            log_id: log.id,
            error_message: message,
            request_url: url.toString(),
            response_preview: preview,
        };
    }
}
