import { ToolFailureError } from "@nnova/harness";
import type { RunnerSession } from "@nova/runner-sdk";
import type { RunnerConnections } from "../runners/index.js";
import { DomainError } from "../../shared/domain-error.js";

export async function runnerToolContext(
  runners: Pick<RunnerConnections, "require">,
  runnerId: string,
  owner: string,
  options: Parameters<RunnerSession["createToolContext"]>[0],
) {
  try {
    const { session } = await runners.require(runnerId, owner);
    return session.createToolContext(options);
  } catch (error) {
    if (error instanceof DomainError && error.details?.reason === "RUNNER_OFFLINE")
      throw new ToolFailureError(
        "RUNNER_OFFLINE",
        "项目绑定的 Runner 离线或连接凭据已失效，本次操作未执行。请告知用户启动或重新连接 Runner，并检查连接凭据；恢复连接后再重试。",
        "known",
      );
    throw error;
  }
}
