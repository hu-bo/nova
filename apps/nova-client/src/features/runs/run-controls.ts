import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DecisionRequest, DecisionResponse } from '@nova/chat-ui';
import type { Configuration } from '@nova/agent-ui-contracts';
import { CommandIntent } from '@/api/command-intent';
import { queryKeys } from '@/api/query-keys';
import { useIdentity } from '@/features/auth';
import { appendConversationInput } from '@/api/generated/conversations';
import type { AppendConversationInputBody } from '@/api/generated/projectsAPI.schemas';
import { isActiveRun } from './run-event-reducer';
import { cancelRun, respondInteraction } from './run.commands';
import type { RunStreamSnapshot } from './run-stream-manager';

/** 决策应答 → interaction 请求体：审批收敛为 allow/deny，allow_always 放宽为会话范围。 */
function buildResponsePayload(response: DecisionResponse) {
  if (response.kind === 'approval') {
    return {
      kind: 'approval' as const,
      decision: response.decision === 'deny' ? ('deny' as const) : ('allow' as const),
      scope: response.decision === 'allow_always' ? ('session' as const) : ('once' as const),
    };
  }
  return {
    kind: 'question' as const,
    optionIds: response.optionIds,
    ...(response.customText ? { customText: response.customText } : {}),
  };
}

/**
 * 运行控制（停止 / 决策裁决）的共享状态。
 *
 * 从 `RunPanel` 抽出：对话页把同一个 hook 实例同时喂给 `Chat`（停止按钮、ESC 中断、
 * 决策浮层）、`RunStatus`（标题栏状态行）与 `RunPanel`（倒计时摘要），
 * 避免各处各自持有 mutation 状态。
 */
export function useRunControls(stream: RunStreamSnapshot) {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const cancelIntent = useRef(new CommandIntent());
  const decisionIntent = useRef(new CommandIntent());
  const continueIntent = useRef(new CommandIntent());
  const [now, setNow] = useState(Date.now());
  const projection = stream.projection;
  const decision = projection?.decisions[0];
  useEffect(() => {
    if (!decision?.expiresAt && !stream.retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [decision?.expiresAt, stream.retryAt]);
  const refresh = () =>
    client.invalidateQueries({
      queryKey: queryKeys.conversations.snapshot(identity!.identityId, projection!.conversationId),
    });
  const cancel = useMutation({
    mutationFn: () => {
      const runId = projection?.run?.id;
      if (!runId) throw new Error('No active run');
      return cancelRun(runId, cancelIntent.current.prepare({ runId }));
    },
    onSuccess: () => {
      cancelIntent.current.accepted();
    },
    onError: refresh,
  });
  const continueRun = useMutation({
    mutationFn: (configuration?: Configuration) => {
      if (!projection || projection.run?.state !== 'budget_exhausted')
        throw new Error('No exhausted run to continue');
      const skill = projection.data.messages.findLast((message) => message.role === 'user')?.skill;
      let nextConfiguration: AppendConversationInputBody['configuration'];
      if (configuration) {
        nextConfiguration = {
          backendId: configuration.backendId,
          modelId: configuration.modelId,
          mode: configuration.mode,
          ...(configuration.agentProfile ? { agentProfile: configuration.agentProfile } : {}),
          ...(configuration.reasoningEffort
            ? { reasoningEffort: configuration.reasoningEffort }
            : {}),
          ...(configuration.remoteConnectionId
            ? { remoteConnectionId: configuration.remoteConnectionId }
            : {}),
        };
        if (configuration.budget)
          nextConfiguration.budget = {
            ...(configuration.budget.maxSteps === undefined
              ? {}
              : { maxSteps: configuration.budget.maxSteps }),
            ...(configuration.budget.maxToolCalls === undefined
              ? {}
              : { maxToolCalls: configuration.budget.maxToolCalls }),
          };
      }
      const payload: AppendConversationInputBody = {
        mode: 'next_run' as const,
        ...(nextConfiguration ? { configuration: nextConfiguration } : {}),
        blocks: [
          {
            id: 'text',
            type: 'text' as const,
            text: '继续上轮尚未完成的任务，从已保存的进度接着处理。',
          },
        ],
        ...(skill ? { skill: { id: skill.id, version: skill.version } } : {}),
      };
      return appendConversationInput(projection.conversationId, payload, {
        idempotencyKey: continueIntent.current.prepare({
          conversationId: projection.conversationId,
          runId: projection.run.id,
          payload,
        }),
      });
    },
    onSuccess: async () => {
      continueIntent.current.accepted();
      await refresh();
    },
    onError: refresh,
  });
  const resolve = useMutation({
    mutationFn: (response: DecisionResponse) => {
      if (!decision || (decision.expiresAt && Date.parse(decision.expiresAt) <= Date.now()))
        throw new Error('Expired decision');
      const payload = {
        expectedRevision: decision.revision,
        response: buildResponsePayload(response),
      };
      const runId = projection?.run?.id;
      if (!runId) throw new Error('No interaction run');
      return respondInteraction(
        runId,
        decision.id,
        payload,
        decisionIntent.current.prepare({ runId, id: decision.id, ...payload }),
      );
    },
    onSuccess: async () => {
      decisionIntent.current.accepted();
      await refresh();
    },
    onError: refresh,
  });
  const resetCancel = cancel.reset;
  const resetResolve = resolve.reset;
  const resetContinue = continueRun.reset;
  useEffect(() => {
    resetCancel();
    resetContinue();
  }, [projection?.run?.id, resetCancel, resetContinue]);
  useEffect(() => {
    resetResolve();
    setNow(Date.now());
  }, [decision?.id, decision?.revision, resetResolve]);
  const remaining = decision?.expiresAt
    ? Math.max(0, Math.ceil((Date.parse(decision.expiresAt) - now) / 1000))
    : null;
  let request: DecisionRequest | null = null;
  if (decision) {
    request =
      decision.kind === 'question'
        ? {
            kind: 'question',
            decisionId: decision.id,
            question: decision.question,
            options: decision.options,
            multiSelect: decision.multiSelect,
            allowCustom: decision.allowCustom,
          }
        : {
            kind: 'approval',
            decisionId: decision.id,
            toolName: decision.toolName,
            args: decision.args,
            allowedScopes: decision.allowedScopes,
            risk: decision.risk,
            ...(decision.message ? { message: decision.message } : {}),
            ...(decision.codeChanges ? { codeChanges: decision.codeChanges } : {}),
          };
  }
  const cancelling =
    projection?.run?.state === 'cancelling' || cancel.isSuccess || cancel.isPending;
  const canCancel = Boolean(
    projection?.run?.id && isActiveRun(projection?.run?.state) && !cancelling,
  );
  return { cancel, continueRun, resolve, decision, request, remaining, cancelling, canCancel, now };
}

export type RunControls = ReturnType<typeof useRunControls>;
