import assert from "node:assert/strict";
import { definePlugin, modelRouter } from "../../src/index.js";
import type {
  JsonValue,
  ModelAdapter,
  ModelChunk,
  ModelStepRequest,
} from "../../src/index.js";

export type ScriptStep = {
  check?: (request: ModelStepRequest) => void | Promise<void>;
} & ({ tool: { name: string; input: JsonValue } } | { text: string });

/** 只替换模型网络边界，不推进 Loop、不调用工具、不管理任务。 */
export class ScriptedModel implements ModelAdapter {
  readonly id = "coding-scripted-model";
  readonly requests: ModelStepRequest[] = [];
  private readonly cursors = new Map<string, number>();

  constructor(
    private readonly scripts: Readonly<Record<string, readonly ScriptStep[]>>,
  ) {}

  readonly plugin = definePlugin({
    manifest: {
      id: "test.scripted-model",
      version: "1.0.0",
      apiVersion: 1,
      scope: "kernel",
      requires: [],
      provides: ["model.router"],
    },
    setup: (context) => context.provide(modelRouter, this),
  });

  async *stream(request: ModelStepRequest): AsyncIterable<ModelChunk> {
    request.signal.throwIfAborted();
    const index = this.cursors.get(request.sessionId) ?? 0;
    const step = this.scripts[request.sessionId]?.[index];
    assert.ok(step, `非预期模型请求 ${request.sessionId} 第 ${index + 1} 次`);
    this.cursors.set(request.sessionId, index + 1);
    this.requests.push(request);
    await step.check?.(request);
    request.signal.throwIfAborted();
    if ("tool" in step) {
      const callId = `${request.sessionId}-call-${index}`;
      assert.ok(
        request.tools.some((tool) => tool.name === step.tool.name),
        "工具必须出现在模型可见目录中",
      );
      const part = { type: "tool-call" as const, callId, ...step.tool };
      yield { type: "tool.call", callId, ...step.tool };
      yield {
        type: "message.completed",
        message: { role: "assistant", parts: [part] },
      };
      yield { type: "finished", reason: "tool-calls" };
    } else {
      yield {
        type: "text.delta",
        partId: `${request.sessionId}-text-${index}`,
        text: step.text,
      };
      yield {
        type: "message.completed",
        message: {
          role: "assistant",
          parts: [{ type: "text", text: step.text }],
        },
      };
      yield { type: "finished", reason: "stop" };
    }
  }

  assertConsumed(): void {
    for (const [sessionId, steps] of Object.entries(this.scripts)) {
      assert.equal(
        this.cursors.get(sessionId) ?? 0,
        steps.length,
        `${sessionId} 未完成全部模型步骤`,
      );
    }
  }
}

export function toolResult(request: ModelStepRequest, name: string): JsonValue {
  const parts = request.messages.flatMap((message) => message.parts);
  const result = parts.findLast(
    (part) => part.type === "tool-result" && part.name === name,
  );
  assert.ok(result?.type === "tool-result", `缺少 ${name} 的工具结果`);
  assert.equal(result.status, "succeeded", `${name} 工具执行失败`);
  assert.ok(
    parts.some(
      (part) =>
        part.type === "tool-call" &&
        part.callId === result.callId &&
        part.name === name,
    ),
    "工具结果必须与原调用配对",
  );
  return result.value;
}
