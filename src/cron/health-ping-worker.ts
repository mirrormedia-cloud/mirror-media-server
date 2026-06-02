/**
 * Health-ping cron.
 *
 * Ticks every 60 s. Each tick calls the /health endpoint on the Render
 * deployment and logs a welcome message alongside the response status.
 * Keeps the Render free-tier instance warm (prevents cold-start spin-up).
 */

import https from "https";
import { register, run } from "./registry";

const CRON_ID = "health-ping";
const TICK_INTERVAL_MS = 60 * 1_000;
const HEALTH_URL = "https://mirror-media-server.onrender.com/health";

let _interval: NodeJS.Timeout | null = null;

function get(url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let body = "";
            res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        }).on("error", reject);
    });
}

async function health_ping_tick(): Promise<string> {
    const { status, body } = await get(HEALTH_URL);
    const welcome = "👋 Welcome — mirror-media-server is alive!";
    console.log(`[health-ping] ${welcome} | HTTP ${status} | response: ${body.slice(0, 120)}`);
    return `HTTP ${status} — ${welcome}`;
}

export function start_health_ping_worker(): void {
    if (_interval) return;
    console.log(`[health-ping] started (interval=${TICK_INTERVAL_MS}ms, url=${HEALTH_URL})`);

    register({
        id: CRON_ID,
        label: "Health Ping",
        description: `Calls ${HEALTH_URL} every minute to keep the Render instance warm and confirm it is reachable.`,
        interval_ms: TICK_INTERVAL_MS,
    }, health_ping_tick);

    const tick = async () => {
        const r = await run(CRON_ID);
        if (!r.ok) console.log(`[health-ping] tick_error: ${r.summary}`);
    };

    // Fire once shortly after boot so the first result shows up quickly.
    setTimeout(() => { void tick(); }, 5_000);
    _interval = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
}

export function stop_health_ping_worker(): void {
    if (_interval) { clearInterval(_interval); _interval = null; }
}
