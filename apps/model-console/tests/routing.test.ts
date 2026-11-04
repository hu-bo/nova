// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../src/app/router";
import type { AuthContextValue } from "../src/features/auth/auth-context";
import { safeReturnTo } from "../src/features/auth/return-to";
import { resolveUsageSearch, toUsageApiParams, usageSearchSchema } from "../src/features/usage/usage-search";

const clients: QueryClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
});

function makeRouter(href: string, authenticated = true) {
  const queryClient = new QueryClient();
  clients.push(queryClient);
  const auth: AuthContextValue = {
    isAuthenticated: authenticated,
    isLoading: false,
    displayName: authenticated ? "管理员" : null,
    error: null,
    login: vi.fn(async () => undefined),
    logout: vi.fn(),
  };
  const history = createMemoryHistory({ initialEntries: [href] });
  const router = createAppRouter({ queryClient, auth }, history);
  router.update({ isServer: false });
  return { router, auth };
}

describe("console routing", () => {
  it("redirects the index and keeps protected pages under the console layout", async () => {
    const { router } = makeRouter("/");
    await router.load();
    expect(router.state.location.pathname).toBe("/providers");
    for (const path of ["/models", "/usage", "/providers"] as const) {
      await router.navigate({ to: path });
      expect(router.state.matches.map((match) => match.routeId)).toContain("/_authenticated");
      expect(router.state.matches.at(-1)?.status).toBe("success");
    }
  });

  it("redirects anonymous deep links to login with their query and hash intact", async () => {
    const target = "/usage?from=2026-11-01&status=failed#report";
    const { router, auth } = makeRouter(target, false);
    await router.load();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search.redirect).toBe(target);
    expect(router.state.matches.map((match) => match.routeId)).not.toContain("/_authenticated");

    auth.isAuthenticated = true;
    await router.invalidate();
    await router.navigate({ href: safeReturnTo(target) });
    expect(router.state.location.pathname).toBe("/usage");
    expect(router.state.location.search).toMatchObject({ from: "2026-11-01", status: "failed" });
  });

  it("invalidates the protected route when the session expires", async () => {
    const { router, auth } = makeRouter("/models");
    await router.load();
    auth.isAuthenticated = false;
    await router.invalidate();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search.redirect).toBe("/models");
  });

  it("allows the public callback and leaves unmatched paths at the root boundary", async () => {
    const { router } = makeRouter("/callback?code=test&state=test", false);
    await router.load();
    expect(router.state.location.pathname).toBe("/callback");
    expect(router.state.matches.map((match) => match.routeId)).not.toContain("/_authenticated");
    await router.navigate({ href: "/missing" });
    expect(router.state.location.pathname).toBe("/missing");
    expect(router.state.matches.map((match) => match.routeId)).toEqual(["__root__"]);
  });
});

describe("URL boundaries", () => {
  it("preserves internal return locations and rejects external or looping destinations", () => {
    expect(safeReturnTo("/usage?status=failed#report")).toBe("/usage?status=failed#report");
    for (const input of [
      undefined,
      "https://example.com",
      "//example.com",
      "/\\example.com",
      "/login/",
      "/callback?code=x",
      "/models/../login",
    ]) {
      expect(safeReturnTo(input)).toBe("/providers");
    }
  });

  it("normalizes malformed filters and produces valid API date boundaries", () => {
    const search = usageSearchSchema.parse({ from: "invalid", to: "2026-02-30", status: "unknown", modelId: 123 });
    expect(resolveUsageSearch(search, new Date(2026, 10, 4))).toEqual({
      from: "2026-11-01",
      to: "2026-11-04",
      modelId: "",
      status: "",
    });
    const valid = usageSearchSchema.parse({
      from: "2026-11-01",
      to: "2026-11-04",
      modelId: "model-1",
      status: "failed",
    });
    expect(toUsageApiParams(valid)).toEqual({
      from: new Date("2026-11-01T00:00:00").toISOString(),
      to: new Date("2026-11-04T23:59:59.999").toISOString(),
      modelId: "model-1",
      status: "failed",
    });
  });

  it("resolves inverted date ranges without producing a backwards API interval", () => {
    const filters = toUsageApiParams(usageSearchSchema.parse({ from: "2026-11-04", to: "2026-11-01" }));
    expect(Date.parse(filters.from!)).toBeLessThan(Date.parse(filters.to!));
  });
});
