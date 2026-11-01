import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notifyApiFailure } = vi.hoisted(() => ({ notifyApiFailure: vi.fn() }));
vi.mock("../src/api/api-notify.js", () => ({ notifyApiFailure }));

import { apiMutator } from "../src/api/orval-mutator.js";
import { ApiClientError, errorMessage } from "../src/api/errors.js";

describe("API error interception", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("window", new EventTarget());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    notifyApiFailure.mockClear();
  });

  it.each([400, 401, 403, 404, 409, 422, 429, 500, 503])(
    "notifies HTTP %i and preserves business fields",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(
            JSON.stringify({
              code: status,
              subCode: "NAME_CONFLICT",
              message: "名称已存在",
              details: { fieldErrors: { name: "重复" } },
            }),
            { status },
          ),
      );
      const failure = await apiMutator("/api/test", {}).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiClientError);
      expect(failure).toMatchObject({ status, code: "NAME_CONFLICT", notified: true, fieldErrors: { name: "重复" } });
      expect(errorMessage(failure)).toBe("名称已存在");
      expect(notifyApiFailure).toHaveBeenCalledOnce();
      expect(notifyApiFailure).toHaveBeenCalledWith(status >= 500 ? "server" : "request", "名称已存在");
    },
  );

  it("notifies network failures and continues rejecting", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(apiMutator("/api/test", {})).rejects.toMatchObject({ code: "NETWORK_ERROR", notified: true });
    expect(notifyApiFailure).toHaveBeenCalledOnce();
  });

  it.each(["<html>error</html>", "null", '{"code":200}'])("notifies invalid responses: %s", async (body) => {
    vi.stubGlobal("fetch", async () => new Response(body));
    await expect(apiMutator("/api/test", {})).rejects.toMatchObject({ code: "INVALID_RESPONSE", notified: true });
    expect(notifyApiFailure).toHaveBeenCalledOnce();
    expect(notifyApiFailure).toHaveBeenCalledWith("response", "服务响应不完整");
  });

  it.each([409, 10001])("recognizes business code %i within HTTP 200", async (code) => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ code, message: "状态冲突" })));
    await expect(apiMutator("/api/test", {})).rejects.toMatchObject({
      status: code === 409 ? 409 : 502,
      code: String(code),
      notified: true,
    });
    expect(notifyApiFailure).toHaveBeenCalledOnce();
  });

  it("leaves silent requests quiet while retaining the error", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"code":400}', { status: 400 }));
    await expect(apiMutator("/api/test", { silent: true })).rejects.toMatchObject({ status: 400, notified: false });
    expect(notifyApiFailure).not.toHaveBeenCalled();
  });

  it("preserves cancellation without showing a Toast", async () => {
    const controller = new AbortController();
    const cancelled = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", async () => {
      controller.abort();
      throw cancelled;
    });
    await expect(apiMutator("/api/test", { signal: controller.signal })).rejects.toBe(cancelled);
    expect(notifyApiFailure).not.toHaveBeenCalled();
  });

  it("returns successful data without a Toast", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"code":200,"data":{"id":1}}'));
    await expect(apiMutator("/api/test", {})).resolves.toEqual({ id: 1 });
    expect(notifyApiFailure).not.toHaveBeenCalled();
  });
});
