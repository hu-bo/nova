import type {
  AgentEvent,
  AgentInspection,
  AgentMessage,
  AgentSession,
  CompactResult,
  JsonValue,
  OperationOptions,
  PluginDefinition,
  PluginInspection,
  ReasoningEffort,
  RunResult,
  SafeError,
  ToolContext,
  ToolDefinition,
  ToolPolicy,
} from "@nnova/harness";
import type { RunnerSession, ToolContext as RunnerToolContext } from "@nova/runner-sdk";

export interface OpenAICompatibleModelOptions {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly images?: boolean;
  readonly files?: boolean;
}

/** The plugin supplies Harness modelRouter; protocol details stay inside the adapter. */
export interface PluginModelOptions {
  readonly plugin: PluginDefinition;
  readonly modelId: string;
}

export type CodingModelOptions = OpenAICompatibleModelOptions | PluginModelOptions;

export interface RemoteExecutionOptions {
  readonly session: RunnerSession;
  readonly workspaceId: string;
  readonly cwd?: string;
  readonly createContext?: (
    input: ToolContext,
    options: { workspaceId: string; cwd?: string; session: RunnerSession },
  ) => Promise<RunnerToolContext> | RunnerToolContext;
}

export interface PlanGateOptions {
  /** Workspace-relative file, resolved by the Runner in the configured cwd. */
  readonly path?: string;
  /** Host-confirmed write from a previous session. This is not human approval. */
  readonly alreadyWritten?: boolean;
}

export interface CodingHarnessProfile {
  readonly systemPrompt: string;
  readonly plan?: PlanGateOptions;
}

/** Replace one capability provider without installing a second provider for the same key. */
export interface CodingHarnessComponents {
  readonly sessionStore?: PluginDefinition;
  readonly context?: PluginDefinition;
  readonly toolRuntime?: PluginDefinition;
  readonly loop?: PluginDefinition;
}

interface HarnessConfiguration {
  readonly model: CodingModelOptions;
  readonly sessionId?: string;
  readonly namespace?: string;
  readonly identity?: Readonly<Record<string, JsonValue>>;
  readonly profile?: CodingHarnessProfile;
  readonly instructions?: string;
  /** Additional host tools. Duplicate names are rejected, including remote tool names. */
  readonly tools?: readonly ToolDefinition[];
  /** Defaults to the directly supplied tools. Plugin-contributed tools require explicit inclusion. */
  readonly allowedTools?: readonly string[];
  /** Every policy must allow the operation; approval and tenant rules can be supplied here. */
  readonly policies?: readonly ToolPolicy[];
  readonly components?: CodingHarnessComponents;
  readonly plugins?: readonly PluginDefinition[];
  readonly maxSteps?: number;
  readonly maxToolCalls?: number;
  readonly maxRunMs?: number;
  readonly maxParallelReads?: number;
  readonly maxParallelWrites?: number;
  readonly maxToolOutputBytes?: number;
  /** @deprecated Use profile.plan.alreadyWritten. */
  readonly planAlreadyAccepted?: boolean;
  /** Best-effort observations; use a SessionStore plugin for authoritative persistence. */
  readonly onEvent?: (event: AgentEvent) => void | Promise<void>;
  readonly onRunResult?: (result: RunResult) => void | Promise<void>;
  /** @deprecated This receives the whole RunResult. Use onRunResult. */
  readonly onToolResult?: (result: RunResult) => void | Promise<void>;
  readonly onDiagnostic?: (diagnostic: SafeError) => void;
}

/** Absence of a Runner is explicit; partial remote configuration cannot degrade into chat. */
export type CodingHarnessOptions = HarnessConfiguration &
  (
    | RemoteExecutionOptions
    | { readonly session?: never; readonly workspaceId?: never; readonly cwd?: never; readonly createContext?: never }
  );

export interface CodingRunOptions extends OperationOptions {
  readonly reasoningEffort?: ReasoningEffort;
}

export type CodingResumeOptions = OperationOptions & {
  readonly runId: string;
  readonly continuationId: string;
  readonly input: JsonValue;
};

export interface CodingHarness {
  /** Native session escape hatch; facade limits and observers apply to facade methods only. */
  readonly session: AgentSession;
  run(input: string | AgentMessage, options?: CodingRunOptions): Promise<RunResult>;
  resume(options: CodingResumeOptions): Promise<RunResult>;
  compact(options?: OperationOptions): Promise<CompactResult>;
  cancel(): void;
  updateModel(configuration: JsonValue): void;
  inspect(): Promise<AgentInspection>;
  inspectPlugins(): readonly PluginInspection[];
  close(): Promise<void>;
}
