import { z } from "zod";

/** Auth Service access without Casdoor administrator credentials or framework dependencies. */
export interface AuthServiceConfig {
  /** API base including /api, e.g. https://auth.example.com/api. */
  authApiBase: string;
  tokenTransport?: "header" | "query";
  timeoutMs?: number;
}

export interface AuthServiceIdentity {
  identityId: string;
  displayName: string;
  roles: readonly string[];
  active: boolean;
}

export type AuthServiceErrorCode = "INVALID_TOKEN" | "UNAVAILABLE" | "INVALID_RESPONSE";

export class AuthServiceError extends Error {
  constructor(public readonly code: AuthServiceErrorCode) {
    super(code === "INVALID_TOKEN" ? "Invalid or expired access token" : "Authentication service unavailable");
    this.name = "AuthServiceError";
  }
}

const configSchema = z.object({
  authApiBase: z.url().refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "Auth Service API base must be an HTTP(S) URL without credentials, query or fragment"),
  tokenTransport: z.enum(["header", "query"]).default("header"),
  timeoutMs: z.number().int().positive().max(30_000).default(5000),
});

const responseSchema = z.object({
  user: z.object({
    id: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(128),
    displayName: z.string().max(256).optional(),
    isAdmin: z.boolean().optional(),
    isGlobalAdmin: z.boolean().optional(),
    isForbidden: z.boolean().optional(),
    isDeleted: z.boolean().optional(),
    roles: z
      .array(z.object({ name: z.string().min(1).max(128), isEnabled: z.boolean() }))
      .max(256)
      .optional(),
  }),
});

export function createAuthServiceClient(input: AuthServiceConfig, fetchImpl: typeof fetch = fetch) {
  const config = configSchema.parse(input);
  const endpoint = `${config.authApiBase.replace(/\/+$/, "")}/me`;
  return {
    async verifyAccessToken(token: string, signal?: AbortSignal): Promise<AuthServiceIdentity> {
      if (!token || token.length > 16_384 || /\s/.test(token)) throw new AuthServiceError("INVALID_TOKEN");
      const url = new URL(endpoint);
      const headers = new Headers({ accept: "application/json" });
      if (config.tokenTransport === "query") url.searchParams.set("token", token);
      else headers.set("authorization", `Bearer ${token}`);
      let body: unknown;
      try {
        const timeout = AbortSignal.timeout(config.timeoutMs);
        const response = await fetchImpl(url, {
          headers,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          redirect: "error",
        });
        if (response.status === 401 || response.status === 403) throw new AuthServiceError("INVALID_TOKEN");
        if (!response.ok) throw new AuthServiceError("UNAVAILABLE");
        try {
          body = await response.json();
        } catch {
          throw new AuthServiceError("INVALID_RESPONSE");
        }
      } catch (error) {
        if (error instanceof AuthServiceError) throw error;
        // Legacy query URLs can contain tokens; do not retain raw fetch errors as causes.
        throw new AuthServiceError("UNAVAILABLE");
      }
      const result = responseSchema.safeParse(body);
      if (!result.success) throw new AuthServiceError("INVALID_RESPONSE");
      const user = result.data.user;
      const roles = new Set(user.roles?.filter((role) => role.isEnabled).map((role) => role.name));
      if (user.isAdmin || user.isGlobalAdmin) roles.add("admin");
      return {
        identityId: user.id,
        displayName: user.displayName || user.name,
        roles: [...roles],
        active: !user.isForbidden && !user.isDeleted,
      };
    },
  };
}
