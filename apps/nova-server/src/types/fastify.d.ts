import type { Database } from "../../database/index.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}
