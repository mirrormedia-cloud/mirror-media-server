import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import moment from "moment";
import { config } from "../config";

type AnyObj = Record<string, any>;

const SENSITIVE = new Set(
  [
    "password", "passwordhash", "oldpassword", "newpassword", "confirmpassword",
    "token", "accesstoken", "refreshtoken", "secret", "apikey", "apisecret",
    "creditcard", "cvv", "ssn", "pin",
    // Push-notification additions — fcm tokens are device-scoped credentials,
    // not as catastrophic as a JWT but still uniquely identify a browser.
    "fcm_token", "fcmtoken", "private_key", "privatekey",
  ].map((x) => x.toLowerCase())
);

function sanitize(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sanitize);
  const o = v as AnyObj;
  const out: AnyObj = {};
  for (const k of Object.keys(o)) out[k] = SENSITIVE.has(k.toLowerCase()) ? "[REDACTED]" : sanitize(o[k]);
  return out;
}

async function base(req: FastifyRequest, reply: FastifyReply) {
  const client = req.clientInfo;
  return {
    request_id: req.id,
    ip_address: client.ipv4,
    client,
    user_id: (req as any).userId ?? null,
    endpoint: req.url.split("?")[0],
    full_url: `${req.protocol}://${req.hostname}${req.url}`,
    payload: req.body ? sanitize(req.body) : null,
    query: req.query && Object.keys(req.query as object).length ? req.query : null,
    params: req.params && Object.keys(req.params as object).length ? req.params : null,
    method: req.method,
    authorised: Boolean((req as any).userId),
    timestamp: await moment().format("YYYY-MM-DD HH:mm:ss"),
    status_code: reply.statusCode || 500,
    response_time_ms: Math.round(reply.elapsedTime * 100) / 100,
  };
}

export const requestLoggerPlugin: FastifyPluginAsync = fp(async (app) => {
  app.addHook("onSend", async (req, reply, payload) => {
    (reply as any).responseData = payload;
    return payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    const responseData = (reply as any).responseData ?? null;
    if (reply.statusCode === 200 || reply.statusCode === 201) {
      if (config.logging.captureSuccess) {
        req.log.info({
          ...base(req, reply),
          responseData,
          message: JSON.parse(reply?.responseData as any)?.success?.message || "unknown",
        });
      }
    } else {
      if (reply.statusCode < 500 && config.logging.captureErrors) {
        req.log.error({
          ...base(req, reply),
          responseData,
          error: JSON.parse(reply?.responseData as any)?.error?.message ?? "Error",
          message: JSON.parse(reply?.responseData as any)?.error?.message || "unknown",
        });
      }
    }
  });

  app.addHook("onError", async (req, reply, err: any) => {
    if (config.logging.captureErrors) {
      const responseData = (reply as any).responseData ?? null;
      req.log.error({
        ...base(req, reply),
        responseData,
        db_model: err?.dbModel ?? null,
        error: err?.name ?? "Error",
        message: err?.message ?? "error",
      });
    }
  });
});
