import { Label, ListBox, Select } from '@heroui/react';
import { Link } from '@tanstack/react-router';
import { Folder, Terminal } from 'lucide-react';
import { useState } from 'react';
import { RemoteExplorer } from '@nova/chat-ui/remote-explorer';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/error-notice';
import { Input } from '@/components/ui/input';
import { runnerStatus, loadRunnerDirectory } from '@/features/runners';
import { loadRemoteDirectory } from '@/features/remotes';
import { useClientConfig } from '@/features/models';

import { useProjectEnvironmentRequest, type ProjectEnvironment } from './project-environment';

export function ProjectEnvironmentPicker({
  value,
  onChange,
  allowUnbound = false,
  disabled = false,
  showLabel = true,
  showSetupLinks = true,
}: {
  value: ProjectEnvironment;
  onChange: (value: ProjectEnvironment) => void;
  allowUnbound?: boolean;
  disabled?: boolean;
  showLabel?: boolean;
  showSetupLinks?: boolean;
}) {
  const { runner, remote, runners, remotes } = useProjectEnvironmentRequest(value);
  const config = useClientConfig();
  const [explorer, setExplorer] = useState(false);
  return (
    <div className="space-y-4">
      <div>
        <Select
          aria-label="运行环境"
          isDisabled={disabled}
          value={value.target || 'none'}
          onChange={(key) => {
            const target = key === 'none' ? '' : String(key);
            onChange({ target, canonicalCwd: target.startsWith('ssh:') ? '/' : '.' });
          }}
          variant="secondary"
        >
          {showLabel && <Label>运行环境</Label>}
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id="none" textValue={allowUnbound ? '稍后绑定环境' : '请选择环境'}>
                <ListBox.ItemIndicator />
                {allowUnbound ? '稍后绑定环境' : '请选择环境'}
              </ListBox.Item>
              {(runners.data?.items ?? [])
                .filter((item) => !item.revokedAt && item.workspaceId)
                .map((item) => (
                  <ListBox.Item
                    key={item.id}
                    id={'runner:' + item.id}
                    textValue={item.runnerId + ' · Runner'}
                  >
                    <ListBox.ItemIndicator />
                    {item.runnerId} · Runner · {runnerStatus(item) === 'online' ? '在线' : '离线'}
                  </ListBox.Item>
                ))}
              {(remotes.data?.items ?? []).map((item) => (
                <ListBox.Item
                  key={item.id}
                  id={'ssh:' + item.id}
                  isDisabled={item.status !== 'verified'}
                  textValue={item.name + ' · SSH'}
                >
                  <ListBox.ItemIndicator />
                  {item.name} · SSH {item.status === 'verified' ? '' : '· 请先验证连接'}
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        {showSetupLinks && (
          <div className="mt-2 flex gap-4 text-xs">
            <Link to="/settings/runners" className="text-accent">
              连接 Runner
            </Link>
            <Link to="/settings/remotes" className="inline-flex items-center gap-1 text-accent">
              <Terminal size={12} />
              添加 SSH 远程
            </Link>
          </div>
        )}
        {runners.error && <ErrorNotice error={runners.error} />}
        {remotes.error && <ErrorNotice error={remotes.error} />}
      </div>
      {value.target && (
        <div>
          <label htmlFor="project-workspace-path" className="mb-2 block text-sm font-medium">
            工作目录
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="project-workspace-path"
              disabled={disabled}
              value={value.canonicalCwd}
              onChange={(event) => onChange({ ...value, canonicalCwd: event.target.value })}
              placeholder={remote ? '例如 /var/www/project' : '根目录填 .，例如 apps/web'}
            />
            <Button
              variant="outline"
              disabled={disabled || !(remote || (runner && config.data?.capabilities.remoteFiles))}
              onPress={() => setExplorer(true)}
            >
              <Folder size={15} />
              浏览
            </Button>
          </div>
          <p className="mt-2 break-all text-xs text-muted-foreground">
            {remote
              ? '可选择 SSH 账号有权限访问的任意目录。'
              : '填写 Runner 工作目录内的相对路径。'}
          </p>
        </div>
      )}
      {(remote || runner) && explorer && (
        <RemoteExplorer
          open
          mode="directory"
          title="选择项目工作目录"
          onClose={() => setExplorer(false)}
          initialPath={remote ? '/' : value.canonicalCwd}
          loadDirectory={(path, signal) =>
            remote
              ? loadRemoteDirectory(remote.id, path, signal)
              : loadRunnerDirectory(runner!.id, path, signal)
          }
          onConfirm={(entries) => {
            const entry = entries[0];
            if (entry)
              onChange({
                ...value,
                canonicalCwd: entry.path || '.',
              });
            setExplorer(false);
          }}
        />
      )}
    </div>
  );
}
