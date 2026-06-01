import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { UAParser } from "ua-parser-js";

type ClientInfo = {
  ip: string | null;
  ipv4: string | null;
  user_agent: string | null;
  device: {
    type: "mobile" | "tablet" | "desktop" | "wearable" | "console" | "embedded" | "unknown";
    vendor: string | null;
    model: string | null;
  };
  browser: { name: string | null; version: string | null };
  os: { name: string | null; version: string | null };
};

function extractClientIp(req: FastifyRequest): string | null {
  const xfwd = req.headers["x-forwarded-for"];
  if (typeof xfwd === "string" && xfwd.trim().length > 0) return xfwd.split(",")[0]?.trim() ?? null;
  const xRealIp = req.headers["x-real-ip"];
  if (typeof xRealIp === "string" && xRealIp.trim().length > 0) return xRealIp.trim();
  return typeof req.ip === "string" ? req.ip : null;
}

function toIpv4(ip: string | null): string | null {
  if (!ip) return null;
  const cleaned = ip.split("%")[0] ?? "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(cleaned)) return cleaned;
  const m = cleaned.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (m && m[1]) return m[1];
  return null;
}

function normalizeDeviceType(t: string | undefined): ClientInfo["device"]["type"] {
  const v = (t ?? "").toLowerCase();
  if (v === "mobile" || v === "tablet" || v === "wearable" || v === "console" || v === "embedded") return v;
  if (v === "unknown") return "unknown";
  return "desktop";
}

declare module "fastify" {
  interface FastifyRequest {
    clientInfo: ClientInfo;
  }
}

export const clientInfoPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorateRequest("clientInfo", null as any);
  app.addHook("onRequest", async (req) => {
    const userAgentHeader = req.headers["user-agent"];
    const userAgent = typeof userAgentHeader === "string" ? userAgentHeader : null;
    const parser = new UAParser(userAgent ?? "");
    const r = parser.getResult();
    const ip = extractClientIp(req);
    const ipv4 = toIpv4(ip);
    req.clientInfo = {
      ip, ipv4, user_agent: userAgent,
      device: { type: normalizeDeviceType(r.device?.type), vendor: r.device?.vendor ?? null, model: r.device?.model ?? null },
      browser: { name: r.browser?.name ?? null, version: r.browser?.version ?? null },
      os: { name: r.os?.name ?? null, version: r.os?.version ?? null },
    };
  });
});
