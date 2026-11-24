import type { BadgeProps } from '@/components/ui/badge';
import type { ArtifactPreviewKind, ArtifactState } from '@nova/agent-ui-contracts';
import type { ListConversationArtifacts200ItemsItem } from '@/api/generated/projectsAPI.schemas';

/**
 * 产物展示派生单表（P1-G1）：状态与预览形态的文案、样式只在此处定义，
 * 卡片渲染不再散落分支（AGENTS.md 状态配置单表）。
 */

/** 产物条目类型（GET /conversations/:id/artifacts 生成形状，与契约 ArtifactSummary 一致）。 */
export type ArtifactEntry = ListConversationArtifacts200ItemsItem;

/** 发布状态 → 徽标：publishing 不承诺下载，failed 附服务端原因。 */
export const ARTIFACT_STATE_BADGES = {
  publishing: { label: '正在发布', variant: 'warning', hint: '文件上传中，完成后才能下载。' },
  ready: { label: '已就绪', variant: 'success', hint: null },
  failed: { label: '发布失败', variant: 'danger', hint: null },
} satisfies Record<
  ArtifactState,
  {
    label: string;
    variant: Required<Pick<BadgeProps, 'variant'>>['variant'];
    hint: string | null;
  }
>;

/** 预览形态 → 按钮文案与可否内嵌预览；服务端类型矩阵已定，download 只显示下载。 */
export const ARTIFACT_PREVIEW_ACTIONS = {
  markdown: { label: '预览', previewable: true },
  text: { label: '预览', previewable: true },
  image: { label: '预览', previewable: true },
  download: { label: '下载', previewable: false },
} satisfies Record<ArtifactPreviewKind, { label: string; previewable: boolean }>;

/** 大小人类可读：与消息附件展示同一进位（B / KB / MB）。 */
export function formatArtifactSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}
