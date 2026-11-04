import { createProjectBindingRepository } from "../src/modules/projects/project-binding.repository.js";
import { createRunnerReader } from "../src/modules/runners/index.js";
import { createScope } from "../src/shared/scope.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { Client, type SFTPWrapper } from "ssh2";
import { createCredentialCipher } from "../src/shared/credential-cipher.js";
import { RemoteConnectionService } from "../src/modules/remotes/remote.service.js";
import type { RemoteRepository, RemoteConnectionRow } from "../src/modules/remotes/remote.repository.js";
import { sshToolContext } from "../src/modules/runs/ssh-tool-context.js";
import { ProjectBindingService } from "../src/modules/projects/project-binding.service.js";
import type { Database } from "../database/index.js";

test("SSH project bindings persist absolute directories, including /", async () => {
  const projectId = "00000000-0000-4000-8000-000000000001";
  const remoteConnectionId = "00000000-0000-4000-8000-000000000002";
  function query(rows: unknown[]) {
    const result = {
      from: () => result,
      where: () => result,
      for: () => result,
      orderBy: () => result,
      limit: async () => rows,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return result;
  }
  let stored: Record<string, unknown> = {};
  const tx = {
    select: (fields?: unknown) => query(fields ? [{ id: projectId }] : []),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        returning: async () => {
          stored = value;
          return [{ id: projectId, ...value }];
        },
      }),
    }),
  };
  const db = { transaction: async (operation: (transaction: typeof tx) => unknown) => operation(tx) };
  const service = new ProjectBindingService(
    createProjectBindingRepository(db as unknown as Database),
    createScope(db as unknown as Database).serviceTransaction({
      repository: createProjectBindingRepository(db as unknown as Database),
      runners: createRunnerReader(db as unknown as Database),
      remotes: {
        getEnvironment: async () => ({
          id: remoteConnectionId,
          name: "SSH",
          rootPath: "/home",
          workspaceId: "ssh:test",
        }),
      },
    }),
  );
  for (const canonicalCwd of ["/etc", "/var/www", "/", "projects/web"]) {
    const binding = await service.bind(projectId, "owner", {
      remoteConnectionId,
      canonicalCwd,
      expectedRevision: 0,
      customPrompt: "",
    });
    assert.equal(stored.canonicalCwd, canonicalCwd);
    assert.equal(binding.canonicalCwd, canonicalCwd);
  }
  for (const source of ["agents", "claude", "custom", "none"] as const) {
    const binding = await service.bind(projectId, "owner", {
      remoteConnectionId,
      canonicalCwd: "/project",
      expectedRevision: 0,
      instructionSource: source,
      customPrompt: "custom instructions",
    });
    const expected = { source, customPrompt: source === "custom" ? "custom instructions" : "" };
    assert.deepEqual(stored.instructions, expected);
    assert.deepEqual(binding.instructions, expected);
  }
  await assert.rejects(
    service.bind(projectId, "owner", {
      runnerId: projectId,
      workspaceId: "runner:test",
      canonicalCwd: "/etc",
      expectedRevision: 0,
      customPrompt: "",
    }),
    { code: "VALIDATION_ERROR" },
  );
});

