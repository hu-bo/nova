import type { AssistantContent, ModelMessage, UserContent, ToolContent } from "ai";
import type { AgentMessage, JsonValue } from "../../contracts/message.js";
import { FrameworkError } from "../../contracts/errors.js";
function metadata(message: AgentMessage): Record<string, Record<string, JsonValue>> | undefined {
  if (!message.metadata) return undefined;
  const options: Record<string, Record<string, JsonValue>> = {};
  for (const [provider, value] of Object.entries(message.metadata)) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new FrameworkError("MODEL_METADATA", "Invalid provider continuation metadata.");
    options[provider] = value;
  }
  return options;
}
export function modelMessages(messages: readonly AgentMessage[]): ModelMessage[] {
  return messages.map((message) => {
    const providerOptions = metadata(message);
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
            type: "image",
            image: new URL(part.reference.uri),
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
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "thinking") content.push({ type: "reasoning", text: part.text });
        else if (part.type === "tool-call")
          content.push({
            type: "tool-call",
            toolCallId: part.callId,
            toolName: part.name,
            input: part.input,
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
  });
}
