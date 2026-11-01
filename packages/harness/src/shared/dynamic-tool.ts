import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "../contracts/message.js";
import type { ToolDefinition, ToolInput } from "../contracts/tool.js";
import { FrameworkError } from "../contracts/errors.js";
import { jsonValue } from "./json.js";

export type JsonSchemaType = "null" | "boolean" | "number" | "integer" | "string" | "array" | "object";

export interface JsonSchema {
  readonly $ref?: never;
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly description?: string;
}

const supportedKeywords = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "description",
]);
const schemaTypes = new Set<JsonSchemaType>(["null", "boolean", "number", "integer", "string", "array", "object"]);

function schemaError(message: string): never {
  throw new FrameworkError("INVALID_SCHEMA", message);
}

function validateSchema(schema: JsonSchema, depth: number): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) schemaError("A JSON Schema object is required.");
  if (depth > 16) schemaError("JSON Schema nesting is too deep.");
  for (const key of Object.keys(schema))
    if (!supportedKeywords.has(key)) schemaError("JSON Schema keyword is not supported: " + key);
  if (schema.type !== undefined) {
    const types: readonly JsonSchemaType[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || new Set(types).size !== types.length || types.some((type) => !schemaTypes.has(type)))
      schemaError("JSON Schema type is invalid.");
  }
  if (schema.properties !== undefined) {
    if (typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties))
      schemaError("JSON Schema properties must be an object.");
    for (const [name, child] of Object.entries(schema.properties)) {
      if (!name || name === "__proto__" || name === "prototype" || name === "constructor")
        schemaError("Invalid JSON Schema property name.");
      validateSchema(child, depth + 1);
    }
  }
  if (schema.items !== undefined) validateSchema(schema.items, depth + 1);
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some(
        (name) => typeof name !== "string" || !name || ["__proto__", "prototype", "constructor"].includes(name),
      ) ||
      new Set(schema.required).size !== schema.required.length
    )
      schemaError("JSON Schema required is invalid.");
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean")
    schemaError("JSON Schema additionalProperties is invalid.");
  if (schema.enum !== undefined) {
    if (!schema.enum.length) schemaError("JSON Schema enum cannot be empty.");
    for (const value of schema.enum) jsonValue(value, 100_000);
  }
  if (schema.const !== undefined) jsonValue(schema.const, 100_000);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string" || schema.pattern.length > 4_096)
      schemaError("JSON Schema pattern is invalid.");
    try {
      new RegExp(schema.pattern);
    } catch {
      schemaError("JSON Schema pattern is invalid.");
    }
  }
  if (
    schema.description !== undefined &&
    (typeof schema.description !== "string" || schema.description.length > 16_384)
  )
    schemaError("JSON Schema description is invalid.");
  const integerKeywords = [
    ["minItems", schema.minItems],
    ["maxItems", schema.maxItems],
    ["minLength", schema.minLength],
    ["maxLength", schema.maxLength],
  ] as const;
  for (const [name, value] of integerKeywords)
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      schemaError("JSON Schema " + name + " is invalid.");
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems)
    schemaError("JSON Schema item bounds are invalid.");
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength)
    schemaError("JSON Schema length bounds are invalid.");
  const numericKeywords = [
    ["minimum", schema.minimum],
    ["maximum", schema.maximum],
    ["exclusiveMinimum", schema.exclusiveMinimum],
    ["exclusiveMaximum", schema.exclusiveMaximum],
  ] as const;
  for (const [name, value] of numericKeywords)
    if (value !== undefined && !Number.isFinite(value)) schemaError("JSON Schema " + name + " is invalid.");
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum)
    schemaError("JSON Schema numeric bounds are invalid.");
  if (
    schema.exclusiveMinimum !== undefined &&
    schema.exclusiveMaximum !== undefined &&
    schema.exclusiveMinimum >= schema.exclusiveMaximum
  )
    schemaError("JSON Schema exclusive bounds are invalid.");
}

