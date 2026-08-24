import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  SkillArchiveError,
  SkillCompileError,
  SkillRuntimeError,
  compileSkill,
  compileSkills,
  crc32,
  executeSkillAction,
  importAgentSkillFiles,
  importAgentSkillZip,
  loadBuiltinSkills,
  type ArchiveFile,
  type SkillDocumentInput,
  type SkillHost,
} from "../src/index.js";

function document(overrides: Partial<SkillDocumentInput> = {}): SkillDocumentInput {
  return {
    format: "nova.skill/v1",
    id: "weather-assistant",
    version: "1.0.0",
    name: "weather-assistant",
    description: "Queries weather when users ask about forecasts.",
    activation: { mode: "auto", keywords: ["weather"] },
    instructions: { markdown: "Call the weather action before answering." },
    connections: [
      {
        id: "weather-api",
        kind: "http",
        baseUrl: "https://weather.example.com",
        allowedMethods: ["GET"],
        allowedPathPrefixes: ["/v1/weather"],
      },
    ],
    resources: [
      {
        id: "codes",
        path: "references/codes.json",
        kind: "reference",
        mediaType: "application/json",
        content: { kind: "inline", encoding: "utf8", data: "{}" },
      },
    ],
    actions: [
      {
        id: "query-weather",
        name: "query_weather",
        description: "Query weather",
        risk: "read",
        executionMode: "parallel",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { location: { type: "string" } },
          required: ["location"],
        },
        outputSchema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        },
        runtime: {
          kind: "vm-js",
          timeoutMs: 1000,
          capabilities: { http: ["weather-api"], resources: ["codes"] },
          source:
            "async ({ input, sdk }) => { const response = await sdk.http.request('weather-api', { method: 'GET', path: '/v1/weather', query: { location: input.location } }); return { content: response.data.summary, details: response.data }; }",
        },
      },
    ],
    metadata: {},
    source: { kind: "native" },
    ...overrides,
  };
}

describe("skill schema and compiler", () => {
  it("compiles the checked-in example and produces a stable tool name", async () => {
    const source = JSON.parse(await readFile(new URL("../skills/weather-assistant.json", import.meta.url), "utf8"));
    const first = compileSkill(source);
    const second = compileSkill(source);
    expect(first.checksum).toBe(second.checksum);
    expect(first.actions.get("query-weather")?.toolName).toBe("skill__weather_assistant__query_weather");
  });

  it("loads and compiles the focused built-in coding skill set", () => {
    const builtins = loadBuiltinSkills();
    const compiled = compileSkills(builtins);
    expect(builtins).toHaveLength(6);
    expect(new Set(builtins.map((skill) => skill.id)).size).toBe(6);
    expect(builtins.filter((skill) => skill.activation.mode === "always").map((skill) => skill.id)).toEqual([
      "minimal-change-engineering",
    ]);
    expect([...compiled.actions]).toEqual([]);
  });

  it("rejects unknown capabilities and cross-skill tool collisions", () => {
    const invalid = document({
      actions: [
        {
          ...document().actions![0]!,
          runtime: { ...document().actions![0]!.runtime, capabilities: { http: ["missing"], resources: [] } },
        },
      ],
    });
    expect(() => compileSkill(invalid)).toThrow(SkillCompileError);
    expect(() => compileSkills([document(), { ...document(), version: "2.0.0" }])).toThrow(/duplicate skill id/);
  });
});

describe("skill VM runtime", () => {
  const host: SkillHost = {
    requestHttp: vi.fn(async ({ request }) => ({
      status: 200,
      data: { summary: `Sunny in ${request.query?.location}` },
    })),
    readResource: vi.fn(async () => ({ mediaType: "text/plain", data: "remote", encoding: "utf8" as const })),
  };

  it("executes a verified action through the capability host", async () => {
    const skill = compileSkill(document());
    const result = await executeSkillAction(skill, "query-weather", { location: "Shanghai" }, host, {
      trust: "verified",
    });
    expect(result).toEqual({ status: "ok", content: "Sunny in Shanghai", details: { summary: "Sunny in Shanghai" } });
    expect(host.requestHttp).toHaveBeenCalledOnce();
  });

  it("rejects untrusted execution, invalid input and undeclared paths", async () => {
    const skill = compileSkill(document());
    await expect(
      executeSkillAction(skill, "query-weather", { location: "Shanghai" }, host, { trust: "untrusted" }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_SKILL" });
    await expect(executeSkillAction(skill, "query-weather", {}, host, { trust: "verified" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    const denied = compileSkill(
      document({
        actions: [
          {
            ...document().actions![0]!,
            runtime: {
              ...document().actions![0]!.runtime,
              source:
                "async ({ sdk }) => { await sdk.http.request('weather-api', { method: 'GET', path: '/admin' }); return { content: 'bad', details: { summary: 'bad' } }; }",
            },
          },
        ],
      }),
    );
    await expect(
      executeSkillAction(denied, "query-weather", { location: "Shanghai" }, host, { trust: "verified" }),
    ).rejects.toBeInstanceOf(SkillRuntimeError);
  });

  it("terminates a worker that exceeds its action timeout", async () => {
    const slow = compileSkill(
      document({
        actions: [
          {
            ...document().actions![0]!,
            runtime: {
              ...document().actions![0]!.runtime,
              timeoutMs: 30,
              source: "() => { while (true) {} }",
            },
          },
        ],
      }),
    );
    await expect(
      executeSkillAction(slow, "query-weather", { location: "Shanghai" }, host, { trust: "verified" }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("Agent Skills import", () => {
  const manifest = `---
name: sample-skill
description: Processes samples when users ask for sample analysis.
license: MIT
metadata:
  author: nova
  version: "1.2.3"
allowed-tools: Read Bash(jq:*)
---
# Sample skill

Read references/guide.md when more detail is needed.
`;
  const files: ArchiveFile[] = [
    { path: "sample-skill/SKILL.md", data: new TextEncoder().encode(manifest) },
    { path: "sample-skill/references/guide.md", data: new TextEncoder().encode("# Guide") },
    { path: "sample-skill/scripts/run.py", data: new TextEncoder().encode("print('ok')") },
  ];

  it("maps standard metadata and resources without making scripts executable actions", () => {
    const skill = importAgentSkillFiles(files, { sourceUri: "market://sample.zip" });
    expect(skill.version).toBe("1.2.3");
    expect(skill.resources.map((resource) => resource.kind)).toEqual(["reference", "script"]);
    expect(skill.actions).toEqual([]);
    expect(skill.source.allowedTools).toBe("Read Bash(jq:*)");
  });

  it("reads a stored ZIP and rejects traversal paths", () => {
    const zip = storedZip(files);
    expect(importAgentSkillZip(zip).name).toBe("sample-skill");
    expect(() =>
      importAgentSkillZip(storedZip([{ path: "../SKILL.md", data: new TextEncoder().encode(manifest) }])),
    ).toThrow(SkillArchiveError);
  });
});

function storedZip(files: readonly ArchiveFile[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path);
    const data = Buffer.from(file.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}
