import { createAgent } from "@nova/agent-core";
import type {
  Agent,
  AgentConfig,
  AgentEvent,
  AgentHooks,
  AgentTool,
  PromptAsset,
  Risk,
  ToolCall,
} from "@nova/agent-core";

export interface AgentModule {
  readonly id: string;
  readonly tools?: readonly AgentTool[];
  readonly prompts?: readonly PromptAsset[];
  readonly guards?: readonly ToolGuard[];
  readonly observers?: readonly AgentObserver[];
}

export type ToolGuard = (
  call: ToolCall & { risk: Risk },
  signal: AbortSignal,
) => "ask" | "deny" | undefined | Promise<"ask" | "deny" | undefined>;
export type AgentObserver = (event: AgentEvent) => void | Promise<void>;

export interface HarnessConfig {
  modules: readonly AgentModule[];
  onGuardError?: (error: unknown, moduleId: string) => void;
  onObserverError?: (error: unknown, moduleId: string) => void;
}

export type HarnessAgentConfig = Omit<AgentConfig, "tools" | "systemPrompt" | "hooks"> & {
  systemPrompt?: readonly PromptAsset[];
  hooks?: AgentHooks;
};

export interface Harness {
  createAgent(config: HarnessAgentConfig): Agent;
  readonly moduleIds: readonly string[];
  readonly toolNames: readonly string[];
}

interface Contribution<T> {
  moduleId: string;
  value: T;
}

export function createHarness(config: HarnessConfig): Harness {
  const moduleIds: string[] = [];
  const tools: AgentTool[] = [];
  const prompts: PromptAsset[] = [];
  const guards: Contribution<ToolGuard>[] = [];
  const observers: Contribution<AgentObserver>[] = [];
  const ids = new Set<string>();
  const toolNames = new Set<string>();
  const promptNames = new Set<string>();

  for (const module of config.modules) {
    if (!module.id) throw new Error("module id must not be empty");
    unique(ids, module.id, "module id");
    moduleIds.push(module.id);
    for (const tool of module.tools ?? []) {
      unique(toolNames, tool.name, "tool name");
      tools.push(tool);
    }
    for (const prompt of module.prompts ?? []) {
      unique(promptNames, prompt.name, "prompt name");
      prompts.push(Object.freeze({ ...prompt }));
    }
    for (const guard of module.guards ?? []) guards.push(Object.freeze({ moduleId: module.id, value: guard }));
    for (const observer of module.observers ?? [])
      observers.push(Object.freeze({ moduleId: module.id, value: observer }));
  }

  const resolvedModuleIds = Object.freeze([...moduleIds]);
  const resolvedToolNames = Object.freeze([...toolNames]);
  const resolvedTools = Object.freeze([...tools]);
  const resolvedPrompts = Object.freeze([...prompts]);
  const resolvedGuards = Object.freeze([...guards]);
  const resolvedObservers = Object.freeze([...observers]);

  return Object.freeze({
    moduleIds: resolvedModuleIds,
    toolNames: resolvedToolNames,
    createAgent(agentConfig: HarnessAgentConfig): Agent {
      const instancePrompts = [...(agentConfig.systemPrompt ?? [])];
      const names = new Set(promptNames);
      for (const prompt of instancePrompts) unique(names, prompt.name, "prompt name");

      const hooks = combineHooks(agentConfig.hooks, resolvedGuards, config.onGuardError);
      const agent = createAgent({
        ...agentConfig,
        tools: [...resolvedTools],
        systemPrompt: [...resolvedPrompts, ...instancePrompts],
        ...(hooks ? { hooks } : {}),
      });

      if (resolvedObservers.length > 0) {
        agent.subscribe((event) => {
          for (const observer of resolvedObservers) invokeObserver(observer, event, config.onObserverError);
        });
      }
      return agent;
    },
  });
}

function unique(seen: Set<string>, value: string, kind: string): void {
  if (seen.has(value)) throw new Error(`duplicate ${kind}: ${value}`);
  seen.add(value);
}

function combineHooks(
  hooks: AgentHooks | undefined,
  guards: readonly Contribution<ToolGuard>[],
  onError: HarnessConfig["onGuardError"],
): AgentHooks | undefined {
  if (guards.length === 0) return hooks;
  return {
    ...hooks,
    async beforeToolCall(call, signal) {
      let verdict: "allow" | "ask" | "deny" | undefined;
      for (const guard of guards) {
        if (signal.aborted) throw signal.reason;
        try {
          verdict = stricter(verdict, await guard.value(call, signal));
        } catch (error) {
          report(onError, error, guard.moduleId);
          verdict = "deny";
        }
      }
      if (hooks?.beforeToolCall) verdict = stricter(verdict, await hooks.beforeToolCall(call, signal));
      return verdict;
    },
  };
}

function stricter(
  current: "allow" | "ask" | "deny" | undefined,
  next: "allow" | "ask" | "deny" | undefined,
): "allow" | "ask" | "deny" | undefined {
  if (current === "deny" || next === "deny") return "deny";
  if (current === "ask" || next === "ask") return "ask";
  return current ?? next;
}

function invokeObserver(
  entry: Contribution<AgentObserver>,
  event: AgentEvent,
  onError: HarnessConfig["onObserverError"],
): void {
  try {
    const pending = entry.value(event);
    if (pending && typeof pending.then === "function")
      void pending.catch((error) => report(onError, error, entry.moduleId));
  } catch (error) {
    report(onError, error, entry.moduleId);
  }
}

function report(
  handler: ((error: unknown, moduleId: string) => void) | undefined,
  error: unknown,
  moduleId: string,
): void {
  try {
    handler?.(error, moduleId);
  } catch {
    /* error reporting must stay observational */
  }
}
