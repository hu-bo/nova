import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { serverRoot } from "../paths.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const packageRoot = serverRoot;
const output = process.argv[2]
  ? isAbsolute(process.argv[2])
    ? process.argv[2]
    : resolve(packageRoot, process.argv[2])
  : resolve(packageRoot, "openapi.json");

async function main(): Promise<void> {
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
    await writeFile(temporaryOutput, `${JSON.stringify(document, null, 2)}\n`, "utf8");
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
