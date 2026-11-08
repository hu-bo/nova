import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { configurationSchema, type Configuration, type SubmitInput } from "@nova/agent-ui-contracts";
import { conversations, messages, pendingInputs, projects, projectBindings, runnerOperations, runs, specs, specRevisions, specTaskAttempts, type Database } from "../../../database/index.js";
import type { SpecEvidence, SpecTask, SpecTaskCheck } from "../../../database/schema/spec-revision.table.js";
import { DomainError } from "../../shared/domain-error.js";
import { createScope, type TransactionOptions } from "../../shared/scope.js";
import { runJournal } from "../runs/index.js";
import { eventWriter } from "../events/index.js";
import { specSnapshotSchema, taskPlanSchema, taskStatusSchema } from "./spec.schema.js";
import type { CreateSpecInput } from "./spec.schema.js";
import type { Transaction } from "../../shared/unit-of-work.js";
import { acceptanceCriteriaIn, validateTaskPlan } from "./spec.validation.js";

type Stage = "requirements" | "design" | "tasks";
type Content = string | SpecTask[];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const changed = (current: number, expected: number): never => {
  throw new DomainError("CONFLICT", "Specification has changed", { reason: "SPEC_REVISION_STALE", currentRevision: current });
};
function sameCheck(a: SpecTaskCheck, b: SpecTaskCheck) {
  return JSON.stringify({ ...a, key: "" }) === JSON.stringify({ ...b, key: "" });
}