test("SSH browsing and attachments can leave the configured work directory", async (t) => {
  const content = Buffer.from("outside the configured work directory\n");
  const directories: Record<string, string[]> = {
    "/": ["home", "etc", "var", "private"],
    "/home": ["notes.txt"],
    "/etc": ["config.txt"],
    "/var": ["www"],
    "/var/www": [],
  };
  const files = new Set(["/home/notes.txt", "/etc/config.txt"]);
  const sftp = {
    realpath(path: string, callback: (error: Error | null, path?: string) => void) {
      if (path === "/home/config-link") path = "/etc/config.txt";
      if (directories[path] || files.has(path) || path === "/private") callback(null, path);
      else callback(new Error("not found"));
    },
    readdir(path: string, callback: (error: Error | null, entries?: unknown[]) => void) {
      const names = directories[path];
      if (!names) return callback(new Error("permission denied"));
      callback(
        null,
        names.map((filename) => ({
          filename,
          attrs: { mode: files.has(path.replace(/\/$/, "") + "/" + filename) ? 0o100644 : 0o040755 },
        })),
      );
    },
    stat(path: string, callback: (error: Error | null, attrs?: unknown) => void) {
      if (!files.has(path)) return callback(new Error("not found"));
      callback(null, { isFile: () => true, size: content.length, mtime: 1 });
    },
    createReadStream: () => Readable.from([content]),
  } as unknown as SFTPWrapper;
  t.mock.method(Client.prototype, "connect", function (this: Client) {
    queueMicrotask(() => this.emit("ready"));
    return this;
  });
  t.mock.method(Client.prototype, "sftp", (callback: (error: undefined, sftp: SFTPWrapper) => void) => {
    callback(undefined, sftp);
  });
  const key = "ab".repeat(32);
  const row = {
    id: "remote-1",
    name: "test",
    rootPath: "/home",
    hostname: "test.invalid",
    port: 22,
    username: "dev",
    authMethod: "password",
    credentialCiphertext: createCredentialCipher(key).encrypt("test password"),
    hostFingerprint: "verified",
    lastCheckedAt: new Date(),
  } as RemoteConnectionRow;
  const repository = {
    get: async (id: string, owner: string) => (id === row.id && owner === "owner" ? row : undefined),
  } as RemoteRepository;
  const service = new RemoteConnectionService(repository, key);

  await t.test("starts at / and allows navigating up from /home", async () => {
    const root = await service.files(row.id, "owner");
    assert.equal(root.root, "/");
    assert.equal(root.path, "/");
    assert.equal(root.parent, null);
    assert.ok(root.entries.some((entry) => entry.path === "/etc"));
    const home = await service.files(row.id, "owner", "/home");
    assert.equal(home.root, "/");
    assert.equal(home.parent, "/");
    assert.equal((await service.files(row.id, "owner", "..")).path, "/");
    const outside = await service.files(row.id, "owner", "/var/www");
    assert.equal(outside.parent, "/var");
  });

  await t.test("summarizes and reads absolute attachments outside /home, including resolved symlinks", async () => {
    const summary = await service.summaries(row.id, "owner", ["/etc/config.txt"]);
    const file = await service.readText(row.id, "owner", summary.items[0]!.path);
    assert.equal(file.text, content.toString());
    assert.equal(file.sha256, summary.items[0]!.sha256);
    const linked = await service.summaries(row.id, "owner", ["config-link"]);
    assert.equal(linked.items[0]!.path, "/etc/config.txt");
  });

  await t.test("keeps legacy relative attachments based on the configured work directory", async () => {
    assert.equal((await service.summaries(row.id, "owner", ["notes.txt"])).items[0]!.path, "/home/notes.txt");
    assert.equal((await service.readText(row.id, "owner", "notes.txt")).text, content.toString());
  });

  await t.test("keeps ownership checks, remote permissions and invalid-path errors", async () => {
    await assert.rejects(service.files(row.id, "another-user"), { code: "NOT_FOUND" });
    await assert.rejects(service.files(row.id, "owner", "/private"), { code: "NOT_FOUND" });
    await assert.rejects(service.files(row.id, "owner", "/missing"), { code: "NOT_FOUND" });
    await assert.rejects(service.files(row.id, "owner", "/etc/\0config"), { code: "VALIDATION_ERROR" });
  });

  await t.test("uses the selected absolute project directory while retaining relative tool paths", async () => {
    const context = await sshToolContext(service, row.id, "owner", "/etc", new AbortController().signal, "op-1");
    assert.equal(context.cwd, "/etc");
    const read = await context.fs.read("config.txt");
    assert.ok(read.ok);
    assert.equal(read.value.text, content.toString());
    const list = await context.fs.list(".");
    assert.ok(list.ok);
    assert.equal(list.value[0]!.path, "config.txt");
    const traversal = await context.fs.read("../home/notes.txt");
    assert.ok(!traversal.ok);
    assert.equal(traversal.error.code, "FORBIDDEN");
    const legacy = await sshToolContext(service, row.id, "owner", ".", new AbortController().signal, "op-2");
    assert.equal(legacy.cwd, "/home");
  });
});
