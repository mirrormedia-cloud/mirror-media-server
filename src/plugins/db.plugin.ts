import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { sequelize } from "../db";

export const dbPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorate("sequelize", sequelize);
});
