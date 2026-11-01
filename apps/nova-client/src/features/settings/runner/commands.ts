import type { RunnerToken } from '@/features/runners';

export type RunnerCommandShell = 'powershell' | 'bash';
export type RunnerCommandRuntime = 'cargo' | 'binary';

export function runnerTokenCanStart(token: RunnerToken) {
  return (
    token.status === 'active' && (!token.expiresAt || Date.parse(token.expiresAt) > Date.now())
  );
}

interface RunnerCommandOptions {
  endpoint: string;
  token: string;
  workspace: string;
  shell: RunnerCommandShell;
  runtime: RunnerCommandRuntime;
}

/** Arguments follow crates/runner/src/config.rs; each value stays one literal shell argument. */
export function runnerStartCommand(
  options: RunnerCommandOptions,
): { command: string; error: null } | { command: null; error: string } {
  const endpoint = options.endpoint.trim();
  const token = options.token.trim();
  const workspace = options.workspace.trim();
  if (!endpoint) return { command: null, error: '正在加载 Runner 连接地址…' };
  if (!token)
    return { command: null, error: '未获取可用的 Runner Token，请刷新或先轮换旧版凭据。' };
  if (!workspace) return { command: null, error: '请填写 Runner 工作目录。' };
  if (
    [options.endpoint, options.token, options.workspace].some((value) =>
      Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }),
    )
  ) {
    return { command: null, error: '连接地址、Token 和工作目录不能包含换行或控制字符。' };
  }
  try {
    const url = new URL(endpoint);
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname) {
      return { command: null, error: 'Runner 连接地址必须使用 ws:// 或 wss://。' };
    }
  } catch {
    return { command: null, error: 'Runner 连接地址无效，请重新加载。' };
  }

  const quote = (value: string) =>
    "'" + value.replaceAll("'", options.shell === 'powershell' ? "''" : "'\\''") + "'";
  const executable = options.runtime === 'cargo' ? 'cargo run -p nova-runner --' : 'nova-runner';
  return {
    command:
      executable +
      ' --server ' +
      quote(endpoint) +
      ' --token ' +
      quote(token) +
      ' --workspace ' +
      quote(workspace),
    error: null,
  };
}
