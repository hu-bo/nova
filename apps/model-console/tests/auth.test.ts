import { afterEach, expect, it, vi } from "vitest";
import { configureSession } from "../src/auth/session.js";
import { apiMutator } from "../src/api/orval-mutator.js";

vi.mock("../src/api/api-notify.js", () => ({ notifyApiFailure: vi.fn() }));
let clear: (() => void) | undefined;
afterEach(() => {
  clear?.();
  vi.unstubAllGlobals();
});

it("reads the SDK's current token and retries one 401 after refresh with the same request body", async () => {
  let token = "old-access";
  const refresh = vi.fn(async () => {
    token = "new-access";
    return true;
  });
  clear = configureSession({ token: () => token, refresh, logout: vi.fn() });
  const bodies: unknown[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    bodies.push(init.body);
    return new Headers(init.headers).get("authorization") === "Bearer old-access"
      ? new Response("{}", { status: 401 })
      : new Response(JSON.stringify({ code: 200, data: "accepted" }));
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await apiMutator("/admin/model-config/models", { method: "POST", body: '{"name":"model"}' })).toBe("accepted");
  expect(refresh).toHaveBeenCalledOnce();
  expect(bodies).toEqual(['{"name":"model"}', '{"name":"model"}']);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not refresh or log out on 403", async () => {
  const refresh = vi.fn();
  const logout = vi.fn();
  clear = configureSession({ token: () => "member", refresh, logout });
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 403 }));
  await expect(apiMutator("/admin/model-config/models", {})).rejects.toMatchObject({ status: 403 });
  expect(refresh).not.toHaveBeenCalled();
  expect(logout).not.toHaveBeenCalled();
});

it("clears a rejected session after one failed retry", async () => {
  const logout = vi.fn();
  const refresh = vi.fn(async () => true);
  clear = configureSession({ token: () => "invalid", refresh, logout });
  const fetcher = vi.fn(async () => new Response("{}", { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(apiMutator("/admin/model-config/models", {})).rejects.toMatchObject({ status: 401 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledOnce();
  expect(logout).toHaveBeenCalledOnce();
});
