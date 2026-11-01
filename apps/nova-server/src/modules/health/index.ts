import type { FastifyInstance } from "fastify";
import { createHealthRepository } from "./health.repository.js";
import { healthRoutes } from "./health.routes.js";

export async function healthModule(app: FastifyInstance): Promise<void> {
  await healthRoutes(app, createHealthRepository(app.db));
}
