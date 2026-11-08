import { DomainError } from "../../shared/domain-error.js";
import type { SpecTask } from "../../../database/schema/spec-revision.table.js";

export function acceptanceCriteriaIn(markdown: string) {
  const found: string[] = [];
  let fence: string | null = null;
  let inAcceptanceSection = false;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceLine = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceLine) {
      if (fence === null) fence = fenceLine[0]!;
      else if (fenceLine[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const section = /^##\s+(.+?)\s*$/.exec(line);
    if (section) { inAcceptanceSection = section[1] === "验收条件"; continue; }
    if (!inAcceptanceSection) continue;
    const match = /^###\s+(AC-\d{2,})(?:\s|$)/.exec(line);
    if (match) found.push(match[1]!);
  }
  return found;
}

export function validateTaskPlan(tasks: SpecTask[], criteria: string[]) {
  const taskIds = new Set<string>();
  const graph = new Map<string, string[]>();
  const covered = new Set<string>();
  for (const task of tasks) {
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
