import Fastify from "fastify";
import { randomUUID } from "crypto";
import fastifyJwt from "@fastify/jwt";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "path";

import { config } from "./config";

// plugins
import { requestIdPlugin } from "./plugins/requestId.plugin";
import { errorPlugin } from "./plugins/error.plugin";
import { dbPlugin } from "./plugins/db.plugin";
import { requestLoggerPlugin } from "./plugins/request-logger";
import { clientInfoPlugin } from "./plugins/client-info.plugin";

// routes
import { authRoutes } from "./modules/auth/routes";
import { profileRoutes } from "./modules/profile/routes";
import { ottRoutes } from "./modules/ott/ott.routes";
import { ottApiRoutes } from "./modules/ott_api/ott_api.routes";
import { ottLogsRoutes } from "./modules/ott_logs/ott_logs.routes";
import { ottCardActionsRoutes } from "./modules/ott_card_actions/ott_card_actions.routes";
import { ottNestedRoutes } from "./modules/ott_nested/ott_nested.routes";
import { ottVideoAssetsRoutes } from "./modules/ott_video_assets/ott_video_assets.routes";
import { ottLibraryRoutes } from "./modules/ott_library/ott_library.routes";
import { storageRoutes } from "./modules/storage/storage.routes";
import { ottQuickFlowRoutes } from "./modules/ott_quick_flow/ott_quick_flow.routes";
import { libraryBrowserRoutes } from "./modules/library_browser/library_browser.routes";
import { calendarRoutes } from "./modules/calendar/calendar.routes";
import { uploadScheduleRoutes } from "./modules/upload_schedule/upload_schedule.routes";
import { socialMediaRoutes, socialMediaPublicRoutes } from "./modules/social_media/social_media.routes";
import { socialUploadRoutes } from "./modules/social_upload/social_upload.routes";
import { mediaAnalysisRoutes } from "./modules/media_analysis/media_analysis.routes";
import { analyticsRoutes } from "./modules/analytics/analytics.routes";
import { dashboardRoutes } from "./modules/dashboard/dashboard.routes";
import { notificationRoutes, notificationPublicRoutes } from "./modules/notifications/routes";
import { cronsRoutes } from "./modules/crons/crons.routes";

// auth middleware (used to wrap every /api/ott/* route below)
import { authenticate } from "./shared/security/auth.middleware";

// db
import { closeDb, initDb } from "./db";
import { loadDotEnv } from "./config/env";

// logger + env
import { createFileLogger } from "./logger/pino";
import env_config from "./config/environments";

// ✅ Type augmentation
declare module "fastify" {
  interface FastifyReply {
    responseData?: unknown;
  }
  interface FastifyRequest {
    userId?: string | null;
    sessionId?: string | null;
  }
}

