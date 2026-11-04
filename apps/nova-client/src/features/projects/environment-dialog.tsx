import { bindProjectEnvironment } from '@/api/generated/projects';
import type { GetProjectBinding200 } from '@/api/generated/projectsAPI.schemas';
import { queryKeys } from '@/api/query-keys';
import { ErrorNotice } from '@/components/error-notice';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useIdentity } from '@/features/auth';
import { useModelSettings } from '@/features/settings';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { useState } from 'react';
import {
  useProjectEnvironmentRequest,
  validWorkspacePath,
  type ProjectEnvironment,
} from './project-environment';
import { ProjectEnvironmentPicker } from './project-environment-picker';
import { instructionSource, type InstructionSource } from './project.page.shared';

const instructionSources: { value: InstructionSource; label: string }[] = [
  { value: 'agents', label: '读取 AGENTS.md' },
  { value: 'claude', label: '读取 CLAUDE.md' },
  { value: 'custom', label: '自定义提示词' },
  { value: 'none', label: '不使用项目指令' },
];

export function EnvironmentDialog({
  projectId,
  binding,
  onClose,
}: {
  projectId: string;
  binding: GetProjectBinding200 | null;
  onClose: () => void;
}) {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const settings = useModelSettings();
  const [environment, setEnvironment] = useState<ProjectEnvironment>({
    target: binding?.remoteConnectionId
      ? 'ssh:' + binding.remoteConnectionId
      : binding?.runnerId
        ? 'runner:' + binding.runnerId
        : settings.defaultRunnerId
          ? 'runner:' + settings.defaultRunnerId
          : '',
    canonicalCwd: binding?.canonicalCwd ?? '.',
  });
  const [customPrompt, setCustomPrompt] = useState(binding?.instructions.customPrompt ?? '');
  const [source, setSource] = useState<InstructionSource>(
    binding ? instructionSource(binding.instructions) : 'none',
  );
  const { request } = useProjectEnvironmentRequest(environment);
  const save = useMutation({
    mutationFn: () => {
      if (!request) throw new Error('请选择有效的运行环境。');
      return bindProjectEnvironment(projectId, {
        ...request,
        instructionSource: source,
        customPrompt: source === 'custom' ? customPrompt : '',
        expectedRevision: binding?.revision ?? 0,
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.projects.root(identity!.identityId) });
      onClose();
    },
    onError: () =>
      client.invalidateQueries({ queryKey: queryKeys.projects.root(identity!.identityId) }),
  });
  return (
    <Dialog
      open
      isPending={save.isPending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeDisabled={save.isPending}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (request && validWorkspacePath(environment.canonicalCwd, environment.target))
              save.mutate();
          }}
        >
          <DialogHeader icon={<Settings2 />}>
            <DialogTitle>配置项目环境</DialogTitle>
            <DialogDescription>
              选择工作目录，设置项目指令。已有会话保留创建时的环境。
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <ProjectEnvironmentPicker value={environment} onChange={setEnvironment} />
            <fieldset disabled={save.isPending} className="space-y-3">
              <legend className="mb-2 text-sm font-medium">项目指令来源</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {instructionSources.map((option) => (
                  <label
                    key={option.value}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm"
                  >
                    <input
                      type="radio"
                      name="project-instruction-source"
                      value={option.value}
                      checked={source === option.value}
                      onChange={() => setSource(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
              {(source === 'agents' || source === 'claude') && (
                <p className="text-xs leading-5 text-muted-foreground">
                  每次运行读取所选工作目录下的 {source === 'agents' ? 'AGENTS.md' : 'CLAUDE.md'}。
                  文件须可读且不超过 32000 字符、2000 行；读取失败时会提示错误。
                </p>
              )}
              {source === 'custom' && (
                <>
                  <label htmlFor="project-instructions" className="block text-sm font-medium">
                    自定义提示词
                  </label>
                  <Textarea
                    id="project-instructions"
                    value={customPrompt}
                    rows={5}
                    maxLength={32000}
                    onChange={(event) => setCustomPrompt(event.target.value)}
                    placeholder="例如：使用 TypeScript，遵守仓库约定。"
                  />
                </>
              )}
            </fieldset>
            {save.error && <ErrorNotice error={save.error} />}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={save.isPending} onPress={onClose}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                save.isPending ||
                !request ||
                !validWorkspacePath(environment.canonicalCwd, environment.target)
              }
            >
              {save.isPending ? '正在保存…' : '保存环境'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
