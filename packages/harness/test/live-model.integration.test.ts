import { loadEnvFile } from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { memoryStorage } from "@nova/agent-core";
import { createHarness } from "@nova/harness";
import { createModel } from "@nova/model-adapters";

const live = process.env.NOVA_TEST_LIVE === "1";

it.skipIf(!live)(
  "真实 OpenAI-compatible Provider 完成一次 Agent turn",
  async () => {
    loadEnvFileOverride(fileURLToPath(new URL("../../../.env", import.meta.url)));
    const apiKey = process.env.OPENAI_API_KEY;
    const modelName = process.env.MODEL;
    if (!apiKey || !modelName) throw new Error("OPENAI_API_KEY and MODEL are required in .env");
    const ref = {
      provider: "openai" as const,
      wireApi: "chat-completions" as const,
      model: modelName,
      apiKey,
      ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
    };
    const model = createModel(ref);
    const agent = createHarness({ modules: [] }).createAgent({
      model: ref,
      stream: model.stream,
      storage: memoryStorage(),
      decide: async (request) =>
        request.kind === "approval" ? { kind: "approval", decision: "deny" } : { kind: "question", answers: [] },
      systemPrompt: [{ name: "live-check", content: "这是连通性检查。只回复 NOVA_LIVE_OK，不要输出其他内容。" }],
    });

    const result = await agent.prompt("执行连通性检查");
    const text =
      result.message?.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "";
    expect(result.stopReason, result.errorMessage).toBe("done");
    expect(text).toContain("NOVA_LIVE_OK");
  },
  60_000,
);

function loadEnvFileOverride(path: string): void {
  loadEnvFile(path);
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
