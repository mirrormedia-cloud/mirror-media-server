/**
 * Central registry for system-level cron jobs.
 *
 * Each scheduled task in the backend registers itself here with its metadata
 * (id, label, interval) and a `tick` function — the unit of work executed on
 * each interval. Both the periodic scheduler AND the manual "run now" API
 * route invocations through `run(id)` so timing/state tracking stays in one
 * place:
 *   - `last_run_at` / `last_run_ok` / `last_run_summary` for the most recent
 *     tick result
 *   - `next_run_at` derived from `last_run_at + interval_ms` (or `started_at`
 *     when the cron has never ticked yet)
 *   - per-cron `_running` guard so a manual run can't overlap with a
 *     periodic one
 *
 * The frontend Crons page reads `list()` to render the table and POSTs to
 * trigger `run(id)` for "Run now".
 */

export interface CronMeta {
    id: string;
    label: string;
    description: string;
    interval_ms: number;
}

export interface CronState extends CronMeta {
    started_at: string | null;
    last_run_at: string | null;
    last_run_ok: boolean | null;
    last_run_summary: string | null;
    last_run_duration_ms: number | null;
    next_run_at: string | null;
    is_running: boolean;
}

interface CronEntry extends CronState {
    /** The async unit of work. Should return a short human-readable summary
     *  string (e.g. "processed 3 reminders"); the registry stores it for the
     *  UI. Errors are caught and stored in `last_run_summary` with `last_run_ok`
     *  set to false. */
    tick: () => Promise<string | void>;
}

const _crons = new Map<string, CronEntry>();

export function register(meta: CronMeta, tick: () => Promise<string | void>): void {
    const existing = _crons.get(meta.id);
    if (existing) {
        // Re-registration during hot-reload — keep prior state, just swap
        // the tick fn and refresh metadata so labels stay current.
        existing.tick = tick;
        existing.label = meta.label;
        existing.description = meta.description;
        existing.interval_ms = meta.interval_ms;
        return;
    }
    _crons.set(meta.id, {
        ...meta,
        started_at: new Date().toISOString(),
        last_run_at: null,
        last_run_ok: null,
        last_run_summary: null,
        last_run_duration_ms: null,
        next_run_at: new Date(Date.now() + meta.interval_ms).toISOString(),
        is_running: false,
        tick,
    });
}

/**
 * Invoke the cron's tick. Records timing + result, prevents overlapping
 * runs. Returns `{ ok, summary }` so the HTTP route can echo back to the
 * caller. If `id` isn't registered, returns ok=false with an error summary.
 */
export async function run(id: string): Promise<{ ok: boolean; summary: string }> {
    const c = _crons.get(id);
    if (!c) return { ok: false, summary: `Unknown cron: ${id}` };
    if (c.is_running) return { ok: false, summary: "Already running" };

    c.is_running = true;
    const t0 = Date.now();
    try {
        const result = await c.tick();
        const summary = typeof result === "string" && result.length > 0 ? result : "ok";
        const now = new Date();
        c.last_run_at = now.toISOString();
        c.last_run_ok = true;
        c.last_run_summary = summary;
        c.last_run_duration_ms = Date.now() - t0;
        c.next_run_at = new Date(now.getTime() + c.interval_ms).toISOString();
        return { ok: true, summary };
    } catch (err: any) {
        const summary = err?.message ?? String(err);
        const now = new Date();
        c.last_run_at = now.toISOString();
        c.last_run_ok = false;
        c.last_run_summary = summary;
        c.last_run_duration_ms = Date.now() - t0;
        c.next_run_at = new Date(now.getTime() + c.interval_ms).toISOString();
        return { ok: false, summary };
    } finally {
        c.is_running = false;
    }
}

export function list(): CronState[] {
    return Array.from(_crons.values()).map(({ tick: _tick, ...state }) => state);
}

export function get(id: string): CronState | null {
    const c = _crons.get(id);
    if (!c) return null;
    const { tick: _tick, ...state } = c;
    return state;
}
