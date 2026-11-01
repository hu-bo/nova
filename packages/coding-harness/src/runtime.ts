import {
  FrameworkError,
  type AgentKernel,
  type AgentMessage,
  type AgentSession,
  type JsonValue,
  type OperationOptions,
  type RunResult,
  type SafeError,
} from "@nnova/harness";
import type { CodingHarness, CodingHarnessOptions, CodingRunOptions, CodingResumeOptions } from "./contracts.js";
import { positiveInteger } from "./configuration.js";

type Reporter = (diagnostic: SafeError) => void;
type Observers = {
  [Key in "onEvent" | "onRunResult" | "onToolResult"]: CodingHarnessOptions[Key];
};

export function createDiagnosticReporter(callback: CodingHarnessOptions["onDiagnostic"]): Reporter {
  return (diagnostic) => {
    try {
      if (callback) callback(diagnostic);
      else process.emitWarning(diagnostic.message, { code: diagnostic.code });
    } catch {
      process.emitWarning("Coding Harness diagnostic callback failed.", { code: "DIAGNOSTIC_FAILED" });
    }
  };
}

export class CodingHarnessRuntime implements CodingHarness {
  private closing: Promise<void> | undefined;

  constructor(
    private readonly kernel: AgentKernel,
    readonly session: AgentSession,
    private readonly maxRunMs: number,
    private readonly observers: Observers,
    private readonly report: Reporter,
  ) {}

  async run(input: string | AgentMessage, options: CodingRunOptions = {}): Promise<RunResult> {
    this.assertOpen();
    const result = await this.session.send({
      ...this.operationOptions(options),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(typeof input === "string" ? { text: input } : { message: input }),
    });
    this.notifyResult(result);
    return result;
  }

  async resume(options: CodingResumeOptions): Promise<RunResult> {
    this.assertOpen();
    const result = await this.session.resume({
      ...this.operationOptions(options),
      runId: options.runId,
      continuationId: options.continuationId,
      input: options.input,
    });
    this.notifyResult(result);
    return result;
  }

  compact(options: OperationOptions = {}) {
    this.assertOpen();
    return this.session.compact(this.operationOptions(options));
  }

  cancel(): void {
    this.session.cancel();
  }

  updateModel(configuration: JsonValue): void {
    this.assertOpen();
    this.kernel.updateModel(configuration);
  }

  inspect() {
    return this.session.inspect();
  }
  inspectPlugins() {
    return this.kernel.inspectPlugins();
  }

  close(): Promise<void> {
    // Concurrent callers must await the same cleanup, including the same failure.
    this.closing ??= Promise.resolve().then(() => this.kernel.dispose());
    return this.closing;
  }

  private assertOpen(): void {
    if (this.closing) throw new FrameworkError("CLOSED", "Coding Harness is closed.");
  }

  private operationOptions(options: OperationOptions): OperationOptions {
    const requested = options.timeoutMs === undefined ? this.maxRunMs : positiveInteger(options.timeoutMs, "timeoutMs");
    return {
      timeoutMs: Math.min(requested, this.maxRunMs),
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onEvent: (event) => {
        this.observe(this.observers.onEvent, event);
        this.observe(options.onEvent, event);
      },
    };
  }

  private notifyResult(result: RunResult): void {
    this.observe(this.observers.onRunResult, result);
    this.observe(this.observers.onToolResult, result);
  }

  private observe<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T): void {
    if (!callback) return;
    const failed = () => this.report({ code: "OBSERVER_FAILED", message: "A Coding Harness observer failed." });
    try {
      const result = callback(structuredClone(value));
      if (result) void Promise.resolve(result).catch(failed);
    } catch {
      failed();
    }
  }
}
