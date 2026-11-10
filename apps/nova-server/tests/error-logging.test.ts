import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { RemoteConnectionService } from "../src/modules/remotes/remote.service.js";
import type { RemoteConnectionRow, RemoteRepository } from "../src/modules/remotes/remote.repository.js";
import { registerErrorHandlers } from "../src/plugins/errors.js";
import { createCredentialCipher } from "../src/shared/credential-cipher.js";
import { createLoggerOptions } from "../src/shared/logger.js";

test("Windows launcher fixes a GBK parent shell before starting pnpm", { skip: process.platform !== "win32" }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nova-log-encoding-"));
  const fixture = join(directory, "log.mjs");
  const pnpm = join(directory, "pnpm.cmd");
  t.after(() => {
    unlinkSync(fixture);
    unlinkSync(pnpm);
    rmdirSync(directory);
  });
  writeFileSync(
    fixture,
    `console.log(JSON.stringify({ message: "需要登录后才能继续", args: process.argv.slice(2) })); process.exitCode = 7;`,
    "utf8",
  );
  writeFileSync(pnpm, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, "utf8");
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.toLowerCase() === "path") delete environment[name];
  }
  environment.PATH = directory + delimiter + (process.env.PATH ?? process.env.Path ?? "");
  const launcher = fileURLToPath(new URL("../../../scripts/start-nova-server.ps1", import.meta.url));
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936); & '${launcher.replace(/'/g, "''")}' -Mode dev:worker | ForEach-Object { [Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_))) }; exit $LASTEXITCODE`,
    ],
    { env: environment, encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  assert.equal(result.status, 7, result.stderr || result.error?.message);
  const entry = JSON.parse(Buffer.from(result.stdout.trim(), "base64").toString("utf8"));
  assert.equal(entry.message, "需要登录后才能继续");
  assert.deepEqual(entry.args, ["--dir", resolve(fileURLToPath(new URL("../", import.meta.url))), "dev:worker"]);
});

