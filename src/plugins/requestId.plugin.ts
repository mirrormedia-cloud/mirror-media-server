import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

export const requestIdPlugin: FastifyPluginAsync = fp(async (app: any) => {
  app.addHook("onRequest", async (request: FastifyRequest) => {
    const incomingId = request.headers["x-request-id"];
    if (typeof incomingId === "string") {
      request.id = incomingId;
    }
  });
  app.decorate("requestId", "");
  app.addHook("preHandler", async (request: FastifyRequest) => {
    request.requestId = request.id;
  });
});
