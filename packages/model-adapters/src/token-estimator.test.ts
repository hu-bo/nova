import { describe, expect, it } from "vitest";
import { createTokenEstimator } from "./token-estimator.js";

const estimator = createTokenEstimator({ provider: "gateway", model: "unknown-model" });

describe("local token estimator", () => {
  it("is deterministic, monotonic, and handles English, CJK, code, and JSON", () => {
    for (const text of ["hello world", "上下文估算", "const value = foo(bar);", JSON.stringify({ ok: true })]) {
      const first = estimator.estimateText(text);
      expect(first.tokens).toBeGreaterThan(0);
      expect(estimator.estimateText(text)).toEqual(first);
      expect(estimator.estimateText(`${text}${text}`).tokens).toBeGreaterThanOrEqual(first.tokens);
    }
    expect(estimator.estimateText("").tokens).toBe(0);
  });

  it("includes system, messages, tool schemas, and structural overhead", () => {
    const base = estimator.estimateRequest({
      system: "system",
      messages: [{ id: "m1", role: "user", createdAt: 0, blocks: [{ type: "text", text: "hello" }] }],
      tools: [],
    });
    const withTool = estimator.estimateRequest({
      system: "system",
      messages: [{ id: "m1", role: "user", createdAt: 0, blocks: [{ type: "text", text: "hello" }] }],
      tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } }],
    });
    expect(withTool.tokens).toBeGreaterThan(base.tokens);
    expect(withTool.confidence).toBe("high");
  });

  it("reserves tokens for images and lowers confidence", () => {
    const estimate = estimator.estimateRequest({
      system: "",
      messages: [
        { id: "m1", role: "user", createdAt: 0, blocks: [{ type: "image", mimeType: "image/png", data: "AA==" }] },
      ],
      tools: [],
    });
    expect(estimate.tokens).toBeGreaterThanOrEqual(1_024);
    expect(estimate.confidence).toBe("low");
  });
});