test("server logs preserve UTF-8 Chinese text and use local timestamps with the correct timezone offset", async (t) => {
  const scenarios = [
    { zone: "Asia/Shanghai", now: "2026-10-24T12:34:56.789Z", expected: "2026-10-24T20:34:56.789+08:00" },
    { zone: "America/New_York", now: "2026-10-24T12:34:56.789Z", expected: "2026-10-24T08:34:56.789-04:00" },
    { zone: "America/New_York", now: "2026-01-24T12:34:56.789Z", expected: "2026-01-24T07:34:56.789-05:00" },
    { zone: "Asia/Kathmandu", now: "2026-10-24T12:34:56.789Z", expected: "2026-10-24T18:19:56.789+05:45" },
    { zone: "UTC", now: "2026-10-24T12:34:56.789Z", expected: "2026-10-24T12:34:56.789+00:00" },
  ];
  for (const scenario of scenarios) {
    await t.test(`${scenario.zone} ${scenario.now}`, () => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
            import Fastify from "fastify";
            import { createAppLogger } from "./src/shared/logger.ts";
            Date.now = () => ${Date.parse(scenario.now)};
            const app = Fastify({ loggerInstance: createAppLogger({ NODE_ENV: "test", LOG_LEVEL: "info", LOG_DIR: "logs", ROLE: "all" }) });
            app.log.error({
              err: new Error("中文异常：权限不足"),
              req: {
                headers: { authorization: "HIDDEN-SECRET", cookie: "HIDDEN-SECRET" },
                body: { password: "HIDDEN-SECRET", token: "HIDDEN-SECRET", credential: "HIDDEN-SECRET", passphrase: "HIDDEN-SECRET" },
              },
            }, "中文日志：SSH 连接失败 🚫");
            await app.close();
          `,
        ],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: { ...process.env, TZ: scenario.zone },
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const entry = JSON.parse(result.stdout);
      assert.equal(entry.time, scenario.expected);
      assert.equal(entry.msg, "中文日志：SSH 连接失败 🚫");
      assert.equal(entry.err.message, "中文异常：权限不足");
      assert.equal(entry.service, "nova-server");
      assert.equal(entry.env, "test");
      assert.equal(entry.role, "all");
      assert.ok(result.stdout.includes("中文日志"));
      assert.ok(!result.stdout.includes("HIDDEN-SECRET"));
    });
  }
});

test("production logger supports Fastify child bindings and retains debug logs in stdout and rotating files", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nova-production-logs-"));
  t.after(() => {
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  });
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import Fastify from "fastify";
    import { createAppLogger } from "./src/shared/logger.ts";
    const app = Fastify({ loggerInstance: createAppLogger({ NODE_ENV: "production", LOG_LEVEL: "debug", LOG_DIR: process.env.TEST_LOG_DIR, ROLE: "worker" }) });
    app.get("/test", (req) => { req.log.debug({ stage: "test" }, "中文诊断"); return { ok: true }; });
    await app.inject("/test");
    await app.close();
  `,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, TEST_LOG_DIR: directory },
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const entries = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const diagnostic = entries.find((entry) => entry.msg === "中文诊断");
  assert.equal(diagnostic.level, 20);
  assert.equal(diagnostic.env, "production");
  assert.equal(diagnostic.role, "worker");
  assert.ok(diagnostic.reqId);
  const fileContents = readdirSync(directory)
    .filter((name) => name.endsWith(".log"))
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("\n");
  assert.ok(fileContents.includes("中文诊断"));
  assert.ok(fileContents.includes(diagnostic.reqId));
  assert.match(fileContents, /stage:\s+"test"/);
});

test("SSH test failures log the original diagnostic without exposing credentials or changing responses", async (t) => {
  const scenarios = [
    { name: "connection refused", stage: "connect", code: "ECONNREFUSED", level: "client-socket", status: 409 },
    { name: "DNS failure", stage: "connect", code: "ENOTFOUND", level: "client-dns", status: 409 },
    { name: "authentication failure", stage: "connect", code: undefined, level: "client-authentication", status: 409 },
    { name: "invalid private key", stage: "sync", code: undefined, level: undefined, status: 400 },
    { name: "SFTP unavailable", stage: "sftp", code: 4, level: undefined, status: 409 },
    { name: "root realpath denied", stage: "realpath", code: 3, level: undefined, status: 404 },
    { name: "root stat denied", stage: "stat", code: 3, level: undefined, status: 404 },
    { name: "host key changed", stage: "host-key", code: undefined, level: "handshake", status: 409 },
    { name: "first host trust", stage: "untrusted", code: undefined, level: "handshake", status: 200 },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const logs: Record<string, unknown>[] = [];
      const app = Fastify({
        logger: {
          ...createLoggerOptions("info"),
          stream: { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
        },
      });
      t.after(() => app.close());
      registerErrorHandlers(app);
      const secret = "DO-NOT-LOG-SSH-CREDENTIAL";
      const original = Object.assign(new Error(`Underlying SSH failure: ${scenario.name}`), {
        code: scenario.code,
        level: scenario.level,
        syscall: "connect",
        address: "127.0.0.1",
        port: 22,
        credential: secret,
        password: secret,
        passphrase: secret,
      });
      t.mock.method(Client.prototype, "connect", function (this: Client, config: ConnectConfig) {
        if (scenario.stage === "sync") throw original;
        if (["connect", "host-key", "untrusted"].includes(scenario.stage)) {
          if (scenario.stage !== "connect") (config.hostVerifier as (key: Buffer) => boolean)(Buffer.from("host key"));
          queueMicrotask(() => this.emit("error", original));
        } else queueMicrotask(() => this.emit("ready"));
        return this;
      });
      const sftp = {
        realpath: (_path: string, callback: (error: Error | null, path?: string) => void) =>
          callback(scenario.stage === "realpath" ? original : null, "/home/dev"),
        stat: (_path: string, callback: (error: Error | null) => void) => callback(original),
      } as unknown as SFTPWrapper;
      t.mock.method(Client.prototype, "sftp", (callback: (error: Error | null, sftp: SFTPWrapper) => void) =>
        callback(scenario.stage === "sftp" ? original : null, sftp),
      );
      const encryptionKey = "ab".repeat(32);
      const row = {
        id: "c3412289-13be-47a8-ad60-c8fad3671987",
        hostname: "test.invalid",
        port: 22,
        username: "dev",
        rootPath: "/home/dev",
        authMethod: "private_key",
        credentialCiphertext: createCredentialCipher(encryptionKey).encrypt(secret),
        hostFingerprint: scenario.stage === "untrusted" ? null : "verified",
      } as RemoteConnectionRow;
      let persistedError: unknown;
      const repository = {
        get: async () => row,
        update: async (_id: string, _owner: string, patch: Partial<RemoteConnectionRow>) => {
          persistedError = patch.lastError;
          return row;
        },
      } as RemoteRepository;
      const service = new RemoteConnectionService(repository, encryptionKey);
      app.post("/api/remote-connections/:id/test", () => service.test(row.id, "owner"));
      const response = await app.inject({
        method: "POST",
        url: `/api/remote-connections/${row.id}/test`,
        headers: { authorization: `Bearer ${secret}` },
        payload: { credential: secret, passphrase: secret },
      });
      assert.equal(response.statusCode, scenario.status);
      const warnings = logs.filter((entry) => entry.level === 40);
      if (scenario.stage === "untrusted") {
        assert.equal(response.json().status, "trust_required");
        assert.equal(warnings.length, 0);
        assert.equal(persistedError, undefined);
      } else {
        assert.equal(warnings.length, 1);
        const diagnostic = warnings[0]!;
        const body = response.json();
        assert.equal(diagnostic.reqId, body.requestId);
        assert.equal(diagnostic.url, `/api/remote-connections/${row.id}/test`);
        assert.equal(diagnostic.method, "POST");
        assert.equal(diagnostic.statusCode, scenario.status);
        assert.equal(diagnostic.reason, body.details.reason);
        assert.equal(persistedError, body.details.reason);
        const cause = diagnostic.cause as Record<string, unknown>;
        assert.equal(cause.message, original.message);
        assert.equal(cause.stack, original.stack);
        assert.equal(cause.code, scenario.code);
        assert.equal(cause.level, scenario.level);
        assert.equal(cause.syscall, "connect");
        assert.equal(cause.address, "127.0.0.1");
        assert.equal(cause.port, 22);
        assert.ok(!response.body.includes(original.message));
        assert.ok(!response.body.includes("stack"));
      }
      assert.ok(!JSON.stringify(logs).includes(secret));
      assert.ok(!response.body.includes(secret));
    });
  }
});

test("error diagnostics retain nested causes and Zod issue locations, excluding input payloads", async (t) => {
  const logs: Record<string, unknown>[] = [];
  const app = Fastify({
    logger: {
      ...createLoggerOptions("info"),
      stream: { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
    },
  });
  t.after(() => app.close());
  registerErrorHandlers(app);
  const secret = "DO-NOT-LOG-VALIDATION-INPUT";
  const cause = Object.assign(new Error("Invalid response shape"), {
    issues: [{ path: ["items", 0, "id"], code: "invalid_type", message: "Expected string", input: secret }],
    cause: new Error("Nested failure"),
  });
  app.get("/serialization", () => {
    throw new Error("Response serialization failed", { cause });
  });
  const response = await app.inject("/serialization");
  assert.equal(response.statusCode, 500);
  const diagnostic = logs.find((entry) => entry.level === 50)!;
  const recordedCause = diagnostic.cause as Record<string, unknown>;
  assert.deepEqual(recordedCause.issues, [{ path: "items.0.id", code: "invalid_type", message: "Expected string" }]);
  assert.equal((recordedCause.cause as Record<string, unknown>).message, "Nested failure");
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.ok(!response.body.includes(cause.message));
});
