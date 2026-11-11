import type { AssistantContent, ModelMessage, UserContent, ToolContent } from "ai";
import type { AgentMessage, JsonValue, MessagePart } from "../../contracts/message.js";
import { FrameworkError } from "../../contracts/errors.js";
import { z } from "zod";

function metadata(value?: Readonly<Record<string, JsonValue>>): Record<string, Record<string, JsonValue>> | undefined {
  if (!value) return undefined;
  const options: Record<string, Record<string, JsonValue>> = {};
  for (const [provider, providerValue] of Object.entries(value)) {
    if (provider === "anthropicContent" || provider === "reasoningContent") continue;
    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue))
      throw new FrameworkError("MODEL_METADATA", "Invalid provider continuation metadata.");
    options[provider] = providerValue;
  }
  return options;
}

const legacyBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string() }),
  z.object({ type: z.literal("redacted_thinking"), data: z.string() }),
  z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.json() }),
]);

/** Migrate persisted provider-native history once, before display or SDK message conversion. */
export function normalizeModelMessage(message: AgentMessage): AgentMessage {
  if (message.role !== "assistant" || message.parts.some((part) => part.type === "thinking")) return message;
  if (!message.metadata?.anthropicContent) {
    const reasoning = message.metadata?.reasoningContent;
    if (typeof reasoning !== "string" || !reasoning) return message;
    return { ...message, parts: [{ id: "thinking", type: "thinking", text: reasoning }, ...message.parts] };
  }
  const parsed = z.array(legacyBlock).safeParse(message.metadata.anthropicContent);
  if (!parsed.success) throw new FrameworkError("MODEL_METADATA", "Invalid provider continuation metadata.");
  const parts = parsed.data.map((block, index): MessagePart => {
    switch (block.type) {
      case "text":
        return { id: "text-" + index, type: "text", text: block.text };
      case "thinking":
        return {
          id: "thinking-" + index,
          type: "thinking",
          text: block.thinking,
          metadata: { anthropic: { signature: block.signature } },
        };
      case "redacted_thinking":
        return {
          id: "thinking-" + index,
          type: "thinking",
          text: "",
          metadata: { anthropic: { redactedData: block.data } },
        };
      case "tool_use":
        return { type: "tool-call", callId: block.id, name: block.name, input: block.input };
    }
  });
  return { ...message, parts };
}

export async function modelMessages(
  messages: readonly AgentMessage[],
  resolveImageUrl?: (uri: string) => Promise<string>,
): Promise<ModelMessage[]> {
  return Promise.all(
    messages.map(async (original): Promise<ModelMessage> => {
      const message = normalizeModelMessage(original);
      const providerOptions = metadata(message.metadata);
      if (message.role === "system") {
        if (message.parts.some((part) => part.type !== "text"))
          throw new FrameworkError("MODEL_MESSAGE", "System messages must contain text.");
        return {
          role: "system",
          content: message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
          providerOptions,
        };
      }
      if (message.role === "user") {
        const content: UserContent = [];
        for (const part of message.parts) {
          if (part.type === "text") content.push({ type: "text", text: part.text });
          else if (part.type === "source")
            content.push({
              type: "text",
              text: "[Source " + part.id + "] " + part.uri,
            });
          else if (part.type === "image")
            content.push({
              type: "file",
              data: new URL(resolveImageUrl ? await resolveImageUrl(part.reference.uri) : part.reference.uri),
              mediaType: part.reference.mediaType,
            });
          else if (part.type === "file")
            content.push({
              type: "file",
              data: new URL(part.reference.uri),
              mediaType: part.reference.mediaType,
            });
          else throw new FrameworkError("MODEL_MESSAGE", "User message contains a tool operation.");
        }
        return { role: "user", content, providerOptions };
      }
      if (message.role === "assistant") {
        const content: AssistantContent = [];
        for (const part of message.parts) {
          if (part.type === "text")
            content.push({ type: "text", text: part.text, providerOptions: metadata(part.metadata) });
          else if (part.type === "thinking")
            content.push({ type: "reasoning", text: part.text, providerOptions: metadata(part.metadata) });
          else if (part.type === "tool-call")
            content.push({
              type: "tool-call",
              toolCallId: part.callId,
              toolName: part.name,
              input: part.input,
              providerOptions: metadata(part.metadata),
            });
          else throw new FrameworkError("MODEL_MESSAGE", "Unsupported assistant content for this protocol.");
        }
        return { role: "assistant", content, providerOptions };
      }
      const content: ToolContent = [];
      for (const part of message.parts) {
        if (part.type !== "tool-result")
          throw new FrameworkError("MODEL_MESSAGE", "Tool message requires paired results.");
        content.push({
          type: "tool-result",
          toolCallId: part.callId,
          toolName: part.name,
          output: {
            type: part.status === "succeeded" ? "json" : "error-json",
            value: part.value,
          },
        });
      }
      return { role: "tool", content, providerOptions };
    }),
  );
}
