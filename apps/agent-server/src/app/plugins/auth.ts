import type { FastifyInstance, FastifyRequest } from "fastify";
import { unauthorized } from "../../errors.js";
import { createRunnerTokenSecret, type AgentStore, type UserProfile, type UserRow } from "../../store.js";

export type VerifyAccessToken = (token: string) => Promise<UserProfile | null>;

declare module "fastify" {
  interface FastifyRequest {
    currentUser: UserRow | null;
    userId: string;
  }
}

export function registerAuth(app: FastifyInstance, verify: VerifyAccessToken, store: AgentStore): void {
  app.decorateRequest("currentUser", null);
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async request => {
    const token = bearerToken(request);
    if (!token) throw unauthorized();
    const user = await verify(token);
    if (!user) throw unauthorized();
    const currentUser = await store.upsertUser(user);
    if (!user.isActive) throw unauthorized();
    await store.ensureRunnerToken({ userId: currentUser.casdoorId, token: createRunnerTokenSecret() });
    request.currentUser = currentUser;
    request.userId = currentUser.casdoorId;
  });
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}
