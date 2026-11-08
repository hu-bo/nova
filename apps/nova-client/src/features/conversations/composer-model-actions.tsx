import { ModelPicker } from '@/features/models';
import { BrainCircuit, ClipboardList, Code2, Layers3 } from 'lucide-react';
import { ComposerOptionMenu } from './composer-option-menu';
import type { ConversationComposerController } from './use-conversation-composer';

type AgentMode = 'build' | 'plan' | 'spec';
const agentModes = {
  build: { label: 'Build', description: '推进实现与执行', icon: Code2 },
  plan: { label: 'Plan', description: '只读分析与规划', icon: ClipboardList },
  spec: { label: 'Spec', description: '从首条需求开启规格开发', icon: Layers3 },
} satisfies Record<AgentMode, { label: string; description: string; icon: typeof Code2 }>;

export function ComposerModelActions({
  controller: ctl,
}: {
  controller: ConversationComposerController;
}) {
  let activeMode: AgentMode = ctl.executionMode;
  if (ctl.specSession) activeMode = 'plan';
  else if (ctl.specArmed) activeMode = 'spec';
  const Icon = agentModes[activeMode].icon;
  const executionModeOptions = Object.entries(agentModes)
    .filter(([value]) => value !== 'spec' || ctl.canStartSpec)
    .map(([value, item]) => ({ value, label: item.label, description: item.description }));
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
        value={activeMode}
        options={executionModeOptions}
        disabled={ctl.sending || ctl.specSession}
        onChange={(value) => {
          if (value === 'spec') {
            ctl.setSpecArmed(true);
            ctl.setGoalArmed(false);
          }
          if (value === 'plan' || value === 'build') {
            ctl.setSpecArmed(false);
            ctl.setExecutionMode(value);
          }
        }}
        icon={<Icon aria-hidden="true" />}
      />
    </div>
  );
}
