import { parseSpecDocument, specDesignAcceptanceHeading, specDesignSections } from "@nova/agent-ui-contracts/spec";
import { DomainError } from "../../shared/domain-error.js";
import type { SpecEvidence, SpecTask } from "../../../database/schema/spec-revision.table.js";

/** A retry supersedes earlier evidence; carried evidence applies only before the first attempt. */
export function passingEvidenceForCheck<
  Evidence extends Pick<SpecEvidence, "taskKey" | "checkKey" | "passed" | "source"> & { attemptId?: string | undefined },
>(
  evidence: readonly Evidence[],
  taskKey: string,
  checkKey: string,
  latestAttemptId: string | undefined,
): Evidence | undefined {
  return evidence.find((entry) =>
    entry.taskKey === taskKey && entry.checkKey === checkKey && entry.passed &&
    (latestAttemptId ? entry.attemptId === latestAttemptId : entry.source === "carried"),
  );
}

export function validateDesign(markdown: string) {
  const { sections, acceptanceHeadings } = parseSpecDocument(markdown);
  const missingSections = specDesignSections.filter((title) =>
    !sections.some((section) => section.title === title && (title === specDesignAcceptanceHeading || section.hasContent)),
  );
  if (missingSections.length) {
    throw new DomainError("VALIDATION_ERROR", `Design needs content under ${missingSections.join(", ")}`, { reason: "SPEC_DESIGN_SECTIONS_MISSING", missingSections });
  }
  if (!acceptanceHeadings.length) {
    throw new DomainError("VALIDATION_ERROR", `Design needs acceptance criteria under ## ${specDesignAcceptanceHeading}`, { reason: "SPEC_CRITERIA_MISSING" });
  }
  const seen = new Set<string>();
  for (const { id, hasContent } of acceptanceHeadings) {
    if (!id || !hasContent) {
      throw new DomainError("VALIDATION_ERROR", "Use level-three headings such as ### AC-01 and describe each expected outcome", { reason: "SPEC_CRITERION_FORMAT" });
    }
    if (seen.has(id)) {
      throw new DomainError("VALIDATION_ERROR", `Acceptance criterion ID ${id} is repeated`, { reason: "SPEC_CRITERION_DUPLICATE", criterionId: id });
    }
    seen.add(id);
  }
}

export function validateTaskPlan(tasks: SpecTask[], criteria: string[]) {
  const taskIds = new Set<string>();
  const graph = new Map<string, string[]>();
  const covered = new Set<string>();
  for (const task of tasks) {
    if (!task.designRef?.trim()) throw new DomainError("VALIDATION_ERROR", `Task ${task.key} needs a design reference`, { reason: "SPEC_DESIGN_REF_MISSING", taskKey: task.key });
    if (taskIds.has(task.key)) throw new DomainError("VALIDATION_ERROR", `Duplicate task ${task.key}`);
    taskIds.add(task.key); graph.set(task.key, task.dependsOn);
    const checkIds = new Set<string>();
    for (const check of task.checks) {
      if (checkIds.has(check.key)) throw new DomainError("VALIDATION_ERROR", `Duplicate check ${task.key}/${check.key}`);
      checkIds.add(check.key);
      for (const criterion of check.criterionIds) covered.add(criterion);
    }
  }
  for (const task of tasks) for (const dep of task.dependsOn)
    if (dep === task.key || !taskIds.has(dep)) throw new DomainError("VALIDATION_ERROR", `Invalid dependency ${task.key} -> ${dep}`);
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dep of graph.get(id) ?? []) if (!visit(dep)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  for (const id of taskIds) if (!visit(id)) throw new DomainError("VALIDATION_ERROR", "Task dependencies contain a cycle");
  const allowed = new Set(criteria);
  for (const task of tasks) for (const check of task.checks) for (const id of check.criterionIds)
    if (!allowed.has(id)) throw new DomainError("VALIDATION_ERROR", `Unknown acceptance criterion ${id}`);
  for (const id of criteria) if (!covered.has(id)) throw new DomainError("VALIDATION_ERROR", `Acceptance criterion ${id} has no verification task`);
}
