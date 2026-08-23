import { describe, expect, it } from "vitest";
import { createMemoryModelConfigStore } from "./model-config.store.js";

describe("available model visibility", () => {
  it("returns public models and models owned by the current user only", async () => {
    const store = createMemoryModelConfigStore();
    const publicProvider = await store.createProvider(provider("public", true, null));
    const aliceProvider = await store.createProvider(provider("alice", false, "alice"));
    const bobProvider = await store.createProvider(provider("bob", false, "bob"));
    await store.createModel(model(publicProvider.id, "Public model"));
    await store.createModel(model(aliceProvider.id, "Alice model"));
    await store.createModel(model(bobProvider.id, "Bob model"));

    await expect(store.listAvailableModels("alice")).resolves.toEqual([
      expect.objectContaining({ name: "Alice model", visibility: "owned" }),
      expect.objectContaining({ name: "Public model", visibility: "public" }),
    ]);
  });
});

function provider(
  name: string,
  isPublic: boolean,
  ownerId: string | null,
): Parameters<ReturnType<typeof createMemoryModelConfigStore>["createProvider"]>[0] {
  return {
    protocol: "openai",
    name,
    baseUrl: `https://${name}.example.com/v1`,
    credentialEncrypted: "encrypted",
    enabled: true,
    isPublic,
    ownerId,
  };
}

function model(
  providerId: string,
  publicName: string,
): Parameters<ReturnType<typeof createMemoryModelConfigStore>["createModel"]>[0] {
  return {
    publicName,
    providerId,
    upstreamName: publicName.toLowerCase().replaceAll(" ", "-"),
    contextWindow: 128_000,
    maxOutput: 16_384,
    thinkingLevels: ["off", "high"],
    parallelToolCalls: true,
    reasoningFormat: "openai",
    inputModalities: ["text"],
    enabled: true,
    priceIn: "0",
    priceOut: "0",
    priceCacheRead: "0",
  };
}
