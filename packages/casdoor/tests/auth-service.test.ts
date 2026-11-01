import { afterEach, expect, it, vi } from "vitest";
import { createAuthServiceClient, AuthServiceError } from "../src/server/auth-service.js";

const user = {
  id: "stable-id",
  name: "alice",
  displayName: "Alice",
  roles: [
    { name: "member", isEnabled: true },
    { name: "admin", isEnabled: false },
  ],
};
const response = (profile: unknown = user) => new Response(JSON.stringify({ user: profile }));
const options = { authApiBase: "https://identity.example/api/" };
afterEach(() => vi.useRealTimers());

it("verifies through the public SDK contract, using header transport by default", async () => {
  const fetcher = vi.fn(async (url, init) => {
    expect(String(url)).toBe("https://identity.example/api/me");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-token");
    expect(init.redirect).toBe("error");
    return response();
  });
  const identity = await createAuthServiceClient(options, fetcher).verifyAccessToken("access-token");
  expect(identity).toEqual({ identityId: "stable-id", displayName: "Alice", roles: ["member"], active: true });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("uses query transport only when selected, with encoded tokens and no fallback", async () => {
  const fetcher = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    expect(url.searchParams.get("token")).toBe("opaque+/=&value");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    return response();
  });
  await createAuthServiceClient({ ...options, tokenTransport: "query" }, fetcher).verifyAccessToken("opaque+/=&value");
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([401, 403, 429, 500, 503])("classifies HTTP %i without including provider data", async (status) => {
  const fetcher = vi.fn(async () => new Response("secret provider body", { status }));
  const request = createAuthServiceClient(options, fetcher).verifyAccessToken("private-token");
  await expect(request).rejects.toMatchObject({
    code: status === 401 || status === 403 ? "INVALID_TOKEN" : "UNAVAILABLE",
  });
  await expect(request).rejects.not.toHaveProperty("cause");
  await expect(request).rejects.not.toThrow(/private-token|secret|provider/);
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([
  undefined,
  { id: "no-name" },
  { ...user, isAdmin: "true" },
  { ...user, roles: [{ name: "admin", isEnabled: "true" }] },
  { ...user, id: "x".repeat(257) },
])("rejects malformed identity data without trusting roles", async (profile) => {
  const request = createAuthServiceClient(
    options,
    async () => new Response(JSON.stringify({ user: profile })),
  ).verifyAccessToken("token");
  await expect(request).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

it("rejects invalid JSON and strips token-bearing fetch diagnostics", async () => {
  await expect(
    createAuthServiceClient(options, async () => new Response("<html>oops</html>")).verifyAccessToken("token"),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  const request = createAuthServiceClient(options, async () => {
    throw new Error("https://identity.example/api/me?token=private-token");
  }).verifyAccessToken("private-token");
  await expect(request).rejects.toBeInstanceOf(AuthServiceError);
  await expect(request).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await expect(request).rejects.not.toHaveProperty("cause");
  await expect(request).rejects.not.toThrow(/private-token|identity\.example/);
});

it.each([{ isForbidden: true }, { isDeleted: true }])(
  "keeps disabled provider accounts inactive (%j)",
  async (flags) => {
    const identity = await createAuthServiceClient(options, async () =>
      response({ ...user, ...flags }),
    ).verifyAccessToken("token");
    expect(identity.active).toBe(false);
  },
);

it("projects verified administrator flags and de-duplicates enabled roles", async () => {
  const identity = await createAuthServiceClient(options, async () =>
    response({
      ...user,
      isGlobalAdmin: true,
      roles: [
        { name: "admin", isEnabled: true },
        { name: "admin", isEnabled: true },
      ],
    }),
  ).verifyAccessToken("token");
  expect(identity.roles).toEqual(["admin"]);
});

it.each(["", "has whitespace", "line\nbreak", "x".repeat(16385)])(
  "rejects malformed credentials before sending them",
  async (token) => {
    const fetcher = vi.fn();
    await expect(createAuthServiceClient(options, fetcher).verifyAccessToken(token)).rejects.toMatchObject({
      code: "INVALID_TOKEN",
    });
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it("bounds requests with a timeout and combines caller cancellation", async () => {
  const blocked: typeof fetch = async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const hold = setTimeout(() => reject(new Error("signal was ignored")), 1000);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(hold);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  const client = createAuthServiceClient({ ...options, timeoutMs: 10 }, blocked);
  await expect(client.verifyAccessToken("token")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  const controller = new AbortController();
  const pending = client.verifyAccessToken("token", controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" });
});

it.each([
  { ...options, authApiBase: "file:///private/api" },
  { ...options, authApiBase: "https://user:password@example.com/api" },
  { ...options, authApiBase: "https://example.com/api?token=secret" },
  { ...options, timeoutMs: 0 },
])("validates configuration at construction", (config) => {
  expect(() => createAuthServiceClient(config)).toThrow();
});
