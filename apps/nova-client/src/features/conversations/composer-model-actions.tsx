import { ModelPicker } from '@/features/models';
import { BrainCircuit, Layers3 } from 'lucide-react';
import { ComposerOptionMenu } from './composer-option-menu';
import {
  EXECUTION_MODES,
  EXECUTION_MODE_ORDER,
  isExecutionMode,
  type ExecutionMode,
} from './execution-modes';
import type { ConversationComposerController } from './use-conversation-composer';

const SPEC_MODE = { label: 'Spec', description: '从首条需求开启规格开发', icon: Layers3 };

export function ComposerModelActions({
  controller: ctl,
}: {
  controller: ConversationComposerController;
}) {
  let activeMode: ExecutionMode | 'spec' = ctl.executionMode;
  if (ctl.specSession) activeMode = 'plan';
  else if (ctl.specArmed) activeMode = 'spec';
  const active = activeMode === 'spec' ? SPEC_MODE : EXECUTION_MODES[activeMode];
  const Icon = active.icon;
  const executionModeOptions = [
    ...EXECUTION_MODE_ORDER.map((value) => ({
      value,
      label: EXECUTION_MODES[value].label,
      description: EXECUTION_MODES[value].description,
    })),
    ...(ctl.canStartSpec ? [{ value: 'spec', label: SPEC_MODE.label, description: SPEC_MODE.description }] : []),
  ];
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
      {!ctl.chatAgent && (
        <ComposerOptionMenu
          label="Agent 模式"
          value={activeMode}
          options={executionModeOptions}
          disabled={ctl.sending || ctl.specSession}
          onChange={(value) => {
            if (value === 'spec') {
              ctl.setSpecArmed(true);
              ctl.setGoalArmed(false);
              return;
            }
            if (isExecutionMode(value)) {
              void ctl.changeExecutionMode(value);
            }
          }}
          icon={<Icon aria-hidden="true" />}
        />
      )}
    </div>
  );
}
