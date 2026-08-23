import { z } from "zod";

export const SKILL_FORMAT = "nova.skill/v1" as const;

const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase kebab-case").max(64);
const actionName = z.string().regex(/^[a-z][a-z0-9_]*$/, "must be lower snake_case").max(64);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const jsonSchema = z.record(z.string(), z.unknown()).refine(value => value.type !== undefined, {
  message: "JSON Schema must declare type",
});

export const skillActivationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("always") }).strict(),
  z.object({
    mode: z.literal("auto"),
    keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
  }).strict(),
  z.object({ mode: z.literal("manual") }).strict(),
]);

export const skillConnectionSchema = z.object({
  id,
  kind: z.literal("http"),
  baseUrl: z.url(),
  allowedMethods: z.array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])).min(1),
  allowedPathPrefixes: z.array(z.string().startsWith("/").max(256)).min(1),
  auth: z.object({
    kind: z.literal("server-connection"),
    ref: z.string().min(1).max(128),
  }).strict().optional(),
}).strict();

const inlineContent = z.object({
  kind: z.literal("inline"),
  encoding: z.enum(["utf8", "base64"]),
  data: z.string(),
}).strict();

const objectContent = z.object({
  kind: z.literal("object"),
  key: z.string().min(1).max(1024),
  sha256,
  size: z.number().int().nonnegative(),
}).strict();

export const skillResourceSchema = z.object({
  id,
  path: z.string().min(1).max(512),
  kind: z.enum(["reference", "asset", "script", "other"]),
  mediaType: z.string().min(1).max(128),
  executable: z.boolean().optional(),
  content: z.discriminatedUnion("kind", [inlineContent, objectContent]),
  sha256: sha256.optional(),
}).strict();

export const skillActionSchema = z.object({
  id,
  name: actionName,
  description: z.string().min(1).max(1024),
  risk: z.enum(["none", "read", "write", "exec"]),
  executionMode: z.enum(["parallel", "sequential"]).default("parallel"),
  inputSchema: jsonSchema,
  outputSchema: jsonSchema.optional(),
  runtime: z.object({
    kind: z.literal("vm-js"),
    timeoutMs: z.number().int().min(1).max(60_000).default(5_000),
    capabilities: z.object({
      http: z.array(id).max(32).default([]),
      resources: z.array(id).max(64).default([]),
    }).strict(),
    source: z.string().min(1).max(64 * 1024),
  }).strict(),
}).strict();

const skillSourceSchema = z.object({
  kind: z.enum(["native", "agent-skills-zip", "generated"]),
  uri: z.string().min(1).max(2048).optional(),
  allowedTools: z.string().max(4096).optional(),
  importedMetadata: z.record(z.string(), z.string()).optional(),
}).strict();

export const skillDocumentSchema = z.object({
  format: z.literal(SKILL_FORMAT),
  id,
  version: z.string().min(1).max(64),
  name: id,
  description: z.string().min(1).max(1024),
  activation: skillActivationSchema,
  instructions: z.object({ markdown: z.string().min(1).max(256 * 1024) }).strict(),
  connections: z.array(skillConnectionSchema).max(32).default([]),
  resources: z.array(skillResourceSchema).max(256).default([]),
  actions: z.array(skillActionSchema).max(64).default([]),
  metadata: z.record(z.string(), z.string()).default({}),
  source: skillSourceSchema,
}).strict().superRefine((skill, context) => {
  if (skill.id !== skill.name) {
    context.addIssue({ code: "custom", path: ["name"], message: "name must equal id" });
  }
  for (const resource of skill.resources) {
    if (!safeRelativePath(resource.path)) {
      context.addIssue({ code: "custom", path: ["resources", skill.resources.indexOf(resource), "path"], message: "must be a safe relative path" });
    }
    if (resource.content.kind === "inline" && resource.content.encoding === "base64" && !validBase64(resource.content.data)) {
      context.addIssue({ code: "custom", path: ["resources", skill.resources.indexOf(resource), "content", "data"], message: "must be canonical base64" });
    }
  }
  for (const connection of skill.connections) {
    const url = new URL(connection.baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      context.addIssue({ code: "custom", path: ["connections", skill.connections.indexOf(connection), "baseUrl"], message: "must use HTTPS" });
    }
    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({ code: "custom", path: ["connections", skill.connections.indexOf(connection), "baseUrl"], message: "must not contain credentials, query, or fragment" });
    }
  }
});

export type SkillDocument = z.output<typeof skillDocumentSchema>;
export type SkillDocumentInput = z.input<typeof skillDocumentSchema>;
export type SkillActivation = z.output<typeof skillActivationSchema>;
export type SkillConnection = z.output<typeof skillConnectionSchema>;
export type SkillResource = z.output<typeof skillResourceSchema>;
export type SkillAction = z.output<typeof skillActionSchema>;
export type SkillRisk = SkillAction["risk"];

export function parseSkillDocument(input: unknown): SkillDocument {
  return skillDocumentSchema.parse(input);
}

export function safeRelativePath(path: string): boolean {
  if (!path || path.includes("\0")) return false;
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  return normalized.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function validBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}
