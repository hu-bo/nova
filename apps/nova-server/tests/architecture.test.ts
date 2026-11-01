import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

test("domain boundaries reject SQL leakage, foreign tables and private imports", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const eslint = new ESLint({ cwd: root });
  const cases = [
    ["modules/health/health.routes.ts", 'import { sql } from "../../../database/index.js";', false],
    ["modules/health/health.routes.ts", "app.db.execute(query);", false],
    ["modules/runners/runner.service.ts", 'import { eq } from "drizzle-orm";', false],
    ["modules/runners/runner-connections.ts", 'import { runners } from "../../../database/index.js";', false],
    ["transport/sse.ts", 'import { sql } from "drizzle-orm";', false],
    ["jobs/job-host.ts", 'import { sql } from "drizzle-orm";', false],
    ["modules/runs/run.repository.ts", 'import { uiEvents } from "../../../database/index.js";', false],
    ["modules/projects/project-binding.repository.ts", 'import { runners } from "../../../database/index.js";', false],
    ["modules/events/event.repository.ts", 'import * as tables from "../../../database/index.js";', false],
    ["modules/events/event.repository.ts", 'import { conversations } from "../../../database/schema/index.js";', false],
    [
      "modules/attachments/attachment.service.ts",
      'import type { ConversationRepository } from "../conversations/conversation.repository.js";',
      false,
    ],
    ["modules/projects/nested/example.ts", 'import { RunnerService } from "../../runners/runner.service.js";', false],
    [
      "modules/events/event.repository.ts",
      'import { uiEvents, type Database } from "../../../database/index.js";',
      true,
    ],
    [
      "modules/attachments/attachment.service.ts",
      'import type { ConversationReader } from "../conversations/index.js";',
      true,
    ],
    [
      "modules/runners/runner-token.service.ts",
      'import type { UnitOfWork } from "../../shared/unit-of-work.js";',
      true,
    ],
    ["jobs/postgres-job-store.ts", 'import { sql } from "drizzle-orm";', true],
    ["modules/runners/runner-token.service.ts", 'import { defineService } from "../../shared/scope.js";', true],
    ["modules/runners/runner-token.repository.ts", 'import { defineRepository } from "../../shared/scope.js";', true],
    ["modules/runs/run.repository.ts", "db.transaction(operation);", false],
    ["modules/conversations/conversation.repository.ts", "tx.transaction(operation);", false],
    ["modules/runs/run.service.ts", "transaction(operation);", true],
    [
      "modules/runners/runner-token.service.ts",
      'import { createUnitOfWork } from "../../shared/unit-of-work.js";',
      false,
    ],
  ] as const;
  for (const [path, source, allowed] of cases) {
    const [result] = await eslint.lintText(source, {
      filePath: fileURLToPath(new URL(`../src/${path}`, import.meta.url)),
    });
    const violations = result!.messages.filter(
      (message) => message.ruleId === "no-restricted-imports" || message.ruleId === "no-restricted-syntax",
    );
    assert.equal(violations.length === 0, allowed, `${path}: ${source}\n${JSON.stringify(result!.messages)}`);
  }
});