function matchesType(value: JsonValue, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

function validateValue(value: JsonValue, schema: JsonSchema, path: string, depth: number): void {
  if (depth > 64) throw new FrameworkError("INVALID_TOOL_INPUT", "JSON value is too deeply nested.");
  if (schema.type !== undefined) {
    const types: readonly JsonSchemaType[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type)))
      throw new FrameworkError("INVALID_TOOL_INPUT", "Value does not match schema at " + path + ".");
  }
  if (schema.enum && !schema.enum.some((candidate) => isDeepStrictEqual(candidate, value)))
    throw new FrameworkError("INVALID_TOOL_INPUT", "Value is not an allowed enum member at " + path + ".");
  if (schema.const !== undefined && !isDeepStrictEqual(schema.const, value))
    throw new FrameworkError("INVALID_TOOL_INPUT", "Value does not match const at " + path + ".");
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      throw new FrameworkError("INVALID_TOOL_INPUT", "String is shorter than allowed at " + path + ".");
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      throw new FrameworkError("INVALID_TOOL_INPUT", "String is longer than allowed at " + path + ".");
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
      throw new FrameworkError("INVALID_TOOL_INPUT", "String does not match schema at " + path + ".");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      throw new FrameworkError("INVALID_TOOL_INPUT", "Number is below minimum at " + path + ".");
    if (schema.maximum !== undefined && value > schema.maximum)
      throw new FrameworkError("INVALID_TOOL_INPUT", "Number is above maximum at " + path + ".");
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
      throw new FrameworkError("INVALID_TOOL_INPUT", "Number is not above exclusive minimum at " + path + ".");
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)
      throw new FrameworkError("INVALID_TOOL_INPUT", "Number is not below exclusive maximum at " + path + ".");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      throw new FrameworkError("INVALID_TOOL_INPUT", "Array is shorter than allowed at " + path + ".");
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      throw new FrameworkError("INVALID_TOOL_INPUT", "Array is longer than allowed at " + path + ".");
    const itemSchema = schema.items;
    if (itemSchema) value.forEach((item, index) => validateValue(item, itemSchema, `${path}[${index}]`, depth + 1));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? [])
      if (!Object.hasOwn(value, name))
        throw new FrameworkError("INVALID_TOOL_INPUT", "Missing required property at " + path + ".");
    for (const [name, child] of Object.entries(properties))
      if (Object.hasOwn(value, name)) validateValue(value[name] ?? null, child, path + "." + name, depth + 1);
    if (schema.additionalProperties !== true)
      for (const name of Object.keys(value))
        if (!Object.hasOwn(properties, name))
          throw new FrameworkError("INVALID_TOOL_INPUT", "Unknown property at " + path + ".");
  }
}

export function defineDynamicTool(
  definition: Omit<ToolInput<JsonValue, JsonValue>, "inputSchema" | "outputSchema"> & {
    inputSchema: JsonSchema;
    outputSchema?: JsonSchema;
  },
): ToolDefinition {
  if (
    typeof definition.name !== "string" ||
    typeof definition.description !== "string" ||
    !/^[a-zA-Z][\w.-]*$/.test(definition.name) ||
    !definition.description.trim()
  )
    throw new FrameworkError("INVALID_TOOL", "Dynamic tool metadata is invalid.");
  const inputSchemaDefinition = structuredClone(definition.inputSchema);
  validateSchema(inputSchemaDefinition, 0);
  const outputSchema = structuredClone(definition.outputSchema ?? {});
  validateSchema(outputSchema, 0);
  const inputSchema = z.custom<JsonValue>((value) => {
    try {
      validateValue(jsonValue(value), inputSchemaDefinition, "$", 0);
      return true;
    } catch {
      return false;
    }
  });
  const resultSchema = z.custom<JsonValue>((value) => {
    try {
      validateValue(jsonValue(value), outputSchema, "$", 0);
      return true;
    } catch {
      return false;
    }
  });
  const prepare = (input: unknown) => {
    const parsed = jsonValue(input);
    validateValue(parsed, inputSchemaDefinition, "$", 0);
    return {
      input: parsed,
      execute: async (context: Parameters<ToolDefinition["execute"]>[1]) => {
        const output = await definition.execute(parsed, context);
        const checked = jsonValue(output);
        validateValue(checked, outputSchema, "$", 0);
        return checked;
      },
    };
  };
  return {
    ...definition,
    inputSchema,
    outputSchema: resultSchema,
    inputSchemaJson: jsonValue(inputSchemaDefinition),
    outputSchemaJson: jsonValue(outputSchema),
    prepare,
    execute: (input, context) => prepare(input).execute(context),
  };
}
