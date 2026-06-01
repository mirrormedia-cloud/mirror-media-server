import type { FastifyPluginAsync, FastifyError } from "fastify";
import fp from "fastify-plugin";
import { ZodError } from "zod";

import { AppError } from "../shared/errors/appError";
import { mapDbError } from "../shared/errors/mapDbErrors";
import { HttpStatus } from "../shared/http/status";
import { error, serverError } from "../shared/http/response";

const isFastifyError = (e: unknown): e is FastifyError =>
  typeof e === "object" && e !== null && "message" in e;

const zodMessage = (e: ZodError) =>
  e.errors
    .map((i) =>
      `${i.path.at(-1)?.toString().replace(/^\w/, (c) => c.toUpperCase())} ${i.message.toLowerCase()}`
    )
    .join(", ");

export const errorPlugin: FastifyPluginAsync = fp(async (app) => {
  app.setNotFoundHandler((req, reply) =>
    reply.status(HttpStatus.NOT_FOUND).send(error(HttpStatus.NOT_FOUND, "Route not found"))
  );

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError)
      return reply.status(HttpStatus.BAD_REQUEST).send(error(HttpStatus.BAD_REQUEST, zodMessage(err)));
    if (err instanceof AppError)
      return reply.status(err.code).send(error(err.code, err.message) as any);

    const db = mapDbError(err);
    if (db) return reply.status(db.code).send(error(db.code, db.message));

    const code =
      isFastifyError(err) && typeof (err as any).code === "number"
        ? (err as any).code
        : HttpStatus.INTERNAL_SERVER_ERROR;
    return reply
      .status(code)
      .send(
        code === HttpStatus.INTERNAL_SERVER_ERROR
          ? serverError("Internal server error")
          : error(code, err.message)
      );
  });
});
