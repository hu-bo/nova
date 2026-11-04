import { ModelPicker } from '@/features/models';
import { BrainCircuit, ClipboardList, Code2 } from 'lucide-react';
import { ComposerOptionMenu } from './composer-option-menu';
import type { ConversationComposerController } from './use-conversation-composer';

const executionModeOptions = [
  { value: 'build', label: 'Build', description: '推进实现与执行' },
  { value: 'plan', label: 'Plan', description: '只读分析与规划' },
] as const;

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
