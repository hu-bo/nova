import { DshAgentError, type ModelConfig, type ReasoningEffort } from "./contracts.js";
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["off", "low", "medium", "high"];
export const protocol = {
  anthropic: "anthropic-messages",
  "openai-chat": "openai-completions",
  "openai-responses": "openai-responses",
} as const;
export function fail(code: string, message: string): never {
  throw new DshAgentError(code, message);
}
export function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    fail("INVALID_CONFIG", `${name} must be a positive safe timer-sized integer`);
}
export function modelSnapshot(model: ModelConfig): ModelConfig {
  if (!model.id?.trim() || !model.model?.trim() || !model.apiKey?.trim() || !Object.hasOwn(protocol, model.protocol))
    fail("INVALID_CONFIG", "Model id, model, apiKey and supported protocol are required");
  let url: URL;
  try {
    url = new URL(model.baseURL);
  } catch {
    return fail("INVALID_CONFIG", "Invalid model baseURL");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    fail("INVALID_CONFIG", "Expected HTTP(S) baseURL without embedded credentials");
  positive(model.contextWindow, "contextWindow");
  if (model.reasoning !== undefined && !REASONING_EFFORTS.includes(model.reasoning))
    fail("INVALID_CONFIG", `reasoning must be one of ${REASONING_EFFORTS.join(" | ")}`);
  const maxOutputTokens = model.maxOutputTokens ?? Math.min(4096, Math.floor(model.contextWindow / 4));
  positive(maxOutputTokens, "maxOutputTokens");
  if (maxOutputTokens >= model.contextWindow)
    fail("INVALID_CONFIG", "maxOutputTokens must be smaller than contextWindow");
  return Object.freeze({ ...model, maxOutputTokens });
}
