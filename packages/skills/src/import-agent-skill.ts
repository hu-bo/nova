import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import { readSkillZip, type ArchiveFile, type ArchiveLimits } from "./archive.js";
import { SKILL_FORMAT, parseSkillDocument, type SkillDocument, type SkillResource } from "./schema.js";

export interface ImportAgentSkillOptions {
  sourceUri?: string;
  archiveLimits?: ArchiveLimits;
}

export class SkillImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillImportError";
  }
}

const frontmatterSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    description: z.string().min(1).max(1024),
    license: z.string().min(1).optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().optional(),
  })
  .passthrough();

export function importAgentSkillZip(input: Uint8Array, options: ImportAgentSkillOptions = {}): SkillDocument {
  return importAgentSkillFiles(readSkillZip(input, options.archiveLimits), options);
}

export function importAgentSkillFiles(
  files: readonly ArchiveFile[],
  options: ImportAgentSkillOptions = {},
): SkillDocument {
  const manifests = files.filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"));
  if (manifests.length !== 1)
    throw new SkillImportError(`archive must contain exactly one SKILL.md; found ${manifests.length}`);
  const manifest = manifests[0]!;
  const root = manifest.path === "SKILL.md" ? "" : manifest.path.slice(0, -"SKILL.md".length);
  const text = decodeUtf8(manifest.data, manifest.path);
  const { frontmatter, markdown } = splitSkillMarkdown(text);
  const yaml = parseDocument(frontmatter, { uniqueKeys: true });
  if (yaml.errors.length > 0)
    throw new SkillImportError(`invalid SKILL.md frontmatter: ${yaml.errors.map((error) => error.message).join("; ")}`);
  const parsed = frontmatterSchema.safeParse(yaml.toJSON());
  if (!parsed.success)
    throw new SkillImportError(
      `invalid SKILL.md frontmatter: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  const metadata = parsed.data;
  if (root) {
    const directoryName = root.slice(0, -1).split("/").at(-1);
    if (directoryName !== metadata.name)
      throw new SkillImportError(`SKILL.md name must match its parent directory: ${directoryName}`);
  }

  const resources: SkillResource[] = [];
  const resourceIds = new Set<string>();
  for (const file of files) {
    if (file.path === manifest.path || !file.path.startsWith(root)) continue;
    const relative = file.path.slice(root.length);
    if (!relative) continue;
    const resourceId = uniqueResourceId(relative, resourceIds);
    const encoded = encodeContent(file.data, relative);
    resources.push({
      id: resourceId,
      path: relative,
      kind: resourceKind(relative),
      mediaType: mediaType(relative),
      ...(relative.startsWith("scripts/") ? { executable: true } : {}),
      content: encoded,
      sha256: createHash("sha256").update(file.data).digest("hex"),
    });
  }

  const importedMetadata: Record<string, string> = { ...(metadata.metadata ?? {}) };
  for (const [key, value] of Object.entries(metadata)) {
    if (["name", "description", "license", "compatibility", "metadata", "allowed-tools"].includes(key)) continue;
    if (typeof value === "string") importedMetadata[`frontmatter.${key}`] = value;
  }
  const version = metadata.metadata?.version || "0.0.0-imported";
  const document = {
    format: SKILL_FORMAT,
    id: metadata.name,
    version,
    name: metadata.name,
    description: metadata.description,
    activation: { mode: "auto" as const },
    instructions: { markdown },
    connections: [],
    resources,
    actions: [],
    metadata: {
      ...(metadata.license ? { license: metadata.license } : {}),
      ...(metadata.compatibility ? { compatibility: metadata.compatibility } : {}),
      ...metadata.metadata,
    },
    source: {
      kind: "agent-skills-zip" as const,
      ...(options.sourceUri ? { uri: options.sourceUri } : {}),
      ...(metadata["allowed-tools"] ? { allowedTools: metadata["allowed-tools"] } : {}),
      ...(Object.keys(importedMetadata).length ? { importedMetadata } : {}),
    },
  };
  return parseSkillDocument(document);
}

function splitSkillMarkdown(source: string): { frontmatter: string; markdown: string } {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new SkillImportError("SKILL.md must start with YAML frontmatter");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new SkillImportError("SKILL.md frontmatter is not closed");
  const frontmatter = normalized.slice(4, end);
  const markdown = normalized.slice(end + 5).trim();
  if (!markdown) throw new SkillImportError("SKILL.md instructions must not be empty");
  return { frontmatter, markdown };
}

function uniqueResourceId(path: string, seen: Set<string>): string {
  const base =
    path
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "resource";
  let id = base;
  let suffix = 1;
  while (seen.has(id)) id = `${base.slice(0, 56)}-${suffix++}`;
  seen.add(id);
  return id;
}

function encodeContent(data: Uint8Array, path: string): SkillResource["content"] {
  try {
    return { kind: "inline", encoding: "utf8", data: new TextDecoder("utf-8", { fatal: true }).decode(data) };
  } catch {
    return { kind: "inline", encoding: "base64", data: Buffer.from(data).toString("base64") };
  }
}

function decodeUtf8(data: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new SkillImportError(`${path} must be UTF-8 text`);
  }
}

function resourceKind(path: string): SkillResource["kind"] {
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("assets/")) return "asset";
  if (path.startsWith("scripts/")) return "script";
  return "other";
}

function mediaType(path: string): string {
  const extension = path.toLowerCase().split(".").at(-1);
  return (
    (
      {
        md: "text/markdown",
        txt: "text/plain",
        json: "application/json",
        yaml: "application/yaml",
        yml: "application/yaml",
        js: "text/javascript",
        mjs: "text/javascript",
        ts: "text/typescript",
        py: "text/x-python",
        sh: "text/x-shellscript",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        svg: "image/svg+xml",
        pdf: "application/pdf",
      } as Record<string, string>
    )[extension ?? ""] ?? "application/octet-stream"
  );
}
