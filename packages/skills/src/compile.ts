import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import { parseSkillDocument, type SkillAction, type SkillConnection, type SkillDocument, type SkillResource } from "./schema.js";

export interface CompiledSkillAction {
  readonly skillId: string;
  readonly skillVersion: string;
  readonly toolName: string;
  readonly action: SkillAction;
  readonly validateInput: ValidateFunction;
  readonly validateOutput?: ValidateFunction;
}

export interface CompiledSkill {
  readonly document: SkillDocument;
  readonly checksum: string;
  readonly connections: ReadonlyMap<string, SkillConnection>;
  readonly resources: ReadonlyMap<string, SkillResource>;
  readonly actions: ReadonlyMap<string, CompiledSkillAction>;
}

export interface CompiledSkills {
  readonly skills: ReadonlyMap<string, CompiledSkill>;
  readonly actions: ReadonlyMap<string, CompiledSkillAction>;
  readonly catalog: readonly { id: string; version: string; name: string; description: string; activation: SkillDocument["activation"] }[];
}

export class SkillCompileError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "SkillCompileError";
  }
}

const require = createRequire(import.meta.url);
const addFormats = (require("ajv-formats").default ?? require("ajv-formats")) as FormatsPlugin;

export function compileSkill(input: unknown): CompiledSkill {
  const document = parseSkillDocument(input);
  const connections = uniqueMap(document.connections, item => item.id, "connection");
  const resources = uniqueMap(document.resources, item => item.id, "resource");
  const actionIds = new Set<string>();
  const actionNames = new Set<string>();
  const actions = new Map<string, CompiledSkillAction>();
  const ajv = createAjv();

  for (const resource of document.resources) {
    if (resource.content.kind !== "inline" || resource.sha256 === undefined) continue;
    const data = resource.content.encoding === "utf8"
      ? Buffer.from(resource.content.data, "utf8")
      : Buffer.from(resource.content.data, "base64");
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== resource.sha256) throw new SkillCompileError("inline resource checksum does not match content", `resources.${resource.id}`);
  }

  for (const action of document.actions) {
    unique(actionIds, action.id, "action id");
    unique(actionNames, action.name, "action name");
    for (const connectionId of action.runtime.capabilities.http) {
      if (!connections.has(connectionId)) throw new SkillCompileError(`unknown HTTP connection: ${connectionId}`, `actions.${action.id}`);
    }
    for (const resourceId of action.runtime.capabilities.resources) {
      if (!resources.has(resourceId)) throw new SkillCompileError(`unknown resource: ${resourceId}`, `actions.${action.id}`);
    }
    validateVmSource(action.runtime.source, `${document.id}/${action.id}.js`);
    const toolName = `skill__${document.id.replaceAll("-", "_")}__${action.name}`;
    const validateInput = compileJsonSchema(ajv, action.inputSchema, `${document.id}/${action.id}/inputSchema`);
    const validateOutput = action.outputSchema === undefined
      ? undefined
      : compileJsonSchema(ajv, action.outputSchema, `${document.id}/${action.id}/outputSchema`);
    actions.set(action.id, Object.freeze({
      skillId: document.id,
      skillVersion: document.version,
      toolName,
      action,
      validateInput,
      ...(validateOutput ? { validateOutput } : {}),
    }));
  }

  return Object.freeze({
    document: deepFreeze(document),
    checksum: createHash("sha256").update(canonicalJson(document)).digest("hex"),
    connections,
    resources,
    actions,
  });
}

export function compileSkills(inputs: readonly unknown[]): CompiledSkills {
  const skills = new Map<string, CompiledSkill>();
  const actions = new Map<string, CompiledSkillAction>();
  for (const input of inputs) {
    const skill = compileSkill(input);
    unique(skills, skill.document.id, "skill id", skill);
    for (const action of skill.actions.values()) unique(actions, action.toolName, "tool name", action);
  }
  const catalog = [...skills.values()].map(skill => Object.freeze({
    id: skill.document.id,
    version: skill.document.version,
    name: skill.document.name,
    description: skill.document.description,
    activation: skill.document.activation,
  }));
  return Object.freeze({ skills, actions, catalog: Object.freeze(catalog) });
}

export function validationMessage(validate: ValidateFunction): string {
  return formatAjvErrors(validate.errors);
}

function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

function compileJsonSchema(ajv: Ajv, schema: object, path: string): ValidateFunction {
  try {
    return ajv.compile(schema);
  } catch (error) {
    throw new SkillCompileError(error instanceof Error ? error.message : String(error), path);
  }
}

function validateVmSource(source: string, filename: string): void {
  try {
    new Script(`(${source})`, { filename });
  } catch (error) {
    throw new SkillCompileError(error instanceof Error ? error.message : String(error), filename);
  }
}

function uniqueMap<T>(items: readonly T[], key: (item: T) => string, kind: string): ReadonlyMap<string, T> {
  const values = new Map<string, T>();
  for (const item of items) unique(values, key(item), kind, item);
  return values;
}

function unique<T>(target: Set<string> | Map<string, T>, key: string, kind: string, value?: T): void {
  if (target.has(key)) throw new SkillCompileError(`duplicate ${kind}: ${key}`);
  if (target instanceof Set) target.add(key);
  else target.set(key, value as T);
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "validation failed";
  return errors.map(error => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
