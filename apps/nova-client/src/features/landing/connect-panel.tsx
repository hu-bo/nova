import { Button } from '@/components/ui/button';
import { useIdentity } from '@/features/auth';
import { runnerStartCommand, runnerTokenCanStart, useRunnerTokensQuery } from '@/features/runners';
import { copyText } from '@/lib/clipboard';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Check, Code2, Copy, Globe2, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import './landing.css';

const runnerEnvironments = [
  {
    id: 'local',
    label: '本地开发',
    runtime: 'cargo',
    endpoint: 'ws://127.0.0.1:9203/runner/v1/connect',
  },
  {
    id: 'production',
    label: '正式部署',
    runtime: 'npx',
    endpoint: 'wss://nova.8and1.cn/runner/v1/connect',
  },
] as const;

type CopyState = 'idle' | 'copied' | 'error';

const copyMessages = {
  idle: '',
  copied: '启动命令已复制。',
  error: '复制失败，请手动复制上方命令。',
} satisfies Record<CopyState, string>;

export function ConnectPanel() {
  const { identity, login } = useIdentity();
  const tokens = useRunnerTokensQuery({ silent: true });
  const [envIndex, setEnvIndex] = useState(import.meta.env.DEV ? 0 : 1);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [loginError, setLoginError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const env = runnerEnvironments[envIndex]!;
  const token = identity
    ? tokens.data?.items.find((item) => runnerTokenCanStart(item) && item.token)?.token
    : undefined;
  const { command, error } = runnerStartCommand({
    endpoint: env.endpoint,
    token: token ?? '<token>',
    workspace: '',
    shell: navigator.platform.startsWith('Win') ? 'powershell' : 'bash',
    runtime: env.runtime,
  });
  useEffect(() => () => clearTimeout(timerRef.current), []);
  async function copy() {
    if (!command) return;
    clearTimeout(timerRef.current);
    try {
      await copyText(command);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    timerRef.current = setTimeout(() => setCopyState('idle'), 2500);
  }
  return (
    <aside className="landing-connect" id="install" aria-labelledby="connect-title">
      <div className="landing-connect-head">
        <Terminal size={16} />
        <h2 id="connect-title">连接你的设备</h2>
      </div>
      <div className="landing-connect-tabs" role="group" aria-label="部署环境">
        {runnerEnvironments.map((item, index) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={index === envIndex}
            onClick={() => {
              setEnvIndex(index);
              setCopyState('idle');
              clearTimeout(timerRef.current);
            }}
          >
            {item.id === 'local' ? <Code2 size={14} /> : <Globe2 size={14} />}
            {item.label}
          </button>
        ))}
      </div>
      <div className="landing-connect-code">
        <div>
          <span>Windows · Linux · macOS 同一条命令</span>
          <Button
            variant="ghost"
            isIconOnly
            disabled={!command}
            aria-label={copyState === 'copied' ? '启动命令已复制' : '复制启动命令'}
            onPress={() => void copy()}
            className="landing-copy-button"
          >
            {copyState === 'copied' ? <Check size={15} /> : <Copy size={15} />}
          </Button>
        </div>
        <pre>
          <code>
            {command ? (
              <>
                <i>$ </i>
                {command}
              </>
            ) : (
              error
            )}
          </code>
        </pre>
      </div>
      <p className="landing-connect-note">
        {!token && '请将 <token> 替换为你的 Runner Token。'}
        在项目目录中运行，默认使用当前目录作为 workspace。
        {env.id === 'production' ? '需要已安装 Node.js。' : ''}
      </p>
      <div className="landing-connect-status" role="status">
        {loginError ? '暂时无法登录，请稍后重试。' : copyMessages[copyState]}
      </div>
      {identity ? (
        <Link to="/settings/runners" className="landing-connect-action">
          {tokens.isSuccess && !token ? '去设备管理创建 Token' : '管理设备和 Token'}{' '}
          <ArrowRight size={14} />
        </Link>
      ) : (
        <Button
          variant="ghost"
          className="landing-connect-action"
          onPress={() => {
            setLoginError(false);
            void login().catch(() => setLoginError(true));
          }}
        >
          登录并填入 Token <ArrowRight size={14} />
        </Button>
      )}
    </aside>
  );
}
