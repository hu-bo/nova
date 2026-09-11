import { afterEach, describe, expect, it } from "vitest";
import { createDshAgentKernel, defineTool, type AgentEvent, type DshAgentKernel } from "../src/index.js";
import { provider, type Reply, type WireRequest } from "./provider.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function harness(
  respond: (request: WireRequest, index: number) => Reply | Promise<Reply>,
  maxConcurrentRuns = 1,
) {
  const server = await provider(respond);
  cleanup.push(() => server.dispose());
  const kernel = await createDshAgentKernel({ models: [server.model], defaultModel: "fast", maxConcurrentRuns });
  cleanup.push(() => kernel.dispose());
  return { server, kernel };
}
const quote = defineTool<{ quantity: number; price: number }>({
  name: "quote_total",
  description: "Calculate total",
  parameters: {
    type: "object",
    properties: { quantity: { type: "integer", minimum: 1 }, price: { type: "number", minimum: 0 } },
    required: ["quantity", "price"],
    additionalProperties: false,
  } as const,
  async execute({ quantity, price }) {
    return { total: quantity * price };
  },
});

describe("session kernel with real DSH and HTTP adapter", () => {
  it("keeps concurrent credentials, prompts and tools isolated", async () => {
    const both = Promise.withResolvers<void>();
    const { server, kernel } = await harness(async (_request, index) => {
      if (index === 1) both.resolve();
      await both.promise;
      return { text: "ok" };
    }, 2);
    await kernel.updateModel({ ...server.model, id: "other", apiKey: "other-secret" });
    const one = await kernel.createAgent({ sessionId: "tenant-a", systemPrompt: "persona A", tools: [quote] });
    const two = await kernel.createAgent({ sessionId: "tenant-b", systemPrompt: "persona B", model: "other" });
    const results = await Promise.all([one.send({ text: "request A" }), two.send({ text: "request B" })]);
    expect(results.every((result) => result.status === "succeeded")).toBe(true);
    const first = server.requests.find((request) => request.headers["x-api-key"] === "test-secret")!;
    const second = server.requests.find((request) => request.headers["x-api-key"] === "other-secret")!;
    expect(JSON.stringify(first.body)).toContain("quote_total");
    expect(JSON.stringify(first.body)).not.toMatch(/persona B|request B/);
    expect(JSON.stringify(second.body)).not.toMatch(/persona A|request A|quote_total/);
  });

  it("honors pre-abort and drains active work when the kernel closes", async () => {
    const arrived = Promise.withResolvers<void>();
    const { server, kernel } = await harness(() => {
      arrived.resolve();
      return { hang: true };
    });
    const agent = await kernel.createAgent({ sessionId: "shutdown", systemPrompt: "" });
    const abort = new AbortController();
    abort.abort();
    expect((await agent.send({ text: "pre-aborted", signal: abort.signal })).status).toBe("cancelled");
    expect(server.requests).toHaveLength(0);
    const pending = agent.send({ text: "hang" });
    await arrived.promise;
    await Promise.all([kernel.dispose(), kernel.dispose()]);
    expect((await pending).status).toBe("cancelled");
    await expect(agent.send({ text: "after shutdown" })).rejects.toMatchObject({ code: "CLOSED" });
  });

  it.each(["openai-chat", "openai-responses"] as const)("supports %s with direct credentials", async (protocol) => {
    const { server, kernel } = await harness(() => ({ text: "compatible" }));
    await kernel.updateModel({ ...server.model, protocol });
    const agent = await kernel.createAgent({ sessionId: protocol, systemPrompt: "" });
    const result = await agent.send({ text: "Hello" });
    expect(result).toMatchObject({ status: "succeeded", text: "compatible" });
    expect(server.requests[0]!.headers.authorization).toBe("Bearer test-secret");
  });

  it("checks prompt and tool envelope capacity before network I/O", async () => {
    const { server, kernel } = await harness(() => ({ text: "ok" }));
    await kernel.updateModel({ ...server.model, contextWindow: 1000, maxOutputTokens: 256 });
    const agent = await kernel.createAgent({
      sessionId: "oversize",
      systemPrompt: "long instruction ".repeat(500),
    });
    expect((await agent.send({ text: "hello" })).error?.code).toBe("CONTEXT_LIMIT");
    expect(server.requests).toHaveLength(0);
  });

  it("forwards an external abort into a running business tool and resumes", async () => {
    const entered = Promise.withResolvers<void>();
    const { kernel } = await harness((_request, index) =>
      index === 0 ? { tool: { name: "wait", args: {} } } : { text: "ok" },
    );
    const tool = defineTool({
      name: "wait",
      description: "Wait",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, { signal }) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("cancelled"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
        return null;
      },
    });
    const agent= await kernel.createAgent({ sessionId: "tool-cancel", systemPrompt: "", tools: [tool] });
    const abort = new AbortController();
    const pending = agent.send({ text: "wait", signal: abort.signal });
    await entered.promise;
    abort.abort();
    expect((await pending).status).toBe("cancelled");
    expect((await agent.send({ text: "continue" })).status).toBe("succeeded");
  });

  it("compacts history, retains its summary and continues with the selected model", async () => {
    const { server, kernel } = await harness((request) => ({
      text: JSON.stringify(request.body).includes("acting as a compaction engine")
        ? "Remember: project code BLUE-57."
        : "Acknowledged",
    }));
    const agent= await kernel.createAgent({ sessionId: "compact", systemPrompt: "business persona" });
    await agent.send({ text: "Project code BLUE-57. " + "historical details ".repeat(400) });
    await agent.send({ text: "Keep the code" });
    const events: AgentEvent[] = [];
    expect(await agent.compact({ onEvent: (event) => events.push(event) })).toMatchObject({ status: "compacted" });
    await agent.send({ text: "What was the project code?" });
    const last = JSON.stringify(server.requests.at(-1)!.body);
    expect(last).toContain("BLUE-57");
    expect(last).toContain("compacted-summary");
    expect(last).not.toContain("historical details");
    expect(events.map((event) => event.type)).toEqual(["compression.started", "compression.finished"]);
  });

  it("uses the new smaller model for automatic compression before continuing", async () => {
    const { server, kernel } = await harness((request) => ({
      text: JSON.stringify(request.body).includes("acting as a compaction engine") ? "Project code BLUE-57." : "ok",
    }));
    const agent= await kernel.createAgent({
      sessionId: "smaller",
      systemPrompt: "Business assistant",
      compression: { thresholdRatio: 0.4 },
    });
    await agent.send({ text: "Project code BLUE-57. " + "historical details ".repeat(1000) });
    await kernel.updateModel({
      ...server.model,
      id: "small",
      model: "small-model",
      contextWindow: 10000,
      maxOutputTokens: 512,
    });
    const events: AgentEvent[] = [];
    const result = await agent.send({ text: "Continue", model: "small", onEvent: (event) => events.push(event) });
    expect(result.status).toBe("succeeded");
    expect(events.some((event) => event.type === "compression.finished" && event.status === "succeeded")).toBe(true);
    expect(server.requests.slice(1).every((request) => request.body.model === "small-model")).toBe(true);
    expect(server.requests.slice(1).map((request) => request.body.max_tokens)).toEqual([512, 512]);
  });

  it("keeps the original history after a failed summary", async () => {
    const { server, kernel } = await harness((request) =>
      JSON.stringify(request.body).includes("acting as a compaction engine") ? { status: 500 } : { text: "ok" },
    );
    const agent= await kernel.createAgent({
      sessionId: "failed-summary",
      systemPrompt: "",
      compression: { enabled: false },
    });
    await agent.send({ text: "original marker " + "details ".repeat(400) });
    expect((await agent.compact()).status).toBe("failed");
    expect((await agent.send({ text: "Continue" })).status).toBe("succeeded");
    expect(JSON.stringify(server.requests.at(-1)!.body)).toContain("original marker");
    expect(JSON.stringify(server.requests.at(-1)!.body)).not.toContain("compacted-summary");
  });

  it("retains turns, streams text and switches model without changing the default", async () => {
    const { server, kernel } = await harness((_request, index) => ({ text: `answer-${index}` }));
    const agent= await kernel.createAgent({ sessionId: "chat", systemPrompt: "business persona" });
    const events: AgentEvent[] = [];
    const first = await agent.send({ text: "Remember blue", onEvent: (event) => events.push(event) });
    expect(first).toMatchObject({ status: "succeeded", text: "answer-0", usage: { inputTokens: 10, outputTokens: 5 } });
    await kernel.updateModel({ ...server.model, id: "quality", model: "quality-model", apiKey: "quality-secret" });
    expect((await agent.send({ text: "Which colour?", model: "quality" })).status).toBe("succeeded");
    await agent.send({ text: "Continue" });
    expect(server.requests.map((request) => request.body.model)).toEqual(["qwen-test", "quality-model", "qwen-test"]);
    expect(JSON.stringify(server.requests[1]!.body)).toContain("Remember blue");
    expect(server.requests[1]!.headers["x-api-key"]).toBe("quality-secret");
    expect(events.map((event) => event.type)).toEqual(["turn.started", "assistant.delta", "turn.finished"]);
    expect(JSON.stringify({ first, events })).not.toContain("test-secret");
  });

  it("freezes configuration for the entire tool loop", async () => {
    const { server, kernel } = await harness((_request, index) =>
      index === 0 ? { tool: { name: "quote_total", args: { quantity: 3, price: 19 } } } : { text: "57" },
    );
    const agent= await kernel.createAgent({ sessionId: "tools", systemPrompt: "Use tools", tools: [quote] });
    const events: AgentEvent[] = [];
    const result = await agent.send({
      text: "Quote",
      onEvent(event) {
        events.push(event);
        if (event.type === "tool.started")
          void kernel.updateModel({ ...server.model, apiKey: "new-secret", model: "new-model" });
      },
    });
    expect(result).toMatchObject({
      status: "succeeded",
      text: "57",
      toolCalls: [{ status: "succeeded", value: { total: 57 } }],
    });
    expect(server.requests.map((request) => request.headers["x-api-key"])).toEqual(["test-secret", "test-secret"]);
    expect(JSON.stringify(server.requests[1]!.body)).toContain("57");
    await agent.send({ text: "Next" });
    expect(server.requests[2]!.body.model).toBe("new-model");
  });

  it("rejects invalid arguments and unregistered tools before execution", async () => {
    let executed = 0;
    const { kernel } = await harness((_request, index) =>
      index === 0
        ? { tool: { name: "quote_total", args: { quantity: -1, price: 19 } } }
        : index === 1
          ? { tool: { name: "shell", args: {} } }
          : { text: "recovered" },
    );
    const agent= await kernel.createAgent({
      sessionId: "guard",
      systemPrompt: "",
      tools: [
        {
          ...quote,
          async execute() {
            executed++;
            return {};
          },
        },
      ],
    });
    const result = await agent.send({ text: "Try" });
    expect(executed).toBe(0);
    expect(result.toolCalls.map((call) => call.status)).toEqual(["failed", "failed"]);
  });

  it("enforces busy and capacity, times out and allows a later turn", async () => {
    const arrived = Promise.withResolvers<void>();
    const { kernel } = await harness((_request, index) => {
      arrived.resolve();
      return index === 0 ? { hang: true } : { text: "resumed" };
    });
    const first = await kernel.createAgent({ sessionId: "one", systemPrompt: "" });
    const second = await kernel.createAgent({ sessionId: "two", systemPrompt: "" });
    const pending = first.send({ text: "Hang", timeoutMs: 500 });
    await arrived.promise;
    await expect(first.send({ text: "Busy" })).rejects.toMatchObject({ code: "BUSY" });
    await expect(second.send({ text: "Capacity" })).rejects.toMatchObject({ code: "CAPACITY" });
    expect((await pending).status).toBe("timed_out");
    expect((await first.send({ text: "Continue" })).text).toBe("resumed");
  });

  it("isolates sessions, cancels cooperatively and disposes idempotently", async () => {
    const arrived = Promise.withResolvers<void>();
    const { server, kernel } = await harness((_request, index) => {
      arrived.resolve();
      return index === 0 ? { hang: true } : { text: "ok" };
    }, 2);
    const one = await kernel.createAgent({ sessionId: "a", systemPrompt: "private A", tools: [quote] });
    const two = await kernel.createAgent({ sessionId: "b", systemPrompt: "private B" });
    const pending = one.send({ text: "secret A" });
    await arrived.promise;
    one.cancel();
    expect((await pending).status).toBe("cancelled");
    await two.send({ text: "hello B" });
    expect(JSON.stringify(server.requests[1]!.body)).not.toMatch(/private A|secret A|quote_total/);
    await Promise.all([one.dispose(), one.dispose()]);
    await expect(one.send({ text: "Closed" })).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("normalizes provider errors and contains event callback failures", async () => {
    const { kernel } = await harness((_request, index) => (index === 0 ? { status: 500 } : { text: "ok" }));
    const agent= await kernel.createAgent({ sessionId: "failure", systemPrompt: "" });
    const result = await agent.send({ text: "Fail" });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private vendor details");
    const callback = await agent.send({
      text: "Callback",
      onEvent() {
        throw new Error("private observer");
      },
    });
    expect(callback.error?.code).toBe("EVENT_CALLBACK_FAILED");
    expect((await agent.send({ text: "Recover" })).status).toBe("succeeded");
  });

  it("skips empty compression and rejects invalid configuration without reserving ids", async () => {
    const { kernel } = await harness(() => ({ text: "ok" }));
    await expect(
      kernel.createAgent({ sessionId: "same", systemPrompt: "", tools: [quote, quote] }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL" });
    const agent= await kernel.createAgent({ sessionId: "same", systemPrompt: "" });
    expect((await agent.compact()).status).toBe("skipped");
    await expect(agent.send({ text: "x", model: "missing" })).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });
  });
});
