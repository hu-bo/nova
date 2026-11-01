import { useState, type ReactNode } from 'react';
import { Description, Label, ListBox, Popover } from '@heroui/react';
import {
  BrainCircuit,
  ChevronDown,
  ClipboardList,
  Code2,
  Settings2,
  Target,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ModelPicker } from '@/features/models';
import type { ConversationComposerController } from './use-conversation-composer';

const executionModeOptions = [
  { value: 'build', label: 'Build', description: '推进实现与执行' },
  { value: 'plan', label: 'Plan', description: '只读分析与规划' },
] as const;

function ComposerOptionMenu({
  label,
  value,
  options,
  disabled,
  icon,
  onChange,
}: {
  label: string;
  value?: string | undefined;
  options: readonly { value: string; label: string; description?: string; disabled?: boolean }[];
  disabled: boolean;
  icon: ReactNode;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button variant="ghost" disabled={disabled} aria-label={label}>
        <span aria-hidden="true" className="[&_svg]:size-4">
          {icon}
        </span>
        <span className="text-xs">
          {options.find((option) => option.value === value)?.label ?? label}
        </span>
        <ChevronDown size={12} />
      </Button>
      <Popover.Content placement="top end">
        <Popover.Dialog>
          <ListBox
            aria-label={label}
            selectionMode="single"
            selectedKeys={new Set(value ? [value] : [])}
            onSelectionChange={(keys) => {
              const key = keys === 'all' ? undefined : Array.from(keys)[0];
              if (key !== undefined) {
                onChange(String(key));
                setOpen(false);
              }
            }}
            disabledKeys={options.filter((option) => option.disabled).map((option) => option.value)}
            onAction={(key) => {
              onChange(String(key));
              setOpen(false);
            }}
          >
            {options.map((option) => (
              <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                <div>
                  <Label>{option.label}</Label>
                  {option.description && <Description>{option.description}</Description>}
                </div>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

export function ComposerStartActions({
  controller: ctl,
}: {
  controller: ConversationComposerController;
}) {
  const hasGoal = Boolean(ctl.goal && ctl.goal.status !== 'completed');
  return (
    <>
      <Button
        variant={ctl.goalArmed || hasGoal ? 'secondary' : 'ghost'}
        isIconOnly
        aria-label={
          hasGoal ? '查看当前目标' : ctl.goalArmed ? '取消目标模式' : '将下一条消息作为目标'
        }
        title="/goal · 设置会话目标"
        aria-pressed={ctl.goalArmed || hasGoal}
        disabled={ctl.sending}
        onPress={() => (hasGoal ? ctl.setGoalDialogOpen(true) : ctl.setGoalArmed(!ctl.goalArmed))}
      >
        <Target size={16} />
      </Button>
    </>
  );
}

export function ComposerModelActions({
  controller: ctl,
}: {
  controller: ConversationComposerController;
}) {
  return (
    <div className="nova-model-controls flex min-w-0 flex-wrap items-center gap-1">
      <ModelPicker
        profiles={ctl.modelProfiles}
        value={ctl.modelProfileId}
        onChange={ctl.changeModel}
        loading={ctl.modelLoading}
        disabled={ctl.sending}
      />
      {ctl.reasoningEfforts.length > 0 && (
        <ComposerOptionMenu
          label="推理强度"
          value={ctl.reasoningEffort}
          options={ctl.reasoningEfforts}
          disabled={ctl.sending}
          onChange={ctl.changeReasoning}
          icon={<BrainCircuit aria-hidden="true" />}
        />
      )}
      <ComposerOptionMenu
        label="Agent 模式"
        value={ctl.executionMode}
        options={executionModeOptions}
        disabled={ctl.sending}
        onChange={(value) => {
          if (value === 'plan' || value === 'build') ctl.setExecutionMode(value);
        }}
        icon={
          ctl.executionMode === 'plan' ? (
            <ClipboardList aria-hidden="true" />
          ) : (
            <Code2 aria-hidden="true" />
          )
        }
      />
    </div>
  );
}

export function ComposerGoalHeader({
  controller: ctl,
}: {
  controller: ConversationComposerController;
}) {
  if (!ctl.goalArmed)
    return ctl.executionMode === 'plan' ? (
      <p className="flex items-center gap-2 px-2 pb-2 pt-1 text-xs text-slate-500">
        <ClipboardList size={13} />
        Plan 模式 · 先分析和规划，不修改文件
      </p>
    ) : null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent-soft-foreground">
      <Target size={14} />
      <span className="min-w-0 flex-1">下一条消息将作为会话目标</span>
      <Popover>
        <Button size="sm" variant="ghost" aria-label="目标选项">
          <Settings2 size={13} />
          <span>{ctl.maxIterations} 轮上限</span>
        </Button>
        <Popover.Content placement="top" className="z-50 w-72">
          <Popover.Dialog>
            <Popover.Heading>目标选项</Popover.Heading>
            <label className="mt-3 block text-sm">
              最多执行轮次
              <Input
                aria-label="目标执行轮次"
                className="mt-2"
                type="number"
                min="1"
                max="100"
                value={ctl.maxIterations}
                onChange={(event) =>
                  ctl.setMaxIterations(Math.max(1, Math.min(100, Number(event.target.value) || 1)))
                }
              />
            </label>
            <label className="mt-3 block text-sm">
              完成标准
              <Textarea
                aria-label="目标完成标准"
                className="mt-2"
                rows={3}
                maxLength={8000}
                value={ctl.acceptanceCriteria}
                placeholder="可选：明确怎样算完成"
                onChange={(event) => ctl.setAcceptanceCriteria(event.target.value)}
              />
            </label>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      <Button
        variant="ghost"
        isIconOnly
        aria-label="取消目标模式"
        onPress={() => ctl.setGoalArmed(false)}
      >
        <X size={13} />
      </Button>
    </div>
  );
}
