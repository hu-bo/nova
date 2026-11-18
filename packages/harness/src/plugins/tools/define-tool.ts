import type { JsonValue } from "../../contracts/message.js";
import type { ToolDefinition, ToolInput } from "../../contracts/tool.js";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { FrameworkError } from "../../contracts/errors.js";

export function defineTool<I extends JsonValue, O extends JsonValue>(definition: ToolInput<I, O>): ToolDefinition {
  const prepare = (input: unknown) => {
    let parsed: I;
    try {
      parsed = definition.inputSchema.parse(input);
    } catch (error) {
      throw new FrameworkError("INVALID_TOOL_INPUT", schemaFailure(error));
    }
    if (!isDeepStrictEqual(input, parsed)) {
      throw new FrameworkError("INVALID_TOOL_INPUT", "Tool inputs must not be coerced, defaulted or stripped.");
    }
    return {
      input: parsed,
      async execute(context: Parameters<ToolDefinition["execute"]>[1]) {
        return definition.outputSchema.parse(await definition.execute(parsed, context));
      },
    };
  };
  return {
    ...definition,
    prepare,
    async execute(input, context) {
      return prepare(input).execute(context);
    },
  };
}

/**
 * 入参不合 schema 时，回喂模型的原因只描述结构与位置，不带上游参数原文，与模型诊断日志同一纪律
 * （docs/deployment.md）。zod 内建 issue 的文案是 "expected X, received Y" 这类结构描述；
 * 自定义校验的文案由工具作者书写，可能夹带参数值，所以只报位置。
 * 模型据此自行纠正，整轮不因为一次不规范的调用而失败。
 */
function schemaFailure(error: unknown): string {
  if (!(error instanceof z.ZodError)) return "Tool input does not match its schema.";
  const issues = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.join(".") || "$";
    const detail =
      issue.code === "custom" ? "does not match its schema" : issue.message.replace(/^Invalid input: /, "");
    return `${path}: ${detail}`;
  });
  const rest = error.issues.length > issues.length ? "; other violations omitted" : "";
  return `Tool input does not match its schema: ${issues.join("; ")}${rest}`;
}
