import { config } from "./config";
import { buildApp } from "./app";
import { closeDb } from "./db";
// Drive upload queue + HLS + status-flow library cron were removed
// when the system migrated to direct R2 signed-URL uploads. Library
// items now only exist after a successful R2 upload — no queue, no
// status state machine.
import { start_auto_publish_cron, stop_auto_publish_cron } from "./services/social/auto_publish_cron";
import { start_youtube_copyright_sweep, stop_youtube_copyright_sweep } from "./services/social/youtube_copyright_sweep";
import { start_token_refresh_cron, stop_token_refresh_cron } from "./services/social/token_refresh_cron";
import { start_reminder_worker, stop_reminder_worker } from "./cron/reminder-worker";

async function startServer() {
  console.log(`⚙️  SERVER_MODE=${process.env.SERVER_MODE ?? "—"} APP_ENV=${process.env.APP_ENV ?? "—"} NODE_ENV=${process.env.NODE_ENV ?? "—"}`);
  console.log(`⚙️  config.app.env=${config.app.env} port=${config.app.port}`);
  try {
    const app = await buildApp();

    // Bind to 0.0.0.0 so the server is reachable from:
    //   - localhost (same-machine tests)
    //   - LAN IPs (phones / other devices on the same Wi-Fi)
    //   - ngrok tunnels (ngrok forwards to a non-loopback interface)
    // 127.0.0.1 was rejecting every cross-interface request as
    // ERR_CONNECTION_REFUSED at the TCP layer (CORS never even got a chance to run).
    await app.listen({ port: config.app.port, host: "0.0.0.0" });
    console.log(`🚀 Server running at port ${config.app.port} (binding 0.0.0.0)`);
    // Background: every minute, push calendar schedule slots whose time
    // has come to social, and publish IG containers held for scheduled
    // publish. Idempotent — safe across restarts.
    start_auto_publish_cron();
    // Background: every 5 minutes, check uploaded YouTube videos for
    // copyright / Content-ID rejections and auto-delete any flagged ones.
    start_youtube_copyright_sweep();
    // Background: every minute, proactively refresh social tokens that
    // are within 5 min of expiry so the UI never sees a stale "expired"
    // card (and uploads never hit a 401 mid-stream).
    start_token_refresh_cron();
    // Background: every minute, fire calendar event reminders (2d / 1d /
    // 5h / 1h) whose time has arrived. Idempotent — rows are flipped to
    // `sent` so a subsequent tick can't double-fire.
    start_reminder_worker();
  } catch (err) {
    console.log("❌ Failed to start server", err);
    process.exit(1);
  }
}

/**
 * Graceful shutdown — clears every cron interval BEFORE the DB pool
 * closes so leftover ticks don't hit a closed ConnectionManager.
 */
let _shutting_down = false;
async function shutdown(signal: string) {
  if (_shutting_down) return;
  _shutting_down = true;
  console.log(`\n🛑 ${signal} received — shutting down…`);
  try { stop_auto_publish_cron(); } catch { /* noop */ }
  try { stop_youtube_copyright_sweep(); } catch { /* noop */ }
  try { stop_token_refresh_cron(); } catch { /* noop */ }
  try { stop_reminder_worker(); } catch { /* noop */ }
  try { await closeDb(); } catch { /* noop */ }
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

startServer();
