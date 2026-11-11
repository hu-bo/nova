import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { serverRoot } from "../paths.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { z } from "zod";

const packageRoot = serverRoot;
const argument = process.argv[2];
const mode = process.argv[3];
let output = resolve(packageRoot, "openapi.json");
if (argument) output = isAbsolute(argument) ? argument : resolve(packageRoot, argument);

const jsonObject = z.record(z.string(), z.unknown());
const snapshotSchema = z
  .object({
    openapi: z.string(),
    paths: z.record(z.string(), jsonObject),
    components: z.record(z.string(), jsonObject).optional(),
  })
  .passthrough();
const httpMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

async function modelConsoleSnapshot(document: unknown) {
  const current = snapshotSchema.parse(JSON.parse(await readFile(output, "utf8")));
  const source = snapshotSchema.parse(document);
  for (const [path, item] of Object.entries(source.paths)) {
    if (!path.startsWith("/admin/model-config/")) continue;
    const projected = structuredClone(item);
    for (const [method, value] of Object.entries(projected)) {
      if (!httpMethods.has(method)) continue;
      const operation = jsonObject.parse(value);
      const responses = jsonObject.parse(operation.responses);
      for (const [status, responseValue] of Object.entries(responses)) {
        if (!/^2\d\d$/.test(status)) continue;
        const response = jsonObject.parse(responseValue);
        if (response.content === undefined) continue;
        const content = jsonObject.parse(response.content);
        const media = jsonObject.parse(content["application/json"]);
        const envelope = jsonObject.parse(media.schema);
        const properties = jsonObject.parse(envelope.properties);
        const code = jsonObject.parse(properties.code);
        const successCode =
          code.const === 200 || (Array.isArray(code.enum) && code.enum.length === 1 && code.enum[0] === 200);
        if (!successCode || !("data" in properties))
          throw new Error(`Expected a success envelope for ${method.toUpperCase()} ${path} (${status})`);
        // apiMutator unwraps the transport envelope; generated callers receive only its data.
        media.schema = properties.data;
        content["application/json"] = media;
        response.content = content;
        responses[status] = response;
      }
      operation.responses = responses;
      projected[method] = operation;
    }
    current.paths[path] = projected;
  }
  const components = current.components ?? {};
  for (const [name, definitions] of Object.entries(source.components ?? {}))
    components[name] = { ...components[name], ...definitions };
  current.components = components;
  return current;
}

async function main(): Promise<void> {
  if (process.argv.length > 4 || (mode !== undefined && mode !== "--model-console") || argument?.startsWith("--"))
    throw new Error("Usage: openapi-export.ts [output-path] [--model-console]");
  const config = loadConfig({
    DATABASE_URL: "postgresql://postgres@localhost:5432/app",
    LOG_LEVEL: "silent",
  });
  const app = await buildApp(config, { exportMode: true });
  const temporaryOutput = `${output}.${randomUUID()}.tmp`;
  try {
    await app.ready();
    const document = app.swagger();
    const requiredPaths: readonly string[] = [
      "/api/projects/",
      "/api/conversations/",
      "/api/attachments/uploads",
      "/api/runner-tokens",
      "/api/runners",
      "/api/conversations/{id}/snapshot",
      "/api/conversations/{id}/inputs",
      "/api/conversations/{id}/events",
      "/api/runs/{id}/cancel",
      "/api/runs/{id}/interactions/{interactionId}/respond",
      "/admin/model-config/providers",
      "/admin/model-config/providers/{providerId}",
      "/admin/model-config/models",
      "/admin/model-config/models/{modelId}",
    ];
    for (const path of requiredPaths) {
      if (!document.paths?.[path]) {
        throw new Error(`OpenAPI document is missing required path: ${path}`);
      }
    }
    await mkdir(dirname(output), { recursive: true });
    const exported = mode === "--model-console" ? await modelConsoleSnapshot(document) : document;
    await writeFile(temporaryOutput, `${JSON.stringify(exported, null, 2)}\n`, "utf8");
    await rename(temporaryOutput, output);
  } finally {
    try {
      await app.close();
    } finally {
      await rm(temporaryOutput, { force: true });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
