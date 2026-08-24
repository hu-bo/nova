// 协议错误映射（docs/runner-sdk.md §6、docs/proto.md §4.2）。
// SDK 内部用 RunnerError（typed code + message）；转换为 agent-core 的
// ExecError / FsError 是组装边界（toToolContext）的职责。
// 硬规矩：不自动重试、不重发业务请求；exit_code != 0 是完成事实不是错误。
import { ErrorCode } from "./gen/common_pb.js";
import type { Error as WireError } from "./gen/common_pb.js";
import type { ExecError, FsError } from "@nova/agent-core";

export type RunnerErrorCode =
  | "NOT_FOUND"
  | "PERMISSION"
  | "INVALID"
  | "OUT_OF_WORKSPACE"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "CANCELLED"
  | "UNSUPPORTED"
  | "BUSY"
  | "IO"
  | "IS_DIR"
  | "NOT_DIR"
  | "EXISTS"
  | "SPAWN_FAILED"
  // 传输级：连接断开 / 会话失效。不在 wire enum 里，由 SDK 自己产生
  | "RUNNER_UNAVAILABLE";

export class RunnerError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

export function runnerUnavailable(message = "runner connection lost"): RunnerError {
  return new RunnerError("RUNNER_UNAVAILABLE", message);
}

// wire common.Error → RunnerError
export function fromWireError(err: WireError): RunnerError {
  const code = wireToCode(err.code);
  return new RunnerError(code, err.message);
}

function wireToCode(code: ErrorCode): RunnerErrorCode {
  switch (code) {
    case ErrorCode.NOT_FOUND:
      return "NOT_FOUND";
    case ErrorCode.PERMISSION:
      return "PERMISSION";
    case ErrorCode.INVALID:
      return "INVALID";
    case ErrorCode.OUT_OF_WORKSPACE:
      return "OUT_OF_WORKSPACE";
    case ErrorCode.TOO_LARGE:
      return "TOO_LARGE";
    case ErrorCode.TIMEOUT:
      return "TIMEOUT";
    case ErrorCode.CANCELLED:
      return "CANCELLED";
    case ErrorCode.UNSUPPORTED:
      return "UNSUPPORTED";
    case ErrorCode.BUSY:
      return "BUSY";
    case ErrorCode.IS_DIR:
      return "IS_DIR";
    case ErrorCode.NOT_DIR:
      return "NOT_DIR";
    case ErrorCode.EXISTS:
      return "EXISTS";
    case ErrorCode.SPAWN_FAILED:
      return "SPAWN_FAILED";
    default:
      return "IO";
  }
}

// —— 到 agent-core typed code 的映射（agent-core.md §3.4）——

// FsError 只有 8 个 code；执行面/传输面的 code 落回 IO，message 保留原信息
export function toFsError(err: RunnerError, path?: string): FsError {
  const code =
    err.code === "NOT_FOUND" ||
    err.code === "PERMISSION" ||
    err.code === "IS_DIR" ||
    err.code === "NOT_DIR" ||
    err.code === "EXISTS" ||
    err.code === "OUT_OF_WORKSPACE" ||
    err.code === "TOO_LARGE"
      ? err.code
      : "IO";
  return path === undefined ? { code, message: err.message } : { code, message: err.message, path };
}

// Finished/传输失败 → ExecError。BUSY 按 agent-core.md §4.2 映射为 RUNNER_UNAVAILABLE
// （ExecErrorCode 没有 BUSY；排队拒绝意味着该 Runner 此刻无法承接工作）
export function toExecError(err: RunnerError, exitCode?: number): ExecError {
  const code =
    err.code === "TIMEOUT"
      ? "TIMEOUT"
      : err.code === "CANCELLED"
        ? "CANCELLED"
        : err.code === "SPAWN_FAILED"
          ? "SPAWN_FAILED"
          : err.code === "RUNNER_UNAVAILABLE" || err.code === "BUSY"
            ? "RUNNER_UNAVAILABLE"
            : "IO";
  return exitCode === undefined ? { code, message: err.message } : { code, message: err.message, exitCode };
}
