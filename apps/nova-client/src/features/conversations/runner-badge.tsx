import type { ComponentProps } from 'react';
import { ApiError } from '@/api/api-error';
import { bindProjectEnvironment, getProjectBinding } from '@/api/generated/projects';
import { queryKeys } from '@/api/query-keys';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useIdentity } from '@/features/auth';
import { RunnerManagerDialog } from '@/features/settings';
import { runnerStatus, useRunnersQuery } from '@/features/runners';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { Suspense, useState } from 'react';

const RUNNER_BADGE_BY_STATUS = {
  online: {
    variant: 'success',
    label: '设备在线',
    hint: '点击切换 Runner 或复制启动命令',
  },
  revoked: {
    variant: 'danger',
    label: '凭据已撤销 · 点击更换',
    hint: '点击选择其他 Runner 或复制新的启动命令',
  },
  offline: {
    variant: 'warning',
    label: '设备未连接 · 点击连接',
    hint: '点击选择在线设备，或复制 Runner 启动命令到设备上运行',
  },
} as const satisfies Record<
  'online' | 'offline' | 'revoked',
  { variant: ComponentProps<typeof Badge>['variant']; label: string; hint: string }
>;

/**
 * 项目会话头部的 Runner 状态徽章。
 * 点击直接打开 Runner 管理弹窗（复用 `settings/runners` 的 `RunnerManagerDialog`）：
 * 可以选择其他已注册 Runner 改绑本项目，或复制启动命令让未连接的设备上线，
 * 不必绕道设置页。
 */
export function RunnerBadge({
  runnerId,
  projectId,
}: {
  runnerId: string;
  projectId?: string | undefined;
}) {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const runners = useRunnersQuery();
  const [pickerOpen, setPickerOpen] = useState(false);
  const rebind = useMutation({
    mutationFn: async (targetRunnerId: string) => {
      if (!projectId) throw new ApiError(400, 400, '普通会话不绑定设备。');
      const target = runners.data?.items.find((item) => item.id === targetRunnerId);
      if (!target?.workspaceId)
        throw new ApiError(400, 400, '该设备还没有上报工作目录，先在设备上运行一次 Runner。');
      // 保留项目当前的目录与指令，只换执行设备；修订号用服务端最新值避免误覆盖。
      const current = await getProjectBinding(projectId);
      if (!current) throw new ApiError(404, 404, '项目环境绑定已丢失，请到项目页重新绑定环境。');
      return bindProjectEnvironment(projectId, {
        runnerId: target.id,
        workspaceId: target.workspaceId,
        canonicalCwd: current.canonicalCwd,
        instructionSource: current.instructions.source ?? 'none',
        customPrompt: current.instructions.customPrompt ?? '',
        expectedRevision: current.revision,
      });
    },
    onSuccess: async () => {
      setPickerOpen(false);
      await client.invalidateQueries({ queryKey: queryKeys.projects.root(identity!.identityId) });
    },
  });
  const runner = runners.data?.items.find(
    (item) => item.id === runnerId || item.runnerId === runnerId,
  );
  if (runners.isPending) return null;
  const detail = RUNNER_BADGE_BY_STATUS[runner ? runnerStatus(runner) : 'offline'];
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        title={detail.hint}
        className="shrink-0 gap-0 p-0 hover:bg-transparent"
        onPress={() => setPickerOpen(true)}
      >
        <Badge
          variant={detail.variant}
          className="gap-1 px-2 py-0.5 whitespace-nowrap transition hover:ring-2"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-current" />
          {detail.label}
          <ChevronDown size={11} aria-hidden="true" />
        </Badge>
      </Button>
      {pickerOpen && (
        <Suspense fallback={null}>
          <RunnerManagerDialog
            open
            title="选择 Runner 或复制启动命令"
            selectedRunnerId={runnerId}
            onClose={() => setPickerOpen(false)}
            {...(projectId
              ? {
                  onSelect: (targetRunnerId: string) => rebind.mutateAsync(targetRunnerId),
                  selectionHint:
                    '选择后本项目的新会话使用所选设备；当前会话仍保留原设备。要让当前会话继续，请复制启动命令在原设备上运行，排队的任务会自动继续执行。',
                }
              : {})}
          />
        </Suspense>
      )}
    </>
  );
}
