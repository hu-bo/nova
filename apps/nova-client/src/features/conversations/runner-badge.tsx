import type { ComponentProps, ReactNode } from 'react';
import { ApiError, errorMessage } from '@/api/api-error';
import { updateConversationBinding } from '@/api/generated/conversations';
import { bindProjectEnvironment, getProjectBinding } from '@/api/generated/projects';
import type { GetProjectBinding200 } from '@/api/generated/projectsAPI.schemas';
import { queryKeys } from '@/api/query-keys';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { useIdentity } from '@/features/auth';
import { RunnerManagerDialog } from '@/features/settings';
import { runnerStatus, useRunnersQuery } from '@/features/runners';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Server } from 'lucide-react';
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
    label: '设备未连接 · 点击切换',
    hint: '点击选择在线设备直接切换本会话，或复制 Runner 启动命令让设备上线',
  },
} as const satisfies Record<
  'online' | 'offline' | 'revoked',
  { variant: ComponentProps<typeof Badge>['variant']; label: string; hint: string }
>;

/**
 * 项目会话头部的 Runner 状态徽章。
 * 点击打开 Runner 管理弹窗（复用 `settings/runners` 的 `RunnerManagerDialog`）：
 * - 复制启动命令：设备身份由 Runner 本机持久化，让未连接的设备重新上线；
 * - 选择其他 Runner：直接切换本会话绑定的设备（PUT /conversations/:id/binding），
 *   服务端仅在原设备离线时允许；项目绑定同步切换，保证新会话与本项目一致。
 * 已开始（含暂停）的运行留在原设备完成，切换后的新任务直接在所选设备执行。
 */
export function RunnerBadge({
  runnerId,
  projectId,
  conversationId,
}: {
  runnerId: string;
  projectId?: string | undefined;
  conversationId?: string | undefined;
}) {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const runners = useRunnersQuery();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [projectBinding, setProjectBinding] = useState<GetProjectBinding200>(null);

  function runnerLabel(id: string | null): string {
    if (!id) return '未绑定';
    const found = runners.data?.items.find((item) => item.id === id || item.runnerId === id);
    return found?.runnerId ?? id.slice(0, 8);
  }

  /** 预览仅供确认弹窗展示；执行时以服务端最新状态为准。 */
  function requestSwitch(targetRunnerId: string) {
    setProjectBinding(null);
    setConfirmTarget(targetRunnerId);
    if (projectId)
      void getProjectBinding(projectId)
        .then(setProjectBinding)
        .catch(() => setProjectBinding(null));
  }

  const switchRunners = useMutation({
    mutationFn: async (targetRunnerId: string) => {
      const target = runners.data?.items.find((item) => item.id === targetRunnerId);
      if (!target?.workspaceId)
        throw new ApiError(400, 400, '该设备还没有上报工作目录，先在设备上运行一次 Runner。');
      // 先切会话（原设备离线才允许，失败则什么都不动），再把项目同步到同一设备。
      if (conversationId && runnerId !== target.id) {
        try {
          await updateConversationBinding(conversationId, { runnerId: target.id }, { silent: true });
        } catch (error) {
          if (error instanceof ApiError && error.details?.reason === 'RUNNER_ONLINE')
            throw new ApiError(409, 'RUNNER_ONLINE', '当前绑定的设备在线，不能切换；请等设备离线或先停止任务。');
          if (error instanceof ApiError && error.details?.reason === 'WORKSPACE_MISSING')
            throw new ApiError(409, 'WORKSPACE_MISSING', '目标设备还没有上报工作目录，先在设备上运行一次 Runner。');
          throw error;
        }
      }
      if (!projectId) return;
      // 目录与指令沿用项目当前绑定，只换执行设备；修订号取服务端最新值避免误覆盖。
      const current = await getProjectBinding(projectId);
      if (!current) throw new ApiError(404, 404, '项目环境绑定已丢失，请到项目页重新绑定环境。');
      if (current.runnerId === target.id) return;
      await bindProjectEnvironment(
        projectId,
        {
          runnerId: target.id,
          workspaceId: target.workspaceId,
          canonicalCwd: current.canonicalCwd,
          instructionSource: current.instructions.source ?? 'none',
          customPrompt: current.instructions.customPrompt ?? '',
          expectedRevision: current.revision,
        },
        { silent: true },
      );
    },
    onSuccess: async () => {
      setConfirmTarget(null);
      setPickerOpen(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.projects.root(identity!.identityId) }),
        client.invalidateQueries({ queryKey: queryKeys.conversations.root(identity!.identityId) }),
      ]);
    },
  });

  const runner = runners.data?.items.find(
    (item) => item.id === runnerId || item.runnerId === runnerId,
  );
  if (runners.isPending) return null;
  const detail = RUNNER_BADGE_BY_STATUS[runner ? runnerStatus(runner) : 'offline'];
  let confirmDescription: ReactNode = '读取项目环境…';
  if (confirmTarget) {
    confirmDescription = (
      <span className="block space-y-2">
        <span className="block">
          本会话将直接切换到 {runnerLabel(confirmTarget)}；项目绑定同步切换，新会话保持一致。工作目录
          {projectBinding ? ` ${projectBinding.canonicalCwd} ` : '（沿用当前目录）'}与项目指令不变。
        </span>
        <span className="block">已开始或暂停的运行留在原设备完成；切换后发送的任务直接在所选设备上执行。</span>
      </span>
    );
  }
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
                  onSelectRequest: requestSwitch,
                  selectionHint:
                    '绑定的设备离线时可直接「选择」另一台切换本会话；设备在线不允许切走。也可复制启动命令让当前设备上线。',
                }
              : {})}
          />
        </Suspense>
      )}
      <ConfirmationDialog
        open={Boolean(confirmTarget)}
        onClose={() => setConfirmTarget(null)}
        title="切换会话设备"
        subject={`当前会话：${runnerLabel(runnerId)} → ${confirmTarget ? runnerLabel(confirmTarget) : ''}`}
        description={confirmDescription}
        icon={<Server />}
        confirmLabel="切换"
        pendingLabel="切换中…"
        isPending={switchRunners.isPending}
        error={switchRunners.error}
        onConfirm={() => {
          if (confirmTarget) switchRunners.mutate(confirmTarget);
        }}
      />
    </>
  );
}
