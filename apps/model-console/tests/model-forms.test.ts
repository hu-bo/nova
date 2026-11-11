import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { listProviderAdapters, type CreateProvider, type Model, type ProviderAdapter } from "../src/api/client.js";
import { modelSchema, type ModelFormValues } from "../src/features/models/model-form.schema.js";
import { toModelInput } from "../src/features/models/model-input.js";
import { providerSchema } from "../src/features/providers/provider-form.schema.js";
import { providerAdapterQueryOptions } from "../src/features/providers/provider-queries.js";

vi.mock("../src/api/api-notify.js", () => ({ notifyApiFailure: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

const adapter: ProviderAdapter = {
  id: "deepseek",
  label: "DeepSeek",
  defaultBaseURL: "https://api.deepseek.com/v1",
  protocol: "openai",
  reasoningFormat: "deepseek",
  thinkingLevels: ["off", "low", "medium", "high", "max"],
};
const modelInput: ModelFormValues = {
  publicName: "reasoning-model",
  providerId: "00000000-0000-4000-8000-000000000001",
  upstreamName: "deepseek-reasoner",
  contextWindow: 128_000,
  maxOutput: 8192,
  thinkingLevels: ["high"],
  parallelToolCalls: true,
  inputModalities: ["text"],
  enabled: true,
  priceIn: "0",
  priceOut: "0",
  priceCacheRead: "0",
};

describe("provider and model form boundaries", () => {
  it("accepts a provider adapter and custom base URL without requiring a wire protocol", () => {
    const input = {
      adapterId: "deepseek",
      name: "Private gateway",
      baseUrl: "https://gateway.example/custom/v1",
      credential: "test-key",
      enabled: true,
      isPublic: false,
    } satisfies CreateProvider;
    const parsed = providerSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toHaveProperty("protocol");
  });

  it("trims the custom endpoint without rewriting its path or query", () => {
    const parsed = providerSchema.parse({
      adapterId: "anthropic",
      name: "Gateway",
      credential: "",
      enabled: true,
      isPublic: false,
      baseUrl: "  https://gateway.example/anthropic/v1?region=cn  ",
    });
    expect(parsed.baseUrl).toBe("https://gateway.example/anthropic/v1?region=cn");
  });

  it.each([
    "http://gateway.example/v1",
    "https://username:password@gateway.example/v1",
    "https://username@gateway.example/v1",
    "invalid endpoint",
  ])("rejects an invalid or credential-bearing endpoint: %s", (baseUrl) => {
    const result = providerSchema.safeParse({
      adapterId: "deepseek",
      name: "Gateway",
      credential: "",
      enabled: true,
      isPublic: false,
      baseUrl,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["baseUrl"]);
  });

  it("allows an unchanged legacy provider to keep its unspecified adapter and stored credential", () => {
    expect(
      providerSchema.parse({
        adapterId: "",
        name: "Legacy gateway",
        credential: "",
        enabled: true,
        isPublic: false,
        baseUrl: "https://gateway.example/v1",
      }),
    ).toMatchObject({ adapterId: "", credential: "" });
  });

  it("accepts model capabilities without a reasoning format and strips stale format from a form draft", () => {
    expect(modelSchema.parse(modelInput)).toEqual(modelInput);
    expect(modelSchema.parse({ ...modelInput, reasoningFormat: "none" })).toEqual(modelInput);
    expect(modelSchema.parse({ ...modelInput, thinkingLevels: [] }).thinkingLevels).toEqual([]);
  });

  it("keeps a legacy model's format for API state changes while the editor submits only model capabilities", () => {
    const model: Model = {
      ...modelInput,
      id: "00000000-0000-4000-8000-000000000002",
      providerName: "Legacy gateway",
      reasoningFormat: "deepseek",
      createdAt: "2026-11-12T00:00:00.000Z",
      updatedAt: "2026-11-12T00:00:00.000Z",
    };
    const input = toModelInput(model);
    expect(input.reasoningFormat).toBe("deepseek");
    expect(input).not.toHaveProperty("id");
    expect(input).not.toHaveProperty("providerName");
    expect(modelSchema.parse(input)).toEqual(modelInput);
  });

  it.each([{ thinkingLevels: ["high", "high"] }, { maxOutput: 128_001 }, { inputModalities: ["image"] }])(
    "rejects inconsistent model capabilities: %j",
    (patch) => {
      expect(modelSchema.safeParse({ ...modelInput, ...patch }).success).toBe(false);
    },
  );
});

describe("provider adapter catalog", () => {
  it("loads and caches the shared catalog through its admin endpoint", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 200, message: "ok", data: [adapter] })));
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient();
    try {
      expect(await client.fetchQuery(providerAdapterQueryOptions())).toEqual([adapter]);
      expect(await client.fetchQuery(providerAdapterQueryOptions())).toEqual([adapter]);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledWith(
        "/admin/model-config/provider-adapters",
        expect.objectContaining({ method: "GET" }),
      );
    } finally {
      client.clear();
    }
  });

  it.each([{}, { items: [] }, null])(
    "rejects a malformed catalog before it enters the query cache: %j",
    async (data) => {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ code: 200, message: "ok", data })));
      await expect(listProviderAdapters()).rejects.toMatchObject({ status: 502, code: "INVALID_RESPONSE" });
    },
  );
});
