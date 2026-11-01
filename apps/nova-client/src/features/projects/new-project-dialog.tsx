import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Description, Label, ListBox, Popover } from '@heroui/react';
import { ArrowRight, ChevronDown, FolderPlus, Monitor, Plus, Server, Terminal } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { bindProjectEnvironment, createProject } from '@/api/generated/projects';
import { queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { SettingsDialog } from '@/components/ui/settings-dialog';
import { ErrorNotice } from '@/components/error-notice';
import { useIdentity } from '@/features/auth';
import { ProjectEnvironmentPicker } from './project-environment-picker';
import {
  useProjectEnvironmentRequest,
  validWorkspacePath,
  type ProjectEnvironment,
} from './project-environment';
import { useModelSettings } from '@/features/settings';
import { Input } from '@/components/ui/input';

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { identity } = useIdentity();
  const settings = useModelSettings();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<ProjectEnvironment>({
    target: '',
    canonicalCwd: '.',
  });
  const { request, runners, remotes } = useProjectEnvironmentRequest(environment);
  const nameId = useId();
  const nameCountId = useId();
  const [setupOpen, setSetupOpen] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setName('');
      setCreatedId(null);
      setSetupOpen(false);
      setEnvironment({
        target: settings.defaultRunnerId ? 'runner:' + settings.defaultRunnerId : '',
        canonicalCwd: '.',
      });
    }
    wasOpen.current = open;
  }, [open, settings.defaultRunnerId]);
  const create = useMutation({
    mutationFn: async () => {
      // Keep the new project ID if binding fails, so retry cannot create duplicate projects.
      const id = createdId ?? (await createProject({ name: name.trim() })).id;
      setCreatedId(id);
      if (environment.target) {
        if (!request) throw new Error('请选择有效环境；SSH 连接需要先验证。');
        await bindProjectEnvironment(id, { ...request, expectedRevision: 0 });
      }
      return id;
    },
    onSuccess: async (id) => {
      await client.invalidateQueries({ queryKey: queryKeys.projects.root(identity!.identityId) });
      onClose();
      void navigate({ to: '/projects/$id', params: { id } });
    },
    onError: () =>
      client.invalidateQueries({ queryKey: queryKeys.projects.root(identity!.identityId) }),
  });
  const valid =
    name.trim().length > 0 &&
    name.trim().length <= 80 &&
    (!environment.target ||
      (request && validWorkspacePath(environment.canonicalCwd, environment.target)));
  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      isPending={create.isPending}
      title="新建项目"
      description="集中管理项目目录与会话。"
      icon={<FolderPlus size={21} strokeWidth={1.7} />}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !create.isPending) create.mutate();
      }}
      footer={
        <>
          <p className="mr-auto hidden text-xs text-muted-foreground sm:block">
            创建后进入项目空间
          </p>
          <Button variant="ghost" disabled={create.isPending} onPress={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={create.isPending || !valid}>
            {create.isPending ? '正在创建…' : createdId ? '重试绑定' : '创建项目'}
            {!create.isPending && <ArrowRight size={15} aria-hidden="true" />}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <label htmlFor={nameId} className="text-sm font-medium text-foreground">
              项目名称
            </label>
            <span id={nameCountId} className="text-xs text-muted-foreground tabular-nums">
              {name.length} / 80
            </span>
          </div>
          <Input
            id={nameId}
            name="project-name"
            autoFocus
            required
            autoComplete="off"
            aria-describedby={nameCountId}
            maxLength={80}
            value={name}
            disabled={Boolean(createdId) || create.isPending}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 Nova、设计系统"
          />
        </div>
        <section
          aria-label="工作环境"
          className="rounded-2xl border border-border bg-surface-secondary/40 p-4 sm:p-5"
        >
          <div className="mb-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Monitor size={15} className="text-muted-foreground" aria-hidden="true" />
                工作环境
              </h2>
              <span className="text-xs text-muted-foreground">可稍后设置</span>
            </div>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              通过 Runner 或 SSH 在项目目录中工作。
            </p>
          </div>
          <ProjectEnvironmentPicker
            value={environment}
            onChange={setEnvironment}
            allowUnbound
            disabled={create.isPending}
            showLabel={false}
            showSetupLinks={false}
          />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
            <p
              role={runners.isPending || remotes.isPending ? 'status' : undefined}
              className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground"
            >
              {runners.isPending || remotes.isPending
                ? '正在读取可用环境…'
                : environment.target
                  ? '环境配置将随项目一起保存。'
                  : '创建后也可以在项目设置中绑定。'}
            </p>
            <Popover isOpen={setupOpen} onOpenChange={setSetupOpen}>
              <Button variant="ghost" disabled={create.isPending} aria-label="连接新环境">
                <Plus size={13} />
                连接新环境
                <ChevronDown size={12} />
              </Button>
              <Popover.Content placement="bottom end">
                <Popover.Dialog>
                  <ListBox
                    aria-label="连接工作环境"
                    selectionMode="none"
                    onAction={(key) => {
                      if (create.isPending || (key !== 'runner' && key !== 'ssh')) return;
                      setSetupOpen(false);
                      onClose();
                      void navigate({
                        to: key === 'runner' ? '/settings/runners' : '/settings/remotes',
                      });
                    }}
                  >
                    <ListBox.Item id="runner" textValue="连接 Runner">
                      <Server size={16} />
                      <div>
                        <Label>连接 Runner</Label>
                        <Description className="text-muted-foreground">
                          在本机或开发设备上运行
                        </Description>
                      </div>
                    </ListBox.Item>
                    <ListBox.Item id="ssh" textValue="添加 SSH 远程">
                      <Terminal size={16} />
                      <div>
                        <Label>添加 SSH 远程</Label>
                        <Description className="text-muted-foreground">
                          连接已有的远程工作目录
                        </Description>
                      </div>
                    </ListBox.Item>
                  </ListBox>
                </Popover.Dialog>
              </Popover.Content>
            </Popover>
          </div>
        </section>
        {create.error && (
          <div className="space-y-2">
            {createdId && (
              <p className="text-xs leading-5 text-muted-foreground">
                项目已创建，重试会保留该项目并继续绑定环境。
              </p>
            )}
            <ErrorNotice error={create.error} />
          </div>
        )}
      </div>
    </SettingsDialog>
  );
}
