import "fastify";
import type { Sequelize } from "sequelize-typescript";

declare module "fastify" {
  interface FastifyInstance {
    sequelize: Sequelize;
  }

  interface FastifyRequest {
    requestId: string;
    file?: {
      key: string;
      url: string;
      filename: string;
      original_name: string;
      mimetype: string;
      size: number;
    };
    files?: {
      key: string;
      url: string;
      filename: string;
      original_name: string;
      mimetype: string;
      size: number;
    }[];
  }
}

export {};
