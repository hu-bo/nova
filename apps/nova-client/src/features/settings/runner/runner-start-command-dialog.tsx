import { Label, ListBox, Select } from '@heroui/react';
import { Check, Clipboard, Terminal } from 'lucide-react';
import { useId, useState } from 'react';
import { ErrorNotice } from '@/components/error-notice';
import { Button } from '@/components/ui/button';
import { SettingsDialog } from '@/components/ui/settings-dialog';
import { Input } from '@/components/ui/input';
import { copyText } from '@/lib/clipboard';
import type { RunnerToken } from '@/features/runners';
import {
  runnerStartCommand,
  runnerTokenCanStart,
  type RunnerCommandRuntime,
  type RunnerCommandShell,
  useRunnerConnection,
} from '@/features/runners';

const runtimeHints = {
  cargo: '在 nova 源码仓库根目录执行，需要安装 Rust / Cargo。',
  npx: '在项目目录中执行，需要安装 Node.js 18+，npx 会下载并运行 Runner。',
  binary: '设备需已安装当前版本的 nova-runner，并将其加入 PATH。',
} satisfies Record<RunnerCommandRuntime, string>;

/** 复制按钮文案：复制进行中优先，其次看本条命令是否已复制成功。 */
function copyButtonLabel(isCopying: boolean, isCopied: boolean) {
  if (isCopying) return '正在复制…';
  if (isCopied) return '已复制启动命令';
  return '复制 Runner 启动命令';
}

export function RunnerStartCommandDialog({
  token,
  onClose,
}: {
  token: RunnerToken;
  onClose: () => void;
}) {
  const connection = useRunnerConnection();
  const [workspace, setWorkspace] = useState('.');
  const [shell, setShell] = useState<RunnerCommandShell>('powershell');
  const [runtime, setRuntime] = useState<RunnerCommandRuntime>(
    import.meta.env.DEV ? 'cargo' : 'npx',
  );
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [copying, setCopying] = useState(false);
  const workspaceId = useId();
  const workspaceHintId = useId();
  const options = {
    endpoint: connection.data?.endpoint ?? '',
    token: token.token ?? '',
    workspace,
    shell,
    runtime,
  };
  const result = runnerStartCommand(options);
  const usable = runnerTokenCanStart(token);
  const command = usable && !connection.error ? result.command : null;
  // Keep the saved secret out of the preview; the copied command includes the actual credential.
  const preview = command ? runnerStartCommand({ ...options, token: '••••••••' }).command : null;
  const copied = Boolean(command && copiedCommand === command);

  async function copyCommand() {
    if (!command || copying) return;
    setCopyError(false);
    setCopying(true);
    try {
      await copyText(command);
      setCopiedCommand(command);
    } catch {
      setCopyError(true);
    } finally {
      setCopying(false);
    }
  }

  /** 命令区状态提示：连接地址读取失败优先，其次凭据失效或参数校验不通过。 */
  function renderCommandNotice() {
    if (connection.error)
      return <ErrorNotice error={connection.error} onRetry={() => void connection.refetch()} />;
    if (!usable || result.error)
      return (
        <p role="status" className="text-xs leading-5 text-muted-foreground">
          {!usable ? '此 Token 已失效，请选择有效凭据。' : result.error}
        </p>
      );
    return null;
  }

  return (
    <SettingsDialog
      open
      onClose={onClose}
      title="Runner 启动命令"
      description={<>{token.label ?? '未命名凭据'} · 配置工作目录后，在 Runner 所在设备上运行。</>}
      icon={<Terminal size={21} strokeWidth={1.7} />}
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            关闭
          </Button>
          <Button
            disabled={!command || copying}
            icon={copied ? <Check /> : <Clipboard />}
            onPress={() => void copyCommand()}
          >
            {copyButtonLabel(copying, copied)}
          </Button>
        </>
      }
    >
      <div className="rounded-xl border border-border bg-surface-secondary/40 p-3 text-xs leading-5 text-muted-foreground">
        {token.token
          ? '此凭据的 Token 已自动带入命令，无需填写。复制后在 Runner 所在设备上执行即可连接 Server。'
          : '此记录是旧版凭据，请先轮换一次以生成可复制的 Token。'}
      </div>
      <div className="space-y-2">
        <label htmlFor={workspaceId} className="text-sm font-medium">
          工作目录
        </label>
        <Input
          id={workspaceId}
          aria-describedby={workspaceHintId}
          value={workspace}
          onChange={(event) => setWorkspace(event.target.value)}
          placeholder={
            shell === 'powershell' ? '例如 E:\\Project\\my-project\\nova' : '例如 /home/me/project'
          }
        />
        <p id={workspaceHintId} className="text-xs leading-5 text-muted-foreground">
          填写设备上已存在的目录；. 表示执行命令时所在目录。
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          value={shell}
          onChange={(key) => {
            if (key === 'powershell' || key === 'bash') setShell(key);
          }}
        >
          <Label>终端</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id="powershell" textValue="PowerShell">
                PowerShell
                <ListBox.ItemIndicator />
              </ListBox.Item>
              <ListBox.Item id="bash" textValue="Bash / Zsh">
                Bash / Zsh
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
        <Select
          value={runtime}
          onChange={(key) => {
            if (key === 'cargo' || key === 'npx' || key === 'binary') setRuntime(key);
          }}
        >
          <Label>启动方式</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id="npx" textValue="快速运行 · npx">
                快速运行 · npx
                <ListBox.ItemIndicator />
              </ListBox.Item>
              <ListBox.Item id="cargo" textValue="从源码启动 · Cargo">
                从源码启动 · Cargo
                <ListBox.ItemIndicator />
              </ListBox.Item>
              <ListBox.Item id="binary" textValue="已安装 · nova-runner">
                已安装 · nova-runner
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
      <section
        className="rounded-2xl border border-border bg-surface-secondary/50 p-4"
        aria-label="命令预览"
      >
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">命令预览</h2>
        <code className="block whitespace-pre-wrap break-all text-xs leading-6">
          {preview ?? '加载 Token 并设置工作目录后生成启动命令。'}
        </code>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {runtimeHints[runtime]} 复制的命令包含完整 Token。
        </p>
      </section>
      {renderCommandNotice()}
      {copyError && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-danger">
            自动复制失败，请选中下方完整命令，按 Ctrl+C（macOS 为 ⌘C）复制。
          </p>
          <textarea
            aria-label="手动复制启动命令"
            readOnly
            value={command ?? ''}
            rows={4}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full rounded-lg border border-border bg-surface p-3 font-mono text-xs"
          />
        </div>
      )}
    </SettingsDialog>
  );
}
