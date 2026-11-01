import type { TaskSnapshot, TaskStatus } from "../../contracts/task.js";
import { FrameworkError } from "../../contracts/errors.js";
export const terminal = (status: TaskStatus): boolean =>
  ["succeeded", "failed", "cancelled", "timed_out", "skipped"].includes(status);
const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  blocked: ["queued", "skipped", "cancelled", "timed_out", "failed"],
  queued: ["running", "cancelled", "timed_out", "skipped", "failed"],
  running: ["succeeded", "failed", "waiting", "retry_wait", "cancelling", "cancelled", "timed_out"],
  cancelling: ["cancelled", "timed_out", "failed"],
  waiting: ["queued", "cancelled", "timed_out", "failed"],
  retry_wait: ["queued", "cancelled", "timed_out", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  skipped: [],
};
export function transition(task: TaskSnapshot, status: TaskStatus, changes: Partial<TaskSnapshot> = {}): TaskSnapshot {
  if (!transitions[task.status].includes(status))
    throw new FrameworkError("INVALID_TASK_STATE", task.status + " cannot transition to " + status);
  return { ...task, ...changes, status };
}
