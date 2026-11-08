import type { FastifyInstance } from "fastify";
import { SpecService } from "./spec.service.js";
import { specRoutes } from "./spec.routes.js";

export async function specsModule(app: FastifyInstance) {
  const service = new SpecService(app.db);
  await app.register(async (scope) => specRoutes(scope, service), { prefix: "" });
}
