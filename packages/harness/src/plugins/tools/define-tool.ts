import type { JsonValue } from "../../contracts/message.js";
import type { ToolDefinition, ToolInput } from "../../contracts/tool.js";
import { isDeepStrictEqual } from "node:util";
import { FrameworkError } from "../../contracts/errors.js";

export function defineTool<I extends JsonValue, O extends JsonValue>(definition: ToolInput<I, O>): ToolDefinition {
  const prepare = (input: unknown) => {
    const parsed = definition.inputSchema.parse(input);
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
