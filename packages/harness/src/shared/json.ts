import { FrameworkError } from "../contracts/errors.js";
import type { JsonValue } from "../contracts/message.js";
export function jsonValue(value: unknown, maxBytes = 1_000_000): JsonValue {
  const seen = new Set<object>();
  function validate(input: unknown, depth: number): input is JsonValue {
    if (depth > 64) return false;
    if (input === null || typeof input === "string" || typeof input === "boolean") return true;
    if (typeof input === "number") return Number.isFinite(input);
    if (typeof input !== "object" || seen.has(input)) return false;
    seen.add(input);
    const valid = Array.isArray(input)
      ? input.every((item) => validate(item, depth + 1))
      : (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null) &&
        Object.entries(input).every(
          ([key, item]) => !["__proto__", "prototype", "constructor"].includes(key) && validate(item, depth + 1),
        );
    seen.delete(input);
    return valid;
  }
  if (!validate(value, 0) || Buffer.byteLength(JSON.stringify(value)) > maxBytes)
    throw new FrameworkError("INVALID_INPUT", "Expected bounded, serializable JSON data.");
  return structuredClone(value);
}
export function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical(value[key] ?? null))
      .join(",") +
    "}"
  );
}
export function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new FrameworkError("INVALID_CONFIG", name + " must be a positive integer.");
  return value;
}
