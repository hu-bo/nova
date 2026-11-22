import type { Configuration } from '@nova/agent-ui-contracts';
import { ClipboardList, Code2, ShieldOff, type LucideIcon } from 'lucide-react';

export type ExecutionMode = Configuration['mode'];

/** Agent 执行模式表: 菜单文案、会话标签与顶部提示共用同一来源. */
export const EXECUTION_MODES = {
  build: {
    label: 'Build',
    description: '推进实现与执行，写入和命令需确认（安全模式）',
    contextLabel: 'Build · 推进实现',
    headerHint: '',
    icon: Code2,
  },
  plan: {
    label: 'Plan',
    description: '只读分析与规划',
    contextLabel: 'Plan · 只读分析与规划',
    headerHint: 'Plan 模式 · 先分析和规划，不修改文件',
    icon: ClipboardList,
  },
  auto: {
    label: 'Auto',
    description: '自由模式：全部操作自动放行，无人值守',
    contextLabel: 'Auto · 自由模式，全部操作自动放行',
    headerHint: 'Auto 模式 · 全部操作直接执行，不再逐次确认',
    icon: ShieldOff,
  },
} satisfies Record<
  ExecutionMode,
  {
    label: string;
    description: string;
    contextLabel: string;
    headerHint: string;
    icon: LucideIcon;
  }
>;

/** 菜单展示顺序; 与模式表同一集合. */
export const EXECUTION_MODE_ORDER = ['build', 'plan', 'auto'] as const satisfies readonly ExecutionMode[];

/** `/命令` → 执行模式，与模式菜单保持同一集合. */
export const MODE_COMMANDS = {
  plan: 'plan',
  build: 'build',
  auto: 'auto',
} as const satisfies Record<string, ExecutionMode>;
export type ModeCommand = keyof typeof MODE_COMMANDS;

export const isModeCommand = (value: string): value is ModeCommand =>
  Object.hasOwn(MODE_COMMANDS, value);

export const isExecutionMode = (value: string): value is ExecutionMode =>
  Object.hasOwn(EXECUTION_MODES, value);
