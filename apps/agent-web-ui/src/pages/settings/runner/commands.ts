import type { ApiClient } from "../../../api/client.js";

export const runnerReleaseBaseUrl =
  import.meta.env.VITE_RUNNER_RELEASE_URL || "https://github.com/hu-bo/nova/releases/latest/download";

export const windowsRunnerInstallerUrl = `${runnerReleaseBaseUrl}/nova-runner-setup.exe`;
export const linuxRunnerInstallerUrl =
  import.meta.env.VITE_RUNNER_INSTALL_URL || `${runnerReleaseBaseUrl}/install-runner.sh`;
export const runnerReleasesPageUrl =
  import.meta.env.VITE_RUNNER_RELEASE_PAGE_URL || "https://github.com/hu-bo/nova/releases/latest";

const developmentCommand = "cargo run -p nova-runner --";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function linuxRunnerCommand(endpoint: string, token: string, runnerId?: string) {
  return `curl -fsSL ${shellQuote(linuxRunnerInstallerUrl)} | sh -s -- --server ${shellQuote(endpoint)} --token ${shellQuote(token)}${runnerId ? ` --runner-id ${shellQuote(runnerId)}` : ""}`;
}

export function npxRunnerCommand(endpoint: string, token: string, runnerId?: string) {
  return `npx --yes --package @nnova/runner nova-runner --server "${endpoint}" --token "${token}"${runnerId ? ` --runner-id "${runnerId}"` : ""}`;
}

export async function projectRunnerCommand(
  api: Pick<ApiClient, "getRunnerConnectionInfo" | "listRunnerTokens" | "createRunnerToken">,
  runnerId?: string,
) {
  const [connection, tokens] = await Promise.all([api.getRunnerConnectionInfo(), api.listRunnerTokens()]);
  const token = runnerId ? tokens.find((token) => token.boundRunnerIds.includes(runnerId)) : tokens[0];
  if (runnerId && !token) throw new Error("原 Runner 的 Token 已不可用，请在 Project 页面检查绑定。");
  const selectedToken = token ?? (await api.createRunnerToken());
  // 显式使用用户执行命令的目录，避免本机配置文件中的 workspace 覆盖当前目录。
  return `${npxRunnerCommand(connection.endpoint, selectedToken.token, runnerId)} --workspace .`;
}

export function runnerCommand(endpoint: string, token: string, runnerId?: string) {
  return import.meta.env.DEV
    ? `${developmentCommand} --server "${endpoint}" --token "${token}"${runnerId ? ` --runner-id "${runnerId}"` : ""}`
    : linuxRunnerCommand(endpoint, token, runnerId);
}
