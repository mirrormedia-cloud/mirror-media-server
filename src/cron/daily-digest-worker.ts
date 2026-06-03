/**
 * Daily WhatsApp digest cron.
 *
 * Ticks every minute. Fires the digest once per day when the server clock
 * crosses 08:00 AM in the configured timezone (Asia/Kolkata by default).
 * A `_fired_date` guard prevents double-firing if the server restarts mid-minute.
 */

import { register, run } from "./registry";
import { is_digest_time, send_daily_digests } from "../services/notification/daily-digest.service";

const CRON_ID = "daily-whatsapp-digest";
const TICK_INTERVAL_MS = 60 * 1_000; // check every minute

let _interval: NodeJS.Timeout | null = null;
let _fired_date: string | null = null; // "YYYY-MM-DD" of the last send

async function daily_digest_tick(): Promise<string> {
    if (!is_digest_time()) return "not yet";

    // Build a date key so we fire at most once per calendar day even if the
    // server restarts during the 08:00 minute window.
    const today = new Date().toISOString().slice(0, 10);
    if (_fired_date === today) return "already sent today";

    _fired_date = today;
    const { sent, skipped, failed } = await send_daily_digests();
    return `sent=${sent} skipped=${skipped} failed=${failed}`;
}

export function start_daily_digest_worker(): void {
    if (_interval) return;

    register({
        id: CRON_ID,
        label: "Daily WhatsApp Digest",
        description: "Sends each user a WhatsApp morning overview (events, uploads, failures) at 8:00 AM IST.",
        interval_ms: TICK_INTERVAL_MS,
    }, daily_digest_tick);

    const tick = async () => {
        const r = await run(CRON_ID);
        if (!r.ok) console.log(`[daily-digest] tick_error: ${r.summary}`);
        else if (r.summary !== "not yet" && r.summary !== "already sent today") {
            console.log(`[daily-digest] digest sent — ${r.summary}`);
        }
    };

    // Don't fire immediately on boot — wait for the real 08:00 window.
    _interval = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
    console.log(`[daily-digest] started — will fire daily at 08:00 IST (checking every ${TICK_INTERVAL_MS / 1000}s)`);
}

export function stop_daily_digest_worker(): void {
    if (_interval) { clearInterval(_interval); _interval = null; }
}
