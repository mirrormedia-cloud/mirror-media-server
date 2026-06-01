/**
 * Per-library-item debug logger.
 *
 * Captures every step of the save → download/convert → drive upload → DB
 * update flow as a structured entry. Entries are mirrored to the backend
 * console immediately AND buffered in memory; on `save()` they are merged
 * into the item's `metadata.debug_logs` so the frontend (or a curl) can
 * pull the trail via `GET /api/ott/:ott_id/library/:library_item_id/debug_logs`.
 *
 * Sensitive values (private_key / cookie / password / secret / token) are
 * redacted by key name. Long strings are truncated to keep the payload sane.
 */

import { OttLibraryItem } from "../db/models";

export interface DebugLogEntry {
    ts: string;
    step: string;
    data?: Record<string, any>;
    error?: string;
}

const MAX_LOGS_PER_ITEM = 500;
const SECRET_KEY_RE = /private_key|password|cookie|secret|token|authorization|api_?key/i;
const STRING_PREVIEW = 200;

export function redact(value: Record<string, any> | undefined | null): Record<string, any> {
    if (!value || typeof value !== "object") return {};
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
        if (SECRET_KEY_RE.test(k)) {
            if (v == null) out[k] = null;
            else if (typeof v === "string") out[k] = `<redacted:${v.length}>`;
            else out[k] = "<redacted>";
            continue;
        }
        if (typeof v === "string" && v.length > STRING_PREVIEW) {
            out[k] = `${v.slice(0, STRING_PREVIEW - 3)}...(${v.length})`;
        } else {
            out[k] = v;
        }
    }
    return out;
}

export class LibraryDebugLogger {
    private entries: DebugLogEntry[] = [];
    private readonly item_id: string;
    private readonly prefix: string;

    constructor(item_id: string, label?: string) {
        this.item_id = item_id;
        const short = item_id.slice(0, 8);
        this.prefix = `[lib:${short}${label ? `:${label}` : ""}]`;
    }

    /**
     * Record a step. `data` is shallow-redacted; `error` extracts message.
     * Always console.logs immediately so the terminal sees it even if
     * `save()` never fires (e.g. process killed mid-run).
     */
    step(step: string, data?: Record<string, any>, error?: unknown): void {
        const entry: DebugLogEntry = { ts: new Date().toISOString(), step };
        if (data) entry.data = redact(data);
        if (error) {
            const msg = (error as any)?.message ?? String(error);
            entry.error = typeof msg === "string" ? msg.slice(0, 500) : "unknown error";
        }
        this.entries.push(entry);
        // Console mirror — single line so pino / docker logs read cleanly.
        const data_str = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
        const err_str = entry.error ? ` err=${JSON.stringify(entry.error)}` : "";
        console.log(`${this.prefix} ${step}${data_str}${err_str}`);
    }

    /** Convenience wrapper — call after a try/catch failure. */
    fail(step: string, error: unknown, data?: Record<string, any>): void {
        this.step(step, data, error);
    }

    /** Returns the in-memory buffer (unsaved entries collected so far). */
    snapshot(): DebugLogEntry[] {
        return [...this.entries];
    }

    /**
     * Merge buffered entries into the item's metadata.debug_logs array.
     * Caps the total stored history at MAX_LOGS_PER_ITEM to prevent the
     * row from bloating over many retries. Idempotent — safe to call
     * multiple times during a long job.
     */
    async save(): Promise<void> {
        if (this.entries.length === 0) return;
        try {
            const item = await OttLibraryItem.findByPk(this.item_id, { attributes: ["id", "metadata"] });
            if (!item) return;
            const existing = ((item as any).metadata ?? {}) as Record<string, any>;
            const prior: DebugLogEntry[] = Array.isArray(existing.debug_logs) ? existing.debug_logs : [];
            const merged = [...prior, ...this.entries].slice(-MAX_LOGS_PER_ITEM);
            await item.update({ metadata: { ...existing, debug_logs: merged } } as any);
            // Drain so a follow-up save() doesn't re-write the same entries.
            this.entries = [];
        } catch (err) {
            console.log(`${this.prefix} save_debug_logs failed:`, (err as any)?.message ?? err);
        }
    }
}