export async function buildApp() {
  const { logger, files } = createFileLogger({
    baseDir: env_config?.logging?.dir,
    level: "info",
  });

  // ✅ Connect DB
  await initDb();

  const app = Fastify({
    logger,
    trustProxy: true,
    genReqId: () => randomUUID(),
    disableRequestLogging: true,
  });

  // ✅ Register logging + client info early
  app.register(clientInfoPlugin);
  app.register(requestLoggerPlugin);

  // ✅ graceful shutdown
  const shutdown = async () => {
    try {
      await app.close();
    } finally {
      try {
        files.close();
      } catch { }
      try {
        await closeDb();
      } catch { }
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // CORS — fully open per explicit request. `origin: true` reflects the
  // caller's Origin header on every response (NOT `*`, since browsers reject
  // `*` whenever credentials are in play). All methods + all headers
  // allowed; preflights respond 204 within 24h cache.
  app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: "*",
    exposedHeaders: "*",
    maxAge: 86400,
  });

  // JWT
  app.register(fastifyJwt, { secret: config.security.jwtSecret });

  // Cookies
  app.register(cookie);

  // Multipart (file uploads) — per-type limits enforced in upload middleware
  app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  // Static file serving for uploads
  app.register(fastifyStatic, {
    root: path.join(process.cwd(), "public"),
    prefix: "/uploads/",
    decorateReply: false,
  });

  // core plugins (order matters)
  app.register(requestIdPlugin);
  app.register(dbPlugin);
  app.register(errorPlugin);

  // Public health-check — no auth, used by the health-ping cron and uptime monitors.
  app.get("/health", (_req, res) => {
    res.status(200).send({ status: "ok", message: "👋 Welcome — mirror-media-server is alive!", ts: new Date().toISOString() });
  });

  // Public test route — triggers the daily WhatsApp digest immediately (no auth).
  // Hit GET /digest/send-now to fire it outside the 08:00 schedule window.
  app.get("/digest/send-now", async (_req, res) => {
    try {
      const { send_daily_digests } = await import("./services/notification/daily-digest.service");
      const result = await send_daily_digests();
      res.status(200).send({ status: "ok", ...result });
    } catch (err: any) {
      res.status(500).send({ status: "error", message: err?.message ?? String(err) });
    }
  });

  app.register(authRoutes,    { prefix: "/api/auth" });
  app.register(profileRoutes, { prefix: "/api/profile" });
  // Public — Google OAuth callback. Lives outside the JWT scope because
  // Google hits this URL directly; auth comes from the base64-encoded
  // `state` parameter the consent URL was built with.
  app.register(socialMediaPublicRoutes, { prefix: "/api/social" });
  // Public — dev/test broadcast endpoint. NO auth. Anyone with the URL can
  // fire a push to every active user. Keep restricted to dev environments.
  app.register(notificationPublicRoutes, { prefix: "/api/notifications" });
  // Public — WhatsApp Cloud API webhook (verification handshake +
  // ongoing message callbacks). Meta hits these directly so they MUST
  // live outside the JWT scope.

  // Every /api/ott/* route requires a valid JWT. Wrapping all 8 plugins in a
  // single Fastify scope and adding `authenticate` as a preHandler hook on the
  // scope is cleaner than touching each plugin's routes file. After this hook
  // runs, every handler can read the authed user via `req.userId`.
  app.register(async (protectedApp) => {
    protectedApp.addHook("preHandler", authenticate);
    await protectedApp.register(ottRoutes,             { prefix: "/api/ott" });
    await protectedApp.register(ottApiRoutes,          { prefix: "/api/ott" });
    await protectedApp.register(ottLogsRoutes,         { prefix: "/api/ott" });
    await protectedApp.register(ottCardActionsRoutes,  { prefix: "/api/ott" });
    await protectedApp.register(ottNestedRoutes,       { prefix: "/api/ott" });
    await protectedApp.register(ottVideoAssetsRoutes,  { prefix: "/api/ott" });
    await protectedApp.register(ottLibraryRoutes,      { prefix: "/api/ott" });
    await protectedApp.register(ottQuickFlowRoutes,    { prefix: "/api/ott" });
    // Top-level library browser (cross-OTT). /api/library/otts etc.
    await protectedApp.register(libraryBrowserRoutes,  { prefix: "/api/library" });
    // Calendar events + upload schedules — both share the /api/calendar prefix
    // so the wizard's preview/create + the calendar grid's events come from one base.
    await protectedApp.register(calendarRoutes,        { prefix: "/api/calendar" });
    await protectedApp.register(uploadScheduleRoutes,  { prefix: "/api/calendar" });
    // Social media account management (connect/status/refresh/disconnect/list)
    // — JWT required. The OAuth callback is registered separately above.
    await protectedApp.register(socialMediaRoutes,     { prefix: "/api/social" });
    // Cross-platform upload dispatcher + history
    await protectedApp.register(socialUploadRoutes,    { prefix: "/api/social" });
    // Gemini-driven analysis (platform-specific prompts) for library items.
    await protectedApp.register(mediaAnalysisRoutes,   { prefix: "/api/media-analysis" });
    // Live social analytics — fetched directly from YouTube / Facebook /
    // Instagram APIs every call. NOTHING in this module persists metrics
    // to Postgres beyond the existing token rows.
    await protectedApp.register(analyticsRoutes,       { prefix: "/api/analytics" });
    // Single home-page overview endpoint — counts pulled from DB,
    // no live platform calls so it stays fast.
    await protectedApp.register(dashboardRoutes,       { prefix: "/api/dashboard" });
    // Cloudflare R2 signed-upload helpers — JWT required so we can
    // enforce per-user object key prefixes (defence-in-depth).
    await protectedApp.register(storageRoutes,         { prefix: "/api/storage" });
    // Push notification token registration, history feed, and per-device
    // session management. All routes require the JWT-bearing session.
    await protectedApp.register(notificationRoutes,    { prefix: "/api/notifications" });
    // System cron registry — list status, trigger immediate runs.
    await protectedApp.register(cronsRoutes,           { prefix: "/api/crons" });
  });

  return app;
}
