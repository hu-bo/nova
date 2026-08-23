import { authServiceError, authServiceUnavailable } from "../errors.js";
import { createLogger } from "@nova/logger";
import type { AuthorizeUrlRequest, AuthorizeUrlResponse } from "@nova/protocol";
import type { UserProfile } from "../store.js";

type AuthServiceUser = {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  type?: unknown;
  roles?: unknown;
  isAdmin?: unknown;
  isGlobalAdmin?: unknown;
  isForbidden?: unknown;
  isDeleted?: unknown;
};

type AuthServiceResponse = { user?: AuthServiceUser };

const logger = createLogger("agent-server").child("auth-service");

export interface AuthServiceClient {
  verifyAccessToken(token: string): Promise<UserProfile | null>;
  createAuthorizeUrl(appName: string, input: AuthorizeUrlRequest): Promise<AuthorizeUrlResponse>;
}

export function createAuthServiceClient(baseUrl: string): AuthServiceClient {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/api/me`;

  return {
    async verifyAccessToken(token) {
      let response: Response;
      try {
        response = await fetch(`${endpoint}?token=${encodeURIComponent(token)}`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(5_000),
        });
      } catch (error) {
        logger.warn(
          { err: error, component: "server", dependency: "auth-service", operation: "verifyAccessToken" },
          "auth service request failed",
        );
        throw authServiceUnavailable();
      }

      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok) {
        logger.warn(
          {
            component: "server",
            dependency: "auth-service",
            operation: "verifyAccessToken",
            statusCode: response.status,
          },
          "auth service rejected token request",
        );
        throw authServiceUnavailable();
      }

      let data: AuthServiceResponse;
      try {
        data = (await response.json()) as AuthServiceResponse;
      } catch (error) {
        logger.warn(
          { err: error, component: "server", dependency: "auth-service", operation: "verifyAccessToken" },
          "auth service returned invalid JSON",
        );
        throw authServiceUnavailable();
      }

      const user = data.user;
      const casdoorId = stringValue(user?.id, 128);
      const username = stringValue(user?.name, 64);
      if (!casdoorId || !username) throw authServiceUnavailable();

      const roles = Array.isArray(user?.roles) ? user.roles : [];
      const role = roles.find((item) => isRecord(item) && item.isEnabled === true && typeof item.name === "string");
      return {
        casdoorId,
        username,
        displayName: stringValue(user?.displayName, 64),
        role: stringValue(role && isRecord(role) ? role.name : user?.type, 64),
        isAdmin: user?.isAdmin === true || user?.isGlobalAdmin === true,
        isActive: user?.isForbidden !== true && user?.isDeleted !== true,
      };
    },
    async createAuthorizeUrl(appName, input) {
      let response: Response;
      try {
        response = await fetch(
          `${baseUrl.replace(/\/+$/, "")}/api/apps/${encodeURIComponent(appName)}/oauth/authorize-url`,
          {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(5_000),
          },
        );
      } catch (error) {
        logger.warn(
          { err: error, component: "server", dependency: "auth-service", operation: "createAuthorizeUrl" },
          "auth service request failed",
        );
        throw authServiceUnavailable();
      }
      if (!response.ok) {
        logger.warn(
          {
            component: "server",
            dependency: "auth-service",
            operation: "createAuthorizeUrl",
            statusCode: response.status,
          },
          "auth service returned an error",
        );
        throw authServiceError();
      }
      try {
        const data = (await response.json()) as unknown;
        if (!isRecord(data) || typeof data.url !== "string") throw new Error("invalid url");
        return { url: data.url };
      } catch (error) {
        logger.warn(
          { err: error, component: "server", dependency: "auth-service", operation: "createAuthorizeUrl" },
          "auth service returned invalid authorization data",
        );
        throw authServiceError();
      }
    },
  };
}

function stringValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? [...value].slice(0, maxLength).join("") : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