export class SpecService {
  private readonly scope;
  private readonly journal;
  private readonly events;
  constructor(private readonly db: Database) {
    this.scope = createScope(db);
    this.journal = this.scope.get(runJournal);
    this.events = this.scope.get(eventWriter);
  }
  private transaction<R>(operation: (tx: Transaction) => Promise<R>, options?: TransactionOptions) {
    return this.scope.transaction((scope) => operation(scope.requireTransaction()), options);
  }
  private async hasUnknownRun(tx: Transaction, conversationId: string) {
    const [run] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.conversationId, conversationId), eq(runs.state, "cancelled_unconfirmed"))).limit(1);
    return Boolean(run);
  }

  async list(projectId: string, ownerId: string, limit: number, cursor?: string) {
    const project = await this.db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, ownerId), isNull(projects.deletedAt))).limit(1);
    if (!project.length) throw new DomainError("NOT_FOUND", "Project not found");
    let cursorDate: Date | undefined, cursorId: string | undefined;
    if (cursor) {
      const [date, id] = cursor.split("|"); cursorDate = new Date(date ?? ""); cursorId = id;
      if (!cursorId || Number.isNaN(cursorDate.getTime())) throw new DomainError("VALIDATION_ERROR", "Invalid cursor");
    }
    const rows = await this.db.select({ id: specs.id, projectId: specs.projectId, title: specs.title, currentRevision: specs.currentRevision, conversationId: specs.conversationId, updatedAt: specs.updatedAt })
      .from(specs).innerJoin(projects, eq(projects.id, specs.projectId))
      .where(and(eq(specs.projectId, projectId), eq(projects.ownerUserId, ownerId), isNull(projects.deletedAt), cursorDate ? or(lt(specs.updatedAt, cursorDate), and(eq(specs.updatedAt, cursorDate), lt(specs.id, cursorId!))) : undefined))
      .orderBy(desc(specs.updatedAt), desc(specs.id)).limit(limit + 1);
    const page = rows.slice(0, limit), last = page.at(-1);
    return { items: page.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })), nextCursor: rows.length > limit && last ? `${last.updatedAt.toISOString()}|${last.id}` : null };
  }

  async create(projectId: string, ownerId: string, input: CreateSpecInput, key: string) {
    return this.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerUserId, ownerId), isNull(projects.deletedAt))).for("update");
      if (!project) throw new DomainError("NOT_FOUND", "Project not found");
      const creationKey = `sdd:${key}`, signature = hash({ projectId, ...input });
      const [priorConversation] = await tx.select().from(conversations).where(and(eq(conversations.ownerUserId, ownerId), sql`${conversations.metadata}->>'creationKey' = ${creationKey}`)).limit(1);
      if (priorConversation) {
        if (priorConversation.metadata.creationPayload !== signature) throw new DomainError("CONFLICT", "Idempotency key reused", { reason: "IDEMPOTENCY_KEY_REUSED" });
        const [prior] = await tx.select({ id: specs.id, projectId: specs.projectId, conversationId: specs.conversationId, title: specs.title, currentRevision: specs.currentRevision }).from(specs).where(eq(specs.conversationId, priorConversation.id));
        if (prior) return prior;
      }
      const [binding] = await tx.select().from(projectBindings).where(and(eq(projectBindings.projectId, projectId), eq(projectBindings.isCurrent, true))).orderBy(desc(projectBindings.revision)).limit(1);
      const conversationId = randomUUID();
      const configuration = configurationSchema.parse({ ...input.configuration, mode: "plan" });
      const metadata = {
        configuration,
        specId: "pending",
        binding: binding ? { id: binding.id, revision: binding.revision, runnerId: binding.runnerId, remoteConnectionId: binding.remoteConnectionId, workspaceId: binding.workspaceId, canonicalCwd: binding.canonicalCwd, instructions: binding.instructions } : null,
        creationKey,
        creationPayload: signature,
      };
      const [conversation] = await tx.insert(conversations).values({ id: conversationId, ownerUserId: ownerId, mode: "project", projectId, title: input.title, metadata }).returning();
      if (!conversation) throw new Error("Failed to create specification conversation");
      const [spec] = await tx.insert(specs).values({ projectId, conversationId, title: input.title }).returning();
      if (!spec) throw new Error("Failed to create specification");
      conversation.metadata = { ...metadata, specId: spec.id };
      await tx.update(conversations).set({ metadata: conversation.metadata }).where(eq(conversations.id, conversationId));
      const brief = input.brief.trim() ? `# ${input.title}\n\n${input.brief.trim()}\n` : `# ${input.title}\n`;
      await tx.insert(specRevisions).values({ specId: spec.id, revision: 1, requirementsMd: brief, taskPlan: [], reviews: {}, evidence: [], createdBy: ownerId });
      if (input.startGeneration) {
        const payload: SubmitInput & { spec: { kind: "generation"; specId: string; revision: number; stage: "requirements" } } = {
          mode: "next_run", blocks: [{ id: "text", type: "text", text: input.brief }],
          configuration, spec: { kind: "generation", specId: spec.id, revision: 1, stage: "requirements" },
        };
        const [queued] = await tx.insert(pendingInputs).values({
          conversationId, sequence: 1n, mode: "next_run", payload, fingerprint: hash(payload),
          idempotencyKey: "initial-requirements:" + spec.id,
        }).returning();
        await this.journal.tx(tx).append(conversation, { runId: null, type: "input.queued", payload: {
          input: { id: queued!.id, state: "queued", input: { mode: payload.mode, blocks: payload.blocks, configuration } },
        } });
        await this.journal.tx(tx).wake(conversationId, "spec-generation:" + queued!.id);
      }
      return { id: spec.id, projectId: spec.projectId, conversationId: spec.conversationId, title: spec.title, currentRevision: 1 };
    });
  }

  private async lock(tx: Transaction, projectId: string, specId: string, ownerId: string) {
    const [found] = await tx.select({ conversationId: specs.conversationId }).from(specs).innerJoin(projects, eq(projects.id, specs.projectId))
      .where(and(eq(specs.id, specId), eq(specs.projectId, projectId), eq(projects.ownerUserId, ownerId), isNull(projects.deletedAt))).limit(1);
    if (!found) throw new DomainError("NOT_FOUND", "Specification not found");
    const [conversation] = await tx.select().from(conversations).where(and(eq(conversations.id, found.conversationId), eq(conversations.ownerUserId, ownerId))).for("update");
    if (!conversation) throw new DomainError("NOT_FOUND", "Specification not found");
    if (conversation.activeRunId) await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, conversation.activeRunId)).for("update");
    const [spec] = await tx.select().from(specs).where(eq(specs.id, specId)).for("update");
    if (!spec) throw new DomainError("NOT_FOUND", "Specification not found");
    return { spec, conversation };
  }
  private assertRevision(current: number, expected: number): void { if (current !== expected) changed(current, expected); }
  private async changedEvent(tx: Transaction, conversation: typeof conversations.$inferSelect, specId: string, revision: number, change: "draft" | "review" | "evidence" | "acceptance" | "deleted") {
    await this.journal.tx(tx).append(conversation, { runId: null, type: "spec.changed", payload: { specId, revision, change } });
  }

  async get(projectId: string, specId: string, ownerId: string, revision?: number) {
    return this.transaction(async (tx) => {
      const [spec] = await tx.select({ spec: specs, owner: projects.ownerUserId, deletedAt: projects.deletedAt }).from(specs).innerJoin(projects, eq(projects.id, specs.projectId))
        .where(and(eq(specs.id, specId), eq(specs.projectId, projectId), eq(projects.ownerUserId, ownerId), isNull(projects.deletedAt))).limit(1);
      if (!spec) throw new DomainError("NOT_FOUND", "Specification not found");
      const selected = revision ?? spec.spec.currentRevision;
      const [version] = await tx.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, selected))).limit(1);
      if (!version) throw new DomainError("NOT_FOUND", "Specification revision not found");
      const history = await tx.select({ revision: specRevisions.revision, createdAt: specRevisions.createdAt, createdBy: specRevisions.createdBy }).from(specRevisions).where(eq(specRevisions.specId, specId)).orderBy(desc(specRevisions.revision));
      const tasks = await Promise.all(version.taskPlan.map(async (task) => {
        const attempts = await tx.select({ attempt: specTaskAttempts, input: pendingInputs, run: runs }).from(specTaskAttempts)
          .innerJoin(pendingInputs, eq(pendingInputs.id, specTaskAttempts.pendingInputId)).leftJoin(runs, eq(runs.id, pendingInputs.runId))
          .where(and(eq(specTaskAttempts.specId, specId), eq(specTaskAttempts.revision, selected), eq(specTaskAttempts.taskKey, task.key))).orderBy(desc(specTaskAttempts.createdAt)).limit(1);
        const last = attempts[0];
        let status = last ? attemptStatus(last.input.status, last.run?.state ?? null, last.attempt.releasedAt) : "not_started";
        const evidencePassed = task.checks.every((check) => version.evidence.some((e) =>
          e.taskKey === task.key && e.checkKey === check.key && e.passed &&
          (last ? e.attemptId === last.attempt.id : e.source === "carried"),
        ));
        if (evidencePassed) status = "passed";
        else if (last && last.run?.state === "succeeded") status = "needs_verification";
        return { key: task.key, status, attemptId: last?.attempt.id ?? null, runId: last?.input.runId ?? null };
      }));
      return specSnapshotSchema.parse({
        id: spec.spec.id, projectId, conversationId: spec.spec.conversationId, title: spec.spec.title,
        currentRevision: spec.spec.currentRevision, revision: selected, requirementsMd: version.requirementsMd, designMd: version.designMd,
        taskPlan: version.taskPlan, reviews: version.reviews, evidence: version.evidence, acceptance: version.acceptance ? { ...version.acceptance, revision: selected } : null,
        tasks, createdAt: version.createdAt.toISOString(), updatedAt: spec.spec.updatedAt.toISOString(),
        history: history.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
      });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async save(projectId: string, specId: string, ownerId: string, expected: number, stage: Stage, content: Content) {
    const revision = await this.transaction(async (tx) => {
      const { spec, conversation } = await this.lock(tx, projectId, specId, ownerId);
      this.assertRevision(spec.currentRevision, expected);
      const [current] = await tx.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, expected))).limit(1);
      if (!current) throw new DomainError("NOT_FOUND", "Specification revision not found");
      const [active] = await tx.select({ id: specTaskAttempts.id }).from(specTaskAttempts).where(and(eq(specTaskAttempts.specId, specId), isNull(specTaskAttempts.releasedAt))).limit(1);
      if (active) throw new DomainError("CONFLICT", "Settle the active task before editing the specification", { reason: "SPEC_BUSY" });
      const value = stage === "tasks" ? taskPlanSchema.parse(content) : content;
      if (stage !== "tasks" && typeof value !== "string") throw new DomainError("VALIDATION_ERROR", "Markdown content required");
      const stageContent = { requirements: current.requirementsMd, design: current.designMd } satisfies Partial<Record<Stage, string | null>>;
      const same = stage !== "tasks" ? stageContent[stage] === value : JSON.stringify(current.taskPlan) === JSON.stringify(value);
      if (same) return expected;
      const next = expected + 1;
      const carry = (review: NonNullable<typeof current.reviews.requirements>) => ({ ...review, revision: next, sourceRevision: review.sourceRevision ?? current.revision });
      const carryReviews = { requirements: [], design: ["requirements"], tasks: ["requirements", "design"] } as const satisfies Record<Stage, readonly (keyof typeof current.reviews)[]>;
      const reviews: typeof current.reviews = {};
      for (const key of carryReviews[stage]) {
        const review = current.reviews[key];
        if (review) reviews[key] = carry(review);
      }
      await tx.insert(specRevisions).values({ specId, revision: next,
        requirementsMd: stage === "requirements" ? value as string : current.requirementsMd,
        designMd: stage === "design" ? value as string : current.designMd,
        taskPlan: stage === "tasks" ? value as SpecTask[] : current.taskPlan,
        reviews, evidence: [], acceptance: null, createdBy: ownerId });
      await tx.update(specs).set({ currentRevision: next, updatedAt: new Date() }).where(eq(specs.id, specId));
      await this.changedEvent(tx, conversation, specId, next, "draft");
      return next;
    });
    return this.get(projectId, specId, ownerId, revision);
  }

  async review(projectId: string, specId: string, ownerId: string, expected: number, stage: Stage) {
    const revision = await this.transaction(async (tx) => {
      const { spec, conversation } = await this.lock(tx, projectId, specId, ownerId);
      this.assertRevision(spec.currentRevision, expected);
      const [version] = await tx.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, expected))).limit(1);
      if (!version) throw new DomainError("NOT_FOUND", "Specification revision not found");
      if (version.acceptance) return expected;
      if (version.reviews[stage]?.revision === expected) return expected;
      if (stage === "requirements") {
        const criteria = acceptanceCriteriaIn(version.requirementsMd);
        if (!criteria.length || new Set(criteria).size !== criteria.length) throw new DomainError("VALIDATION_ERROR", "Requirements need unique AC-xx headings under ## 验收条件");
      }
      if (stage === "design" && version.reviews.requirements?.revision !== expected) throw new DomainError("CONFLICT", "Confirm requirements first", { reason: "SPEC_REVIEW_REQUIRED" });
      if (stage === "design" && !version.designMd?.trim()) throw new DomainError("VALIDATION_ERROR", "Design draft is empty");
      if (stage === "tasks") {
        if (version.reviews.requirements?.revision !== expected || version.reviews.design?.revision !== expected) throw new DomainError("CONFLICT", "Confirm requirements and design first", { reason: "SPEC_REVIEW_REQUIRED" });
        validateTaskPlan(version.taskPlan, acceptanceCriteriaIn(version.requirementsMd));
      }
      const reviews = { ...version.reviews, [stage]: { revision: expected, sourceRevision: expected, reviewerId: ownerId, reviewedAt: new Date().toISOString() } };
      await tx.update(specRevisions).set({ reviews }).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, expected)));
      await tx.update(specs).set({ updatedAt: new Date() }).where(eq(specs.id, specId));
      await this.changedEvent(tx, conversation, specId, expected, "review");
      return expected;
    });
    return this.get(projectId, specId, ownerId, revision);
  }

  async export(projectId: string, specId: string, ownerId: string, revision?: number) {
    const snapshot = await this.get(projectId, specId, ownerId, revision);
    const taskMarkdown = ["# Tasks", "", ...snapshot.taskPlan.flatMap((task) => [
      `## ${task.key} ${task.title}`, "", `- Status: ${snapshot.tasks.find((entry) => entry.key === task.key)?.status ?? "not_started"}`,
      `- Objective: ${task.objective}`, `- Depends on: ${task.dependsOn.length ? task.dependsOn.join(", ") : "None"}`, "- Checks:",
      ...task.checks.map((check) => {
        const currentAttempt = snapshot.tasks.find((item) => item.key === task.key)?.attemptId;
        const passed = snapshot.evidence.some((entry) => entry.taskKey === task.key && entry.checkKey === check.key && entry.passed &&
          (currentAttempt ? entry.attemptId === currentAttempt : entry.source === "carried"));
        return `  - [${passed ? "x" : " "}] ${check.key}: ${check.label} (covers ${check.criterionIds.join(", ") || "none"}; ${check.method.kind === "manual" ? "manual" : [check.method.command, ...check.method.args].join(" ")})`;
      }), "",
    ])].join("\n");
    return { revision: snapshot.revision, files: [
      { name: "requirements.md", content: snapshot.requirementsMd },
      { name: "design.md", content: snapshot.designMd ?? "" },
      { name: "tasks.md", content: taskMarkdown },
    ] };
  }

  async generate(projectId: string, specId: string, ownerId: string, expected: number, stage: Stage, instruction: string | undefined, config?: Partial<Configuration>, key: string = randomUUID()) {
    return this.transaction(async (tx) => {
      const { spec, conversation } = await this.lock(tx, projectId, specId, ownerId);
      const idempotencyKey = "spec-generation:" + key;
      const fp = hash({ expected, stage, instruction, config });
      const [previous] = await tx.select().from(pendingInputs).where(and(eq(pendingInputs.conversationId, conversation.id), eq(pendingInputs.idempotencyKey, idempotencyKey))).limit(1);
      if (previous) {
        if (previous.fingerprint !== fp) throw new DomainError("CONFLICT", "Idempotency key reused", { reason: "IDEMPOTENCY_KEY_REUSED" });
        return { pendingInputId: previous.id, runId: previous.runId };
      }
      this.assertRevision(spec.currentRevision, expected);
      const [version] = await tx.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, expected))).limit(1);
      if (!version) throw new DomainError("NOT_FOUND", "Specification revision not found");
      if ((stage === "design" && version.reviews.requirements?.revision !== expected) ||
        (stage === "tasks" && (version.reviews.requirements?.revision !== expected || version.reviews.design?.revision !== expected)))
        throw new DomainError("CONFLICT", "Confirm the upstream stages before generating this draft", { reason: "SPEC_REVIEW_REQUIRED" });
      if (conversation.activeRunId) throw new DomainError("CONFLICT", "Specification session is busy", { reason: "SPEC_BUSY" });
      if (await this.hasUnknownRun(tx, conversation.id)) throw new DomainError("CONFLICT", "Inspect unknown operations before continuing", { reason: "EXECUTION_OUTCOME_UNKNOWN" });
      const [queued] = await tx.select({ id: pendingInputs.id }).from(pendingInputs).where(and(eq(pendingInputs.conversationId, conversation.id), eq(pendingInputs.status, "queued"))).limit(1);
      if (queued) throw new DomainError("CONFLICT", "Specification session has queued work", { reason: "SPEC_BUSY" });
      const [last] = await tx.select({ sequence: pendingInputs.sequence }).from(pendingInputs).where(eq(pendingInputs.conversationId, conversation.id)).orderBy(desc(pendingInputs.sequence)).limit(1);
      const stageLabel = { requirements: "需求", design: "设计", tasks: "任务" }[stage];
      const generationPrompt = instruction?.trim() || `请根据已确认的规格内容，生成${stageLabel}草稿。`;
      const payload: SubmitInput & { spec: { kind: "generation"; specId: string; revision: number; stage: Stage } } = { mode: "next_run", blocks: [{ type: "text", id: "spec-generation", text: generationPrompt }], configuration: configurationSchema.parse({ ...(conversation.metadata.configuration ?? {}), ...config, mode: "plan" }), spec: { kind: "generation", specId, revision: expected, stage } };
      const [input] = await tx.insert(pendingInputs).values({ conversationId: conversation.id, sequence: (last?.sequence ?? 0n) + 1n, mode: "next_run", payload, idempotencyKey, fingerprint: fp }).returning();
      await this.journal.tx(tx).append(conversation, { runId: null, type: "input.queued", payload: { input: { id: input!.id, state: input!.status, input: { blocks: payload.blocks, mode: payload.mode, configuration: payload.configuration } } } });
      await this.journal.tx(tx).wake(conversation.id, "spec-generation:" + input!.id);
      return { pendingInputId: input!.id, runId: null };
    });
  }

  async startAttempt(projectId: string, specId: string, taskKey: string, ownerId: string, expected: number, config?: Partial<Configuration>, key: string = randomUUID()) {
    return this.transaction(async (tx) => {
      const { spec, conversation } = await this.lock(tx, projectId, specId, ownerId);
      const fp = hash({ expected, taskKey, config });
      const [previous] = await tx.select().from(specTaskAttempts).where(and(eq(specTaskAttempts.specId, specId), eq(specTaskAttempts.requestKey, key))).limit(1);
      if (previous) {
        const [input] = await tx.select({ runId: pendingInputs.runId, fingerprint: pendingInputs.fingerprint }).from(pendingInputs).where(eq(pendingInputs.id, previous.pendingInputId));
        if (previous.revision !== expected || previous.taskKey !== taskKey || input?.fingerprint !== fp) throw new DomainError("CONFLICT", "Idempotency key reused", { reason: "IDEMPOTENCY_KEY_REUSED" });
        return { pendingInputId: previous.pendingInputId, attemptId: previous.id, runId: input?.runId ?? null };
      }
      this.assertRevision(spec.currentRevision, expected);
      const [version] = await tx.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, expected))).limit(1);
      if (!version) throw new DomainError("NOT_FOUND", "Specification revision not found");
      if (version.acceptance) throw new DomainError("CONFLICT", "Accepted revision is frozen", { reason: "SPEC_ACCEPTED" });
      if (version.reviews.tasks?.revision !== expected) throw new DomainError("CONFLICT", "Confirm the task plan first", { reason: "SPEC_REVIEW_REQUIRED" });
      if (await this.hasUnknownRun(tx, conversation.id)) throw new DomainError("CONFLICT", "Inspect unknown operations before continuing", { reason: "EXECUTION_OUTCOME_UNKNOWN" });
      const task = version.taskPlan.find((entry) => entry.key === taskKey);
      if (!task) throw new DomainError("NOT_FOUND", "Task not found");
      const taskStates = await Promise.all(task.dependsOn.map(async (dependency) => {
        const dep = version.taskPlan.find((entry) => entry.key === dependency)!;
        const [latest] = await tx.select().from(specTaskAttempts).where(and(eq(specTaskAttempts.specId, specId), eq(specTaskAttempts.revision, expected), eq(specTaskAttempts.taskKey, dep.key))).orderBy(desc(specTaskAttempts.createdAt)).limit(1);
        return dep.checks.every((check) => version.evidence.some((item) => item.taskKey === dep.key && item.checkKey === check.key && item.passed && (latest ? item.attemptId === latest.id : item.source === "carried")));
      }));
      if (taskStates.some((passed) => !passed)) throw new DomainError("CONFLICT", "Task dependencies have not passed", { reason: "SPEC_DEPENDENCY_UNMET" });
      const [active] = await tx.select({ id: specTaskAttempts.id }).from(specTaskAttempts).where(and(eq(specTaskAttempts.specId, specId), isNull(specTaskAttempts.releasedAt))).limit(1);
      if (active || conversation.activeRunId) throw new DomainError("CONFLICT", "Another specification task is active", { reason: "SPEC_BUSY" });
      const [queued] = await tx.select({ id: pendingInputs.id }).from(pendingInputs).where(and(eq(pendingInputs.conversationId, conversation.id), eq(pendingInputs.status, "queued"))).limit(1);
      if (queued) throw new DomainError("CONFLICT", "Specification session has queued work", { reason: "SPEC_BUSY" });
      if (version.acceptance) throw new DomainError("CONFLICT", "Accepted revision is frozen", { reason: "SPEC_ACCEPTED" });
      const [last] = await tx.select({ sequence: pendingInputs.sequence }).from(pendingInputs).where(eq(pendingInputs.conversationId, conversation.id)).orderBy(desc(pendingInputs.sequence)).limit(1);
      const prompt = `请执行任务 ${task.key}：${task.title}\n\n目标：\n${task.objective}\n\n验证检查（请实际运行并记录结果）：\n${task.checks.map((check) => `- ${check.key} ${check.label}: ${check.method.kind === "manual" ? "人工复核" : [check.method.command, ...check.method.args].join(" ")} （覆盖 ${check.criterionIds.join(", ")}）`).join("\n")}\n\n请完成适用的检查，再报告结果。`;
      const payload: SubmitInput & { spec: { kind: "task"; specId: string; revision: number; taskKey: string; attemptId: string } } = { mode: "next_run", blocks: [{ type: "text", id: "spec-task-" + task.key, text: prompt }], configuration: configurationSchema.parse({ ...(conversation.metadata.configuration ?? {}), ...config, mode: "build" }), spec: { kind: "task", specId, revision: expected, taskKey: task.key, attemptId: randomUUID() } };
      const [input] = await tx.insert(pendingInputs).values({ conversationId: conversation.id, sequence: (last?.sequence ?? 0n) + 1n, mode: "next_run", payload, idempotencyKey: "spec-task:" + key, fingerprint: fp }).returning();
      if (!input) throw new Error("Task queue insert failed");
      const [attempt] = await tx.insert(specTaskAttempts).values({ specId, revision: expected, taskKey, pendingInputId: input.id, requestKey: key }).returning();
      if (!attempt) throw new Error("Task attempt insert failed");
      const taskPayload = { ...payload, spec: { ...payload.spec, attemptId: attempt.id } };
      await tx.update(pendingInputs).set({ payload: taskPayload }).where(eq(pendingInputs.id, input.id));
      await this.journal.tx(tx).append(conversation, { runId: null, type: "input.queued", payload: { input: { id: input.id, state: input.status, input: { blocks: payload.blocks, mode: payload.mode, configuration: payload.configuration } } } });
      await this.journal.tx(tx).wake(conversation.id, "spec-task:" + attempt.id);
      return { pendingInputId: input.id, attemptId: attempt.id, runId: null };
    });
  }

  async attempts(projectId: string, specId: string, ownerId: string, revision: number, taskKey?: string, cursor?: string) {
    const [owned] = await this.db.select({ id: specs.id }).from(specs).innerJoin(projects, eq(projects.id, specs.projectId)).where(and(eq(specs.id, specId), eq(specs.projectId, projectId), eq(projects.ownerUserId, ownerId), isNull(projects.deletedAt))).limit(1);
    if (!owned) throw new DomainError("NOT_FOUND", "Specification not found");
    const rows = await this.db.select({ attempt: specTaskAttempts, runId: pendingInputs.runId, runState: runs.state }).from(specTaskAttempts).innerJoin(pendingInputs, eq(pendingInputs.id, specTaskAttempts.pendingInputId)).leftJoin(runs, eq(runs.id, pendingInputs.runId)).where(and(eq(specTaskAttempts.specId, specId), eq(specTaskAttempts.revision, revision), taskKey ? eq(specTaskAttempts.taskKey, taskKey) : undefined, cursor ? lt(specTaskAttempts.id, cursor) : undefined)).orderBy(desc(specTaskAttempts.createdAt), desc(specTaskAttempts.id)).limit(51);
    return { items: rows.slice(0, 50).map(({ attempt, runId, runState }) => ({ ...attempt, createdAt: attempt.createdAt.toISOString(), releasedAt: attempt.releasedAt?.toISOString() ?? null, runId: runId ?? null, runState: runState ?? null })), nextCursor: rows.length > 50 ? rows[49]!.attempt.id : null };
  }

  async reconcile(projectId: string, specId: string, attemptId: string, ownerId: string, expected: number, note?: string) {
    return this.transaction(async (tx) => {
      const [owned] = await tx.select({ conversationId: specs.conversationId }).from(specs).innerJoin(projects, eq(projects.id, specs.projectId))
        .where(and(eq(specs.id, specId), eq(specs.projectId, projectId), eq(projects.ownerUserId, ownerId), isNull(projects.deletedAt))).limit(1);
      if (!owned) throw new DomainError("NOT_FOUND", "Specification not found");
      const [reference] = await tx.select({ attempt: specTaskAttempts, input: pendingInputs }).from(specTaskAttempts)
        .innerJoin(pendingInputs, eq(pendingInputs.id, specTaskAttempts.pendingInputId))
        .where(and(eq(specTaskAttempts.id, attemptId), eq(specTaskAttempts.specId, specId))).limit(1);
      if (!reference) throw new DomainError("NOT_FOUND", "Task attempt not found");
      const [conversation] = await tx.select().from(conversations).where(and(eq(conversations.id, owned.conversationId), eq(conversations.ownerUserId, ownerId))).for("update");
      if (!conversation) throw new DomainError("NOT_FOUND", "Specification not found");
      if (conversation.activeRunId) await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, conversation.activeRunId)).for("update");
      const [run] = reference.input.runId ? await tx.select().from(runs).where(eq(runs.id, reference.input.runId)).for("update") : [];
      const [spec] = await tx.select().from(specs).where(eq(specs.id, specId)).for("update");
      if (!spec) throw new DomainError("NOT_FOUND", "Specification not found");
      this.assertRevision(spec.currentRevision, expected);
      const [attempt] = await tx.select().from(specTaskAttempts).where(and(eq(specTaskAttempts.id, attemptId), eq(specTaskAttempts.specId, specId))).for("update");
      if (!attempt) throw new DomainError("NOT_FOUND", "Task attempt not found");
      if (attempt.revision !== expected) throw new DomainError("CONFLICT", "Attempt belongs to another revision", { reason: "SPEC_REVISION_STALE", currentRevision: spec.currentRevision });
      if (attempt.releasedAt) return { ...attempt, releasedAt: attempt.releasedAt.toISOString() };
      if (run?.state === "cancelled_unconfirmed") {
        const unresolved = run.checkpoint?.executions.filter((execution) => execution.result?.outcome === "unknown" || (!execution.result && execution.dispatch === "dispatched")) ?? [];
        const receipts = unresolved.length ? await tx.select().from(runnerOperations).where(and(eq(runnerOperations.runId, run.id), inArray(runnerOperations.toolCallId, unresolved.map((execution) => execution.callId)))) : [];
        const settledByReceipt = unresolved.length > 0 && receipts.length === unresolved.length && receipts.every((receipt) => receipt.knownOutcome && ["acked", "failed"].includes(receipt.status));
        if (!settledByReceipt) throw new DomainError("CONFLICT", "The original operation has no settled runner receipt", { reason: "EXECUTION_OUTCOME_UNKNOWN" });
        const resolvedAt = new Date();
        const resolution = { note: note ?? null, resolvedBy: ownerId, resolvedAt: resolvedAt.toISOString(), receiptIds: receipts.map((receipt) => receipt.id) };
        await tx.update(runs).set({ state: "cancelled", effectState: "known", failureReason: "RECONCILED", workerId: null, leaseUntil: null, updatedAt: resolvedAt }).where(eq(runs.id, run.id));
        const [updated] = await tx.update(specTaskAttempts).set({ releasedAt: resolvedAt, resolution }).where(and(eq(specTaskAttempts.id, attemptId), isNull(specTaskAttempts.releasedAt))).returning();
        if (conversation.activeRunId === run.id) {
          conversation.activeRunId = null;
          await tx.update(conversations).set({ activeRunId: null }).where(eq(conversations.id, conversation.id));
        }
        await this.journal.tx(tx).append(conversation, { runId: run.id, type: "run.changed", payload: { run: { id: run.id, state: "cancelled", reason: "RECONCILED" } } });
        await this.journal.tx(tx).append(conversation, { runId: run.id, type: "spec.changed", payload: { specId, revision: spec.currentRevision, change: "evidence" } });
        return { ...updated!, releasedAt: resolvedAt.toISOString() };
      }
      const settledRun = run && ["succeeded", "failed", "timed_out", "cancelled"].includes(run.state);
      const settledQueue = !run && ["removed", "rejected"].includes(reference.input.status);
      if (!settledRun && !settledQueue) throw new DomainError("CONFLICT", "The original operation has not been proven settled", { reason: "EXECUTION_OUTCOME_UNKNOWN" });
      const resolvedAt = new Date();
      const resolution = { note: note ?? null, resolvedBy: ownerId, resolvedAt: resolvedAt.toISOString() };
      const [updated] = await tx.update(specTaskAttempts).set({ releasedAt: resolvedAt, resolution }).where(and(eq(specTaskAttempts.id, attemptId), isNull(specTaskAttempts.releasedAt))).returning();
      return { ...updated!, releasedAt: resolvedAt.toISOString() };
    });
  }

  async recordEvidence(projectId: string, specId: string, ownerId: string, input: { expectedRevision: number; evidenceId: string; taskKey: string; checkKey: string; source: any }) {
    const revision = await this.transaction(async (tx) => {
      const { spec, conversation } = await this.lock(tx, projectId, specId, ownerId);
      this.assertRevision(spec.currentRevision, input.expectedRevision);
      const [version] = await tx.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, input.expectedRevision))).limit(1);
      if (!version) throw new DomainError("NOT_FOUND", "Specification revision not found");
      if (version.acceptance) throw new DomainError("CONFLICT", "Accepted revision is frozen", { reason: "SPEC_ACCEPTED" });
      const task = version.taskPlan.find((row) => row.key === input.taskKey), check = task?.checks.find((row) => row.key === input.checkKey);
      if (!task || !check) throw new DomainError("NOT_FOUND", "Task check not found");
      const previous = version.evidence.find((item) => item.id === input.evidenceId);
      if (previous) {
        const same = previous.taskKey === input.taskKey && previous.checkKey === input.checkKey && previous.note === input.source.note && previous.passed === (input.source.kind === "manual" ? input.source.passed : true);
        if (!same) throw new DomainError("CONFLICT", "Evidence ID reused with different content");
        return input.expectedRevision;
      }
      let entry: SpecEvidence;
      if (input.source.kind === "manual") {
        const [attempt] = await tx.select().from(specTaskAttempts).where(and(eq(specTaskAttempts.id, input.source.attemptId), eq(specTaskAttempts.specId, specId), eq(specTaskAttempts.revision, input.expectedRevision), eq(specTaskAttempts.taskKey, input.taskKey))).limit(1);
        if (!attempt) throw new DomainError("CONFLICT", "Evidence must match a current task attempt");
        if (!attempt.releasedAt) throw new DomainError("CONFLICT", "Task attempt is still active", { reason: "SPEC_BUSY" });
        entry = { id: input.evidenceId, taskKey: input.taskKey, checkKey: input.checkKey, passed: input.source.passed, source: "manual", attemptId: attempt.id, note: input.source.note, createdBy: ownerId, createdAt: new Date().toISOString() };
      } else {
        const [sourceVersion] = await tx.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, input.source.revision))).limit(1);
        const carried = sourceVersion?.evidence.find((item) => item.id === input.source.evidenceId && item.passed);
        if (!sourceVersion || !carried) throw new DomainError("CONFLICT", "Only passing evidence from this specification can be carried");
        const oldCheck = sourceVersion.taskPlan.find((row) => row.key === carried.taskKey)?.checks.find((row) => row.key === carried.checkKey);
        if (!oldCheck || !sameCheck(oldCheck, check)) throw new DomainError("CONFLICT", "Carried evidence does not match the reviewed check");
        entry = { id: input.evidenceId, taskKey: input.taskKey, checkKey: input.checkKey, passed: true, source: "carried", fromRevision: input.source.revision, reviewedBy: ownerId, note: input.source.note, createdBy: ownerId, createdAt: new Date().toISOString() };
      }
      await tx.update(specRevisions).set({ evidence: [...version.evidence, entry] }).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, input.expectedRevision)));
      await tx.update(specs).set({ updatedAt: new Date() }).where(eq(specs.id, specId));
      await this.changedEvent(tx, conversation, specId, input.expectedRevision, "evidence");
      return input.expectedRevision;
    });
    return this.get(projectId, specId, ownerId, revision);
  }

  async accept(projectId: string, specId: string, ownerId: string, expected: number) {
    const revision = await this.transaction(async (tx) => {
      const { spec, conversation } = await this.lock(tx, projectId, specId, ownerId);
      this.assertRevision(spec.currentRevision, expected);
      const [version] = await tx.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, expected))).limit(1);
      if (!version) throw new DomainError("NOT_FOUND", "Specification revision not found");
      if (version.acceptance) return expected;
      if (version.reviews.tasks?.revision !== expected) throw new DomainError("CONFLICT", "Confirm the task plan first", { reason: "SPEC_REVIEW_REQUIRED" });
      const [active] = await tx.select({ id: specTaskAttempts.id }).from(specTaskAttempts).where(and(eq(specTaskAttempts.specId, specId), isNull(specTaskAttempts.releasedAt))).limit(1);
      if (active) throw new DomainError("CONFLICT", "Task execution is still active", { reason: "SPEC_BUSY" });
      const allChecks = version.taskPlan.flatMap((task) => task.checks.map((check) => ({ taskKey: task.key, checkKey: check.key })));
      const latestAttempts = new Map<string, string>();
      for (const task of version.taskPlan) {
        const [latest] = await tx.select({ id: specTaskAttempts.id }).from(specTaskAttempts).where(and(eq(specTaskAttempts.specId, specId), eq(specTaskAttempts.revision, expected), eq(specTaskAttempts.taskKey, task.key))).orderBy(desc(specTaskAttempts.createdAt)).limit(1);
        if (latest) latestAttempts.set(task.key, latest.id);
      }
      const evidenceIds = allChecks.map(({ taskKey, checkKey }) => version.evidence.find((item) =>
        item.taskKey === taskKey && item.checkKey === checkKey && item.passed &&
        (latestAttempts.has(taskKey) ? item.attemptId === latestAttempts.get(taskKey) : item.source === "carried"),
      )?.id);
      if (!allChecks.length || evidenceIds.some((id) => !id)) throw new DomainError("CONFLICT", "All task checks need passing evidence", { reason: "SPEC_REVIEW_REQUIRED" });
      const acceptance = { reviewerId: ownerId, acceptedAt: new Date().toISOString(), evidenceIds: evidenceIds as string[] };
      await tx.update(specRevisions).set({ acceptance }).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, expected)));
      await tx.update(specs).set({ updatedAt: new Date() }).where(eq(specs.id, specId));
      await this.changedEvent(tx, conversation, specId, expected, "acceptance");
      return expected;
    });
    return this.get(projectId, specId, ownerId, revision);
  }

  async delete(projectId: string, specId: string, ownerId: string, expected: number) {
    return this.transaction(async (tx) => {
      const { spec, conversation } = await this.lock(tx, projectId, specId, ownerId);
      this.assertRevision(spec.currentRevision, expected);
      const [active] = await tx.select({ id: specTaskAttempts.id }).from(specTaskAttempts).where(and(eq(specTaskAttempts.specId, specId), isNull(specTaskAttempts.releasedAt))).limit(1);
      if (active || conversation.activeRunId || await this.hasUnknownRun(tx, conversation.id)) throw new DomainError("CONFLICT", "Settle active specification work before deleting");
      await tx.delete(pendingInputs).where(eq(pendingInputs.conversationId, conversation.id));
      await tx.delete(messages).where(eq(messages.conversationId, conversation.id));
      await this.events.tx(tx).deleteConversation(conversation.id);
      await tx.delete(runs).where(eq(runs.conversationId, conversation.id));
      await tx.delete(specs).where(eq(specs.id, specId));
      await tx.delete(conversations).where(eq(conversations.id, conversation.id));
      return null;
    });
  }
}

function attemptStatus(inputStatus: string, runState: string | null, releasedAt: Date | null) {
  if (runState === "cancelled_unconfirmed" || (!releasedAt && inputStatus !== "queued" && runState == null)) return "needs_reconciliation";
  if (inputStatus === "queued") return "queued";
  if (["running", "waiting", "paused", "cancelling"].includes(runState ?? "")) return runState === "waiting" ? "waiting" : "running";
  if (runState === "succeeded") return "needs_verification";
  if (runState === "failed") return "failed";
  if (runState === "timed_out") return "timed_out";
  if (["cancelled", "cancelled_unconfirmed"].includes(runState ?? "")) return "cancelled";
  return "needs_verification";
}
