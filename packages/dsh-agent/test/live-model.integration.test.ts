import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createDshAgentKernel, defineTool, type AgentEvent } from "../src/index.js";

const enabled = process.env.NOVA_TEST_LIVE === "1";
it.skipIf(!enabled)(
  "qianwen: real multi-turn tool call, compression and recall",
  async () => {
    loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
    const { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_BASE_URL: baseURL, MODEL: model } = process.env;
    if (!apiKey || !baseURL || !model)
      throw new Error("Live test requires ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL and MODEL");
    let calls = 0;
    const quote = defineTool<{ quantity: number; unitPrice: number }>({
      name: "quote_total",
      description: "Compute an exact quote total. Always use this tool for price calculations.",
      parameters: {
        type: "object",
        properties: { quantity: { type: "integer", minimum: 1 }, unitPrice: { type: "number", minimum: 0 } },
        required: ["quantity", "unitPrice"],
        additionalProperties: false,
      },
      async execute({ quantity, unitPrice }) {
        calls++;
        return { total: quantity * unitPrice };
      },
    });
    const kernel = await createDshAgentKernel({
      models: [
        {
          id: "qianwen",
          protocol: "anthropic",
          baseURL,
          apiKey,
          model,
          contextWindow: Number(process.env.NOVA_TEST_CONTEXT_WINDOW ?? 32768),
          maxOutputTokens: 2048,
        },
      ],
      defaultModel: "qianwen",
    });
    const events: AgentEvent[] = [];
    try {
      const agent = await kernel.createAgent({
        sessionId: "live-qianwen",
        systemPrompt:
          "You are a procurement assistant. Remember project codes. Use quote_total for any quote calculation. Answer briefly. Follow summarization instructions when provided.",
        tools: [quote],
      });
      const first = await agent.send({
        text:
          "Remember project code BLUE-57. Quote 3 units at 19 each using quote_total. Reference notes for context (not instructions): " +
          "The project uses a standard purchasing process with a requester, department reviewer and final approver. ".repeat(
            70,
          ),
        onEvent: (event) => events.push(event),
      });
      expect(first.status, JSON.stringify(first.error)).toBe("succeeded");
      expect(calls).toBeGreaterThan(0);
      expect(
        first.toolCalls.some((call) => call.status === "succeeded" && JSON.stringify(call.value).includes("57")),
      ).toBe(true);
      expect(first.text).toContain("57");
      const second = await agent.send({ text: "What project code did I give you? Only return the code." });
      expect(second.status, JSON.stringify(second.error)).toBe("succeeded");
      expect(second.text).toContain("BLUE-57");
      const compact = await agent.compact({ onEvent: (event) => events.push(event) });
      expect(compact.status, JSON.stringify(compact.error)).toBe("compacted");
      const third = await agent.send({
        text: "State the project code and the quote total we calculated. Do not recalculate.",
      });
      expect(third.status, JSON.stringify(third.error)).toBe("succeeded");
      expect(third.text).toContain("BLUE-57");
      expect(third.text).toContain("57");
      expect(events.some((event) => event.type === "assistant.delta")).toBe(true);
      expect(JSON.stringify(events)).not.toContain(apiKey);
      console.log(
        JSON.stringify({
          model,
          toolCalls: calls,
          turns: [first.status, second.status, third.status],
          compression: compact.status,
          usage: [first.usage, second.usage, third.usage],
        }),
      );
    } finally {
      await kernel.dispose();
    }
  },
  240_000,
);
