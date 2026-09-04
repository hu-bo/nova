// §6 Decision —— 审批与反问同构：挂起 → 发请求 → 等人类 → 恢复。agent-core 只依赖 Decide 一个回调。
import type {
  AgentEvent,
  ApprovalMode,
  ApprovalPolicy,
  CodeChange,
  Decide,
  DecisionRequest,
  DecisionResponse,
  FileSystem,
  Risk,
} from "../types.js";
import { record } from "../session/record.js";
import type { SessionStorage } from "../session/storage.js";

export const DECISION_TIMEOUT_MS = 5 * 60_000; // 等待人类必须有 timeout，缺省 5 分钟

export interface DecisionDeps {
  decide: Decide;
  sessionId: string;
  storage: SessionStorage;
  runId: () => string;
  emit: (event: AgentEvent) => void;
  timeoutMs?: number;
  fs?: FileSystem;
}

// 缺省策略：read → auto，write / exec → ask（none 不触发审批）
const DEFAULT_POLICY: Required<Pick<ApprovalPolicy, "default">> & ApprovalPolicy = {
  default: "ask",
  byRisk: { none: "auto", read: "auto", write: "ask", exec: "ask" },
};

export function approvalMode(
  policy: ApprovalPolicy | undefined,
  toolName: string,
  risk: Risk,
  allowlist: ReadonlySet<string>,
): ApprovalMode {
  if (allowlist.has(toolName)) return "auto";
  const effective = policy ?? DEFAULT_POLICY;
  return effective.byTool?.[toolName] ?? effective.byRisk?.[risk] ?? effective.default;
}

let decisionCounter = 0;
function newDecisionId(): string {
  decisionCounter += 1;
  return `decision-${Date.now().toString(36)}-${decisionCounter.toString(36)}`;
}

// timeout → fail-closed；abort → 返回 null，调用方负责干净退出
export async function requestDecision(
  request: DecisionRequest,
  deps: DecisionDeps,
  signal: AbortSignal,
): Promise<DecisionResponse | "timeout" | null> {
  await deps.storage.appendRecord(
    deps.sessionId,
    record(deps.runId(), { kind: "decision-requested", decisionId: request.decisionId, request }),
  );
  deps.emit({ type: "decision.requested", request });

  const timeoutMs = deps.timeoutMs ?? DECISION_TIMEOUT_MS;
  let outcome: DecisionResponse | "timeout" | null;
  try {
    outcome = await raceHuman(deps.decide(request, signal), timeoutMs, signal);
  } catch {
    // decide 自身抛错按超时处理（fail-closed），abort 由下面的 signal 检查兜底
    outcome = "timeout";
  }
  if (signal.aborted) outcome = null;

  await deps.storage.appendRecord(
    deps.sessionId,
    record(deps.runId(), {
      kind: "decision-resolved",
      decisionId: request.decisionId,
      response: outcome === null ? "timeout" : outcome,
    }),
  );
  deps.emit({ type: "decision.resolved", decisionId: request.decisionId });
  return outcome;
}

function raceHuman(
  pending: Promise<DecisionResponse>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<DecisionResponse | "timeout" | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: DecisionResponse | "timeout" | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const onAbort = () => finish(null);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (response) => finish(response),
      () => finish("timeout"),
    );
  });
}

export interface ApprovalOutcome {
  allowed: boolean;
  alwaysAllowed: boolean;
}

// 审批一个 tool call：mode 由调用方合成（policy + hooks.beforeToolCall，见 §4.3/§6）；
// allow_always 写入 session 级 allowlist（第一版不跨 session 持久化）
export async function requestApproval(
  mode: ApprovalMode,
  call: { callId: string; name: string; args: unknown; risk: Risk },
  deps: DecisionDeps,
  allowlist: Set<string>,
  signal: AbortSignal,
): Promise<ApprovalOutcome | "aborted"> {
  if (mode === "auto") return { allowed: true, alwaysAllowed: false };
  if (mode === "deny") return { allowed: false, alwaysAllowed: false };

  const request: DecisionRequest = {
    kind: "approval",
    decisionId: newDecisionId(),
    callId: call.callId,
    toolName: call.name,
    args: call.args,
    risk: call.risk,
    codeChanges: await buildCodeChanges(call, deps.fs),
  };
  const response = await requestDecision(request, deps, signal);
  if (response === null) return "aborted";
  if (response === "timeout" || response.kind !== "approval") return { allowed: false, alwaysAllowed: false };
  if (response.decision === "allow_always") allowlist.add(call.name);
  return { allowed: response.decision !== "deny", alwaysAllowed: response.decision === "allow_always" };
}

async function buildCodeChanges(
  call: { name: string; args: unknown },
  fs: FileSystem | undefined,
): Promise<CodeChange[] | undefined> {
  if (!fs || !call.args || typeof call.args !== "object") return undefined;
  const args = call.args as Record<string, unknown>;
  if (typeof args.path !== "string") return undefined;

  if (call.name === "edit_file" && typeof args.oldText === "string" && typeof args.newText === "string") {
    const current = await fs.read(args.path);
    if (!current.ok) return undefined;
    const occurrences = current.value.text.split(args.oldText).length - 1;
    if (occurrences === 0 || (occurrences > 1 && args.replaceAll !== true)) return undefined;
    const newText =
      args.replaceAll === true
        ? current.value.text.split(args.oldText).join(args.newText)
        : current.value.text.replace(args.oldText, args.newText);
    return [{ path: args.path, oldText: current.value.text, newText }];
  }

  if (call.name === "write_file" && typeof args.content === "string") {
    const current = await fs.read(args.path);
    if (!current.ok && current.error.code !== "NOT_FOUND") return undefined;
    return [{ path: args.path, oldText: current.ok ? current.value.text : "", newText: args.content }];
  }

  return undefined;
}

// 反问（ask_user）：返回答案；超时 / abort / 拒绝 → null
export async function askQuestion(
  question: { question: string; options: string[]; multiSelect?: boolean },
  deps: DecisionDeps,
  signal: AbortSignal,
): Promise<string[] | "aborted" | null> {
  const request: DecisionRequest = {
    kind: "question",
    decisionId: newDecisionId(),
    question: question.question,
    options: question.options,
    multiSelect: question.multiSelect ?? false,
  };
  const response = await requestDecision(request, deps, signal);
  if (response === null) return "aborted";
  if (response === "timeout" || response.kind !== "question") return null;
  return response.answers;
}
