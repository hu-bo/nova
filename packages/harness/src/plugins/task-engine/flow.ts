import { randomUUID } from "node:crypto";
import type { FlowHandle, FlowSpec, FlowResult, FlowNode } from "../../contracts/flow.js";
import type { TaskHandle, TaskSnapshot, TaskSpec, TaskResult } from "../../contracts/task.js";
import type { JsonValue } from "../../contracts/message.js";
import type { FlowPredicate } from "../../contracts/flow.js";
import { FrameworkError } from "../../contracts/errors.js";
import { jsonValue } from "../../shared/json.js";
import { terminal } from "./task-state.js";
interface FlowTasks {
  validate(spec: TaskSpec, bindings: boolean): TaskSpec;
  ensureCapacity(count: number): void;
  accept(spec: TaskSpec, flowId: string): TaskHandle;
  get(id: string): TaskSnapshot | undefined;
  ready(id: string, input: JsonValue): void;
  cancel(id: string): void;
  skip(id: string): void;
  fail(id: string, error: FrameworkError): void;
  retain(id: string): () => void;
  discard(id: string): void;
}
interface ActiveFlow {
  spec: FlowSpec;
  ids: Map<string, string>;
  complete(result: FlowResult): void;
  release: Array<() => void>;
  cancelling: boolean;
  scheduled: boolean;
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
export class FlowCoordinator {
  private readonly flows = new Map<string, ActiveFlow>();
  constructor(
    private readonly tasks: FlowTasks,
    private readonly maxNodes: number,
    private readonly predicates: ReadonlyMap<string, FlowPredicate> = new Map(),
  ) {}
  submit(input: FlowSpec): FlowHandle {
    let spec: FlowSpec;
    try {
      spec = structuredClone<FlowSpec>(input);
    } catch {
      throw new FrameworkError("INVALID_FLOW", "Flow must be serializable.");
    }
    if (
      !(spec.nodes instanceof Array) ||
      !spec.nodes.length ||
      spec.nodes.length > this.maxNodes ||
      !Number.isSafeInteger(spec.maxConcurrency) ||
      spec.maxConcurrency < 1 ||
      !Number.isSafeInteger(spec.deadlineAt) ||
      spec.deadlineAt <= Date.now()
    )
      throw new FrameworkError("INVALID_FLOW", "Invalid Flow limits.");
    if (
      typeof spec.outputNode !== "string" ||
      !spec.outputNode ||
      (spec.failurePolicy !== undefined && !["fail-fast", "continue-independent"].includes(spec.failurePolicy))
    )
      throw new FrameworkError("INVALID_FLOW", "Invalid Flow policy or output node.");
    const nodes = new Map<string, FlowNode>();
    for (const node of spec.nodes) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(node.id) ||
        nodes.has(node.id) ||
        !node.task ||
        typeof node.task !== "object" ||
        Array.isArray(node.task) ||
        (node.dependsOn !== undefined && !(node.dependsOn instanceof Array)) ||
        (node.inputBindings !== undefined && !isPlainRecord(node.inputBindings)) ||
        (node.condition !== undefined &&
          (!isPlainRecord(node.condition) ||
            typeof node.condition.nodeId !== "string" ||
            typeof node.condition.predicate !== "string"))
      )
        throw new FrameworkError("INVALID_FLOW", "Duplicate or invalid node ID.");
      if (
        node.dependsOn?.some((dependency) => typeof dependency !== "string" || dependency.length === 0) ||
        Object.values(node.inputBindings ?? {}).some(
          (binding) =>
            !isPlainRecord(binding) ||
            typeof binding.nodeId !== "string" ||
            !(binding.path instanceof Array) ||
            binding.path.some((part) => typeof part !== "string" || part.length === 0),
        )
      )
        throw new FrameworkError("INVALID_FLOW", "Invalid dependency or binding.");
      if (
        node.join !== undefined &&
        !["all-success", "all-settled", "selected-success", "any-success", "race"].includes(node.join)
      )
        throw new FrameworkError("INVALID_FLOW", "Invalid node join policy.");
      node.task = this.tasks.validate(
        {
          ...node.task,
          deadlineAt: Math.min(node.task.deadlineAt, spec.deadlineAt),
        },
        !!node.inputBindings,
      );
      nodes.set(node.id, node);
    }
    if (!nodes.has(spec.outputNode)) throw new FrameworkError("INVALID_FLOW", "Unknown output node.");
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new FrameworkError("FLOW_CYCLE", "Flow cycle at node: " + id);
      if (done.has(id)) return;
      const node = nodes.get(id);
      if (!node) throw new FrameworkError("INVALID_FLOW", "Unknown dependency: " + id);
      visiting.add(id);
      const dependencies = node.dependsOn ?? [];
      if (new Set(dependencies).size !== dependencies.length)
        throw new FrameworkError("INVALID_FLOW", "A node cannot depend on the same node twice.");
      for (const dependency of dependencies) visit(dependency);
      for (const [field, binding] of Object.entries(node.inputBindings ?? {})) {
        if (
          !dependencies.includes(binding.nodeId) ||
          !nodes.has(binding.nodeId) ||
          [field, ...binding.path].some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part))
        )
          throw new FrameworkError(
            "INVALID_BINDING",
            "Binding must reference an explicit dependency using safe paths.",
          );
      }
      if (node.condition) {
        if (!dependencies.includes(node.condition.nodeId))
          throw new FrameworkError("INVALID_CONDITION", "A condition must reference an explicit dependency.");
        if (
          node.condition.predicate !== "truthy" &&
          node.condition.predicate !== "falsy" &&
          !this.predicates.has(node.condition.predicate)
        )
          throw new FrameworkError("UNKNOWN_CONDITION", "Condition predicate is not registered.");
      }
      visiting.delete(id);
      done.add(id);
    };
    for (const id of nodes.keys()) visit(id);
    this.tasks.ensureCapacity(spec.nodes.length);
    const flowId = randomUUID();
    const ids = new Map<string, string>();
    let complete!: (result: FlowResult) => void;
    const result = new Promise<FlowResult>((resolve) => {
      complete = resolve;
    });
    const release: Array<() => void> = [];
    const created: TaskHandle[] = [];
    try {
      for (const node of spec.nodes) {
        const task = this.tasks.accept(node.task, flowId);
        created.push(task);
        ids.set(node.id, task.taskId);
        release.push(this.tasks.retain(task.taskId));
      }
    } catch (error) {
      for (const releaseTask of [...release].reverse()) releaseTask();
      for (const task of created) this.tasks.discard(task.taskId);
      throw error;
    }
    const flow: ActiveFlow = {
      spec,
      ids,
      complete,
      release,
      cancelling: false,
      scheduled: false,
    };
    this.flows.set(flowId, flow);
    this.changed(flowId);
    return {
      flowId,
      result: () => result.then((value) => structuredClone(value)),
      cancel: () => {
        flow.cancelling = true;
        for (const id of ids.values()) this.tasks.cancel(id);
        this.changed(flowId);
      },
    };
  }
  canRun(flowId: string | undefined, tasks: readonly TaskSnapshot[]): boolean {
    if (!flowId) return true;
    const flow = this.flows.get(flowId);
    return (
      !!flow &&
      tasks.filter((task) => task.flowId === flowId && (task.status === "running" || task.status === "cancelling"))
        .length < flow.spec.maxConcurrency
    );
  }
  changed(flowId: string | undefined): void {
    if (!flowId) return;
    const flow = this.flows.get(flowId);
    if (!flow || flow.scheduled) return;
    flow.scheduled = true;
    queueMicrotask(() => {
      flow.scheduled = false;
      try {
        this.update(flowId, flow);
      } catch (error) {
        this.failFlow(flowId, flow, error);
      }
    });
  }
  private failFlow(flowId: string, flow: ActiveFlow, error: unknown): void {
    const failure =
      error instanceof FrameworkError ? error : new FrameworkError("FLOW_STATE", "Flow state became invalid.");
    for (const id of flow.ids.values()) {
      const task = this.tasks.get(id);
      if (!task || terminal(task.status)) continue;
      if (task.status === "blocked" || task.status === "queued" || task.status === "retry_wait")
        this.tasks.fail(id, failure);
      else this.tasks.cancel(id);
    }
    if (this.flows.has(flowId)) this.update(flowId, flow);
  }
  private update(flowId: string, flow: ActiveFlow): void {
    const snapshots = new Map<string, TaskSnapshot>();
    for (const [node, id] of flow.ids) {
      const snapshot = this.tasks.get(id);
      if (!snapshot) throw new FrameworkError("FLOW_STATE", "Retained task disappeared.");
      snapshots.set(node, snapshot);
    }
    const failed = [...snapshots.entries()].some(
      ([node, task]) =>
        ["failed", "timed_out"].includes(task.status) && !this.isPendingRaceCandidate(flow, node, snapshots),
    );
    if (failed && (flow.spec.failurePolicy ?? "fail-fast") === "fail-fast") {
      for (const task of snapshots.values()) {
        if (task.status === "blocked") this.tasks.skip(task.taskId);
        else if (!terminal(task.status)) this.tasks.cancel(task.taskId);
      }
    } else if (!flow.cancelling) {
      for (const node of flow.spec.nodes) {
        const task = snapshots.get(node.id);
        if (!task || task.status !== "blocked") continue;
        const dependencies = (node.dependsOn ?? []).map((id) => snapshots.get(id));
        const isRaceJoin = node.join === "any-success" || node.join === "race";
        const successfulDependency = dependencies.find((dependency) => dependency?.status === "succeeded");
        if (isRaceJoin) {
          if (!successfulDependency) {
            if (dependencies.some((dependency) => !dependency || !terminal(dependency.status))) continue;
            this.tasks.skip(task.taskId);
            continue;
          }
          for (const dependency of dependencies)
            if (dependency && dependency.taskId !== successfulDependency.taskId && !terminal(dependency.status))
              this.tasks.cancel(dependency.taskId);
          if (dependencies.some((dependency) => !dependency || !terminal(dependency.status))) continue;
        } else if (dependencies.some((dependency) => !dependency || !terminal(dependency.status))) continue;
        if (node.condition) {
          let matches: boolean;
          try {
            matches = this.conditionMatches(node, snapshots);
          } catch (error) {
            this.tasks.fail(
              task.taskId,
              error instanceof FrameworkError
                ? error
                : new FrameworkError("CONDITION_FAILED", "Flow condition failed."),
            );
            continue;
          }
          if (!matches) {
            this.tasks.skip(task.taskId);
            continue;
          }
        }
        if (isRaceJoin) {
          try {
            this.tasks.ready(task.taskId, this.bind(node, snapshots));
          } catch (error) {
            this.tasks.fail(
              task.taskId,
              error instanceof FrameworkError ? error : new FrameworkError("INVALID_BINDING", "Input binding failed."),
            );
          }
          continue;
        }
        const failedDependency = dependencies.some((dependency) =>
          ["failed", "timed_out", "cancelled"].includes(dependency?.status ?? "failed"),
        );
        const unsuccessfulDependency = dependencies.some((dependency) => dependency?.status !== "succeeded");
        const selectedDependencies = dependencies.filter((dependency) => dependency?.status !== "skipped");
        let blocked = unsuccessfulDependency;
        if (node.join === "all-settled") blocked = false;
        else if (node.join === "selected-success") blocked = failedDependency || selectedDependencies.length === 0;
        if (blocked) {
          this.tasks.skip(task.taskId);
          continue;
        }
        try {
          this.tasks.ready(task.taskId, this.bind(node, snapshots));
        } catch (error) {
          this.tasks.fail(
            task.taskId,
            error instanceof FrameworkError ? error : new FrameworkError("INVALID_BINDING", "Input binding failed."),
          );
        }
      }
    }
    const current = [...flow.ids.entries()].map(([node, id]) => [node, this.tasks.get(id)] as const);
    if (!current.every(([, task]) => task && terminal(task.status))) return;
    const results: Record<string, TaskResult> = {};
    for (const [node, task] of current) if (task?.result) results[node] = task.result;
    const output = results[flow.spec.outputNode];
    const values = Object.entries(results).filter(([node]) => !this.isRaceCandidate(flow, node));
    let status: FlowResult["status"] = "succeeded";
    if (flow.cancelling) status = "cancelled";
    else if (values.some(([, result]) => result.status === "timed_out")) status = "timed_out";
    else if (values.some(([, result]) => result.status === "failed") || output?.status !== "succeeded")
      status = "failed";
    flow.complete({
      status,
      nodes: results,
      ...(output?.output === undefined ? {} : { output: output.output }),
    });
    for (const release of flow.release) release();
    this.flows.delete(flowId);
  }
  private conditionMatches(node: FlowNode, snapshots: ReadonlyMap<string, TaskSnapshot>): boolean {
    const condition = node.condition;
    if (!condition) return true;
    const output = snapshots.get(condition.nodeId)?.result?.output ?? null;
    if (condition.predicate === "truthy") return Boolean(output);
    if (condition.predicate === "falsy") return !output;
    const predicate = this.predicates.get(condition.predicate);
    if (!predicate) throw new FrameworkError("UNKNOWN_CONDITION", "Condition predicate is not registered.");
    try {
      return predicate(structuredClone(output));
    } catch {
      throw new FrameworkError("CONDITION_FAILED", "Flow condition could not be evaluated.");
    }
  }
  private isPendingRaceCandidate(
    flow: ActiveFlow,
    candidateNode: string,
    snapshots: ReadonlyMap<string, TaskSnapshot>,
  ): boolean {
    return flow.spec.nodes.some(
      (node) =>
        (node.join === "any-success" || node.join === "race") &&
        node.dependsOn?.includes(candidateNode) &&
        !!snapshots.get(node.id) &&
        !terminal(snapshots.get(node.id)?.status ?? "failed"),
    );
  }
  private isRaceCandidate(flow: ActiveFlow, candidateNode: string): boolean {
    return flow.spec.nodes.some(
      (node) => (node.join === "any-success" || node.join === "race") && node.dependsOn?.includes(candidateNode),
    );
  }
  private bind(node: FlowNode, snapshots: ReadonlyMap<string, TaskSnapshot>): JsonValue {
    if (!node.inputBindings) return node.task.input;
    const original = node.task.input;
    if (!original || typeof original !== "object" || Array.isArray(original))
      throw new FrameworkError("INVALID_BINDING", "Bound inputs must be objects.");
    const input = { ...original };
    for (const [key, binding] of Object.entries(node.inputBindings)) {
      let value = snapshots.get(binding.nodeId)?.result?.output;
      for (const part of binding.path) {
        if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, part))
          throw new FrameworkError("INVALID_BINDING", "Output binding path does not exist.");
        value = value[part];
      }
      if (value === undefined) throw new FrameworkError("INVALID_BINDING", "Dependency has no output.");
      input[key] = value;
    }
    return jsonValue(input);
  }
}
