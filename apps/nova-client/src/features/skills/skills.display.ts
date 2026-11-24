import type { SkillCatalogStatus } from '@nova/agent-ui-contracts';
import { EXECUTION_MODES } from '@/features/conversations';

/**
 * 技能目录整体状态文案矩阵（§3.1 第 3、8 段）：每个状态独立文案与可操作性，
 * 不得把「未绑定/离线/扫描中/不完整/过期/不支持」当作「用户没有技能」。
 */
export const CATALOG_STATUS_GUIDANCE = {
  ready: {
    label: '目录已就绪',
    summary: '本地技能目录已同步。',
    actionable: 'none',
  },
  scanning: {
    label: '扫描中',
    summary: '本地技能目录仍在扫描，结果可能不完整；可稍后刷新查看。',
    actionable: 'refresh',
  },
  incomplete: {
    label: '目录不完整',
    summary: '上次扫描超过条目或大小上限，目录不完整；请打开诊断或清理后刷新。',
    actionable: 'refresh',
  },
  stale: {
    label: '目录已过期',
    summary: '上次刷新失败，这里保留的是旧目录结果；过期目录中的新选择需刷新后重新核实。',
    actionable: 'refresh',
  },
  offline: {
    label: 'Runner 离线',
    summary: '该 Runner 当前离线，无法读取其上的本地技能；内置与平台技能不受影响。',
    actionable: 'none',
  },
  unsupported: {
    label: '不支持本地发现',
    summary: '该 Runner 版本未提供本地技能发现能力，本机全局与项目技能暂不可见；可继续使用内置与平台技能。',
    actionable: 'none',
  },
} satisfies Record<
  SkillCatalogStatus,
  { label: string; summary: string; actionable: 'refresh' | 'none' }
>;

/** 适用模式展示：与执行模式表同一来源。 */
export function allowedModesLabel(modes: readonly string[]): string {
  return modes.map((mode) => EXECUTION_MODES[mode as keyof typeof EXECUTION_MODES].label).join(' / ');
}

/** 布尔执行要求文案。 */
export function requirementFlag(value: boolean): string {
  return value ? '需要' : '不需要';
}
