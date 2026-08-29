import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { buildApp } from "./app/app.js";
import { createMemoryStore } from "./store.js";
import { createPendingDecisions } from "./modules/decision/pending-decisions.js";
import { createRunnerRegistry } from "./modules/runner/registry.js";
import { createEventHub } from "./modules/runtime/event-hub.js";
import { createCredentialCipher } from "./modules/model-config/credential.js";
import { createMemoryModelConfigStore } from "./modules/model-config/model-config.store.js";

const output = process.argv[2];
if (!output) throw new Error("Usage: pnpm openapi:export <output-path>");

const events = createEventHub();
const store = createMemoryStore();
const app = await buildApp(
  {
    store,
    events,
    decisions: createPendingDecisions(events),
    runners: createRunnerRegistry(store),
    runnerEndpoint: "http://127.0.0.1:50051",
    modelConfigStore: createMemoryModelConfigStore(),
    credentialCipher: createCredentialCipher(Buffer.alloc(32).toString("base64url")),
    verifyAccessToken: async () => ({
      casdoorId: "openapi",
      username: "openapi",
      displayName: "OpenAPI",
      role: "",
      isAdmin: false,
      isActive: true,
    }),
    runtimes: {
      async send() {},
      async abort() {},
      invalidate() {},
    },
    authService: {
      async verifyAccessToken() {
        return null;
      },
      async createAuthorizeUrl() {
        return { url: "https://auth.example.com/login" };
      },
    },
    uploadStorage: {
      async ensureBucket() {},
      async createUpload() {
        return {
          upload: "https://storage.example.com/uploads/openapi/example.txt?upload=1",
          download: "https://storage.example.com/uploads/openapi/example.txt?download=1",
        };
      },
      async putFile() {
        return { download: "https://storage.example.com/uploads/openapi/example.txt?download=1" };
      },
    },
  },
  false,
);

try {
  const response = await app.inject({
    method: "GET",
    url: "/api/openapi.json",
    headers: { authorization: "Bearer codegen" },
  });
  if (response.statusCode !== 200) throw new Error(`OpenAPI export failed with ${response.statusCode}`);
  const document = normalizeNullableSchemas(response.json());
  await writeFile(resolve(process.cwd(), output), `${JSON.stringify(document, null, 2)}\n`, "utf8");
} finally {
  await app.close();
}

function normalizeNullableSchemas(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNullableSchemas);
  if (!isRecord(value)) return value;

  const variants = value.anyOf;
  if (Array.isArray(variants) && variants.length === 2) {
    const nullableIndex = variants.findIndex(isNullableOnlySchema);
    if (nullableIndex !== -1) {
      const schema = normalizeNullableSchemas(variants[nullableIndex === 0 ? 1 : 0]);
      return isRecord(schema) ? { ...schema, nullable: true } : schema;
    }
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeNullableSchemas(item)]));
}

function isNullableOnlySchema(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.nullable === true &&
    Array.isArray(value.enum) &&
    value.enum.length === 1 &&
    value.enum[0] === null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
