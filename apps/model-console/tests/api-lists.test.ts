import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels, listProviders } from "../src/api/client.js";

vi.mock("../src/api/api-notify.js", () => ({ notifyApiFailure: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ["providers", listProviders],
  ["models", listModels],
] as const)("%s list response", (resource, list) => {
  it.each([{ data: [] }, { data: [{ id: "entry-1", enabled: true }] }])(
    "unwraps successful data: %j",
    async ({ data }) => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 200, message: "ok", data })));
      vi.stubGlobal("fetch", fetcher);

      const result = await list();

      expect(result).toEqual(data);
      expect(result.filter((entry) => entry.enabled)).toHaveLength(data.length);
      expect(fetcher).toHaveBeenCalledWith(`/admin/model-config/${resource}`, expect.any(Object));
    },
  );

  it.each([{}, { items: [] }, { code: 200, data: [] }, null])(
    "rejects malformed list data instead of caching it: %j",
    async (data) => {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ code: 200, message: "ok", data })));
      await expect(list()).rejects.toMatchObject({ status: 502, code: "INVALID_RESPONSE" });
    },
  );
});
