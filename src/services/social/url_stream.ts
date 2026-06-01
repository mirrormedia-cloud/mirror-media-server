/**
 * HTTPS GET → Readable stream helper used by the social upload pipeline.
 *
 * Replaces the pre-R2 `get_drive_file_stream(file_id)` used by the
 * YouTube and Facebook uploaders. The R2 CDN URL stored on each library
 * row (`file_url`) is publicly fetchable, so a plain axios stream is
 * enough — no auth headers, no signing.
 *
 * Returns the same shape the old Drive helper returned so the call
 * sites only changed inputs (file_id → url), not consumers.
 */

import axios from "axios";

export interface UrlStreamResult {
    stream: NodeJS.ReadableStream;
    content_type: string;
    file_size: number | null;
}

export async function get_url_stream(url: string): Promise<UrlStreamResult> {
    const res = await axios.get(url, {
        responseType: "stream",
        // No upper bound — large library uploads (>1 GB) must flow through.
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        // No timeout — uploads must run to completion regardless of how
        // slow the upstream is to start sending bytes.
        timeout: 0,
        // Throw only on 5xx / network errors. 4xx surfaces in res.status
        // so the caller can produce a richer error than axios's default.
        validateStatus: () => true,
    });
    if (res.status >= 400) {
        throw new Error(`Upstream HTTP ${res.status} for ${url}`);
    }
    const content_type = (res.headers["content-type"] as string | undefined)
        ?? "application/octet-stream";
    const raw_len = res.headers["content-length"];
    const parsed_len = raw_len != null ? Number(raw_len) : NaN;
    return {
        stream: res.data as NodeJS.ReadableStream,
        content_type,
        file_size: Number.isFinite(parsed_len) ? parsed_len : null,
    };
}
