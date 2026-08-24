import { z, type ZodType } from "zod";
import type { JSONSchema } from "./types.js";

export { z };
export type { ZodType };

export function toolParameters(schema: ZodType): JSONSchema {
  const parameters = z.toJSONSchema(schema) as JSONSchema;
  if (!parameters.type && objectBranches(parameters)) {
    parameters.type = "object";
  }
  return parameters;
}

function objectBranches(schema: JSONSchema): boolean {
  const branches = schema.anyOf ?? schema.oneOf;
  return (
    Array.isArray(branches) &&
    branches.length > 0 &&
    branches.every(
      (branch) => typeof branch === "object" && branch !== null && (branch as JSONSchema).type === "object",
    )
  );
}
