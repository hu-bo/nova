import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { conversations, createDatabase, projects } from "../database/index.js";
import type { ConversationMetadata } from "../database/index.js";
import { createScope } from "../src/shared/scope.js";
import { DomainError } from "../src/shared/domain-error.js";
import { createConversationRepository } from "../src/modules/conversations/conversation.repository.js";
import { ConversationService } from "../src/modules/conversations/conversation.service.js";

const url = process.env.TEST_DATABASE_URL;

test("conversation runner binding switches directly while the bound runner is offline", { skip: !url }, async (t) => {
  const admin = new Pool({ connectionString: url });
  const schemaName = "nova_binding_switch_test_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA "${schemaName}"`);
  const scopedUrl = new URL(url!);
  scopedUrl.searchParams.set("options", `-c search_path=${schemaName}`);
  const pool = new Pool({ connectionString: scopedUrl.toString() });
  const db = createDatabase(pool);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    await admin.end();
  });
  const directory = new URL("../database/migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrations)
    await pool.query((await readFile(new URL(file, directory), "utf8")).replaceAll('"public".', ""));

  const owner = randomUUID();
  const oldRunner = randomUUID();
  const newRunner = randomUUID();
  const [project] = await db
    .insert(projects)
    .values({ ownerUserId: owner, name: "Binding switch project" })
    .returning();
  assert.ok(project);
  const staleBinding = {
    id: randomUUID(),
    revision: 2,
    runnerId: oldRunner,
    workspaceId: "ws-old",
    canonicalCwd: "project/dir",
    instructions: { source: "agents" },
  };
  async function makeConversation(
    overrides: { mode?: "chat" | "project"; binding?: ConversationMetadata["binding"] } = {},
  ) {
    const [row] = await db
      .insert(conversations)
      .values({
        ownerUserId: owner,
        mode: overrides.mode ?? "project",
        projectId: project.id,
        metadata: { binding: overrides.binding ?? staleBinding } as ConversationMetadata,
      })
      .returning();
    assert.ok(row);
    return row.id;
  }
  const repository = createConversationRepository(db);
  // 在线判定与目标设备工作目录走内存桩：本用例只验证会话绑定切换本身。
  let online = false;
  let targetFound = true;
  let targetWorkspace: string | null = "ws-new";
  const service = new ConversationService(
    repository,
    createScope(db).serviceTransaction({
      repository,
      runnerConnections: { isOnline: () => online },
      runnerReader: {
        readWorkspace: async () => (targetFound ? { workspaceId: targetWorkspace } : undefined),
      },
    }) as unknown as ConstructorParameters<typeof ConversationService>[1],
  );
  async function bindingOf(id: string) {
    const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
    return row!.metadata.binding!;
  }

  await t.test("adopts the target runner and keeps directory, instructions and revision", async () => {
    const id = await makeConversation();
    const updated = await service.updateBinding(id, owner, newRunner);
    assert.equal(updated.runnerId, newRunner);
    assert.equal(updated.workspaceId, "ws-new");
    assert.equal(updated.canonicalCwd, "project/dir");
    assert.equal(updated.revision, 2);
    assert.deepEqual(await bindingOf(id), updated);
  });
  await t.test("is idempotent when the conversation already uses the target runner", async () => {
    const id = await makeConversation();
    await service.updateBinding(id, owner, newRunner);
    const again = await service.updateBinding(id, owner, newRunner);
    assert.equal(again.runnerId, newRunner);
    assert.equal(again.workspaceId, "ws-new");
  });
  await t.test("refuses while the bound runner is online", async () => {
    online = true;
    const id = await makeConversation();
    await assert.rejects(
      service.updateBinding(id, owner, newRunner),
      (error: unknown) => error instanceof DomainError && error.details?.reason === "RUNNER_ONLINE",
    );
    assert.equal((await bindingOf(id)).runnerId, oldRunner);
    online = false;
  });
  await t.test("validates the target device and conversation shape", async () => {
    targetFound = false;
    const missing = await makeConversation();
    await assert.rejects(
      service.updateBinding(missing, owner, newRunner),
      (error: unknown) => error instanceof DomainError && error.code === "NOT_FOUND",
    );
    targetFound = true;
    targetWorkspace = null;
    await assert.rejects(
      service.updateBinding(missing, owner, newRunner),
      (error: unknown) => error instanceof DomainError && error.details?.reason === "WORKSPACE_MISSING",
    );
    targetWorkspace = "ws-new";
    const chat = await makeConversation({ mode: "chat" });
    await assert.rejects(
      service.updateBinding(chat, owner, newRunner),
      (error: unknown) => error instanceof DomainError && error.details?.reason === "RUNNER_BINDING_REQUIRED",
    );
    const remote = await makeConversation({ binding: { ...staleBinding, runnerId: null } });
    await assert.rejects(
      service.updateBinding(remote, owner, newRunner),
      (error: unknown) => error instanceof DomainError && error.details?.reason === "RUNNER_BINDING_REQUIRED",
    );
  });
  await t.test("hides conversations that belong to another owner", async () => {
    const id = await makeConversation();
    await assert.rejects(
      service.updateBinding(id, randomUUID(), newRunner),
      (error: unknown) => error instanceof DomainError && error.code === "NOT_FOUND",
    );
  });
});
