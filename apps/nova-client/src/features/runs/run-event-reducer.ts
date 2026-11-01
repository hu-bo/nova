import type { Block as ViewBlock, ChatMessage, ComposerContextUsage } from '@nova/chat-ui';
import {
  operationsFromMessages,
  type Block,
  type Message,
  type ProductEvent,
  type Snapshot,
  type ToolOperation,
} from '@nova/agent-ui-contracts';
import type { GetConversationSnapshot200 } from '@/api/generated/projectsAPI.schemas';
import { initialRunState, reduceRunState, type RunState } from './run-state';
export { isActiveRun } from '@nova/agent-ui-contracts';
function blockView(block: Block, operations: ToolOperation[]): ViewBlock {
  switch (block.type) {
    case 'text':
    case 'thinking':
    case 'code':
      return block;
    case 'diff': {
      const lines = block.diff.split('\n');
      return {
        ...block,
        added: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
        removed: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      };
    }
    case 'image':
      return {
        id: block.id,
        type: 'image',
        key: block.attachment.ref.kind === 'object' ? block.attachment.ref.key : '',
        name: block.attachment.name,
        mimeType: block.attachment.mimeType,
      };
    case 'file':
      return {
        id: block.id,
        type: 'file',
        path:
          block.attachment.ref.kind === 'object'
            ? block.attachment.name
            : block.attachment.ref.path,
        kind: 'file',
        ...(block.attachment.size !== undefined ? { size: block.attachment.size } : {}),
      };
    case 'error':
      return { id: block.id, type: 'error', ...block.error };
    case 'custom':
      return { id: block.id, type: 'custom', name: block.name, fallback: block.fallback };
    case 'tool_call': {
      const operation = operations.find((item) => item.callId === block.callId);
      return {
        ...block,
        status:
          operation?.state === 'unknown'
            ? 'unknown'
            : operation?.state === 'succeeded'
              ? 'ok'
              : operation?.state === 'cancelled'
                ? 'cancelled'
                : operation && ['failed', 'denied'].includes(operation.state)
                  ? 'error'
                  : operation?.state === 'running'
                    ? 'running'
                    : 'queued',
      };
    }
    case 'tool_result':
      return {
        id: block.id,
        type: 'tool_result',
        callId: block.callId,
        status: block.outcome === 'succeeded' ? 'ok' : 'error',
        blocks: block.content.map((content) => blockView(content, operations)),
      };
  }
}
const messageViews = new WeakMap<
  Message,
  { conversationId: string; signature: string; view: ChatMessage | null }
>();
const blockViews = new WeakMap<Block, ViewBlock>();
export function messageView(
  message: Message,
  conversationId: string,
  operations: ToolOperation[] = [],
): ChatMessage | null {
  const signature = message.blocks
    .filter((block) => block.type === 'tool_call')
    .map(
      (block) =>
        operations.find((operation) => operation.callId === block.callId)?.state ?? 'queued',
    )
    .join(',');
  const prior = messageViews.get(message);
  if (prior?.conversationId === conversationId && prior.signature === signature) return prior.view;
  const view: ChatMessage | null =
    message.role === 'system'
      ? null
      : {
          id: message.id,
          conversationId,
          role: message.role,
          createdAt: Date.parse(message.createdAt),
          blocks: message.blocks.map((block) => {
            const cached = block.type === 'tool_call' ? undefined : blockViews.get(block);
            let converted = cached ?? blockView(block, operations);
            if (!cached && block.type !== 'tool_call') blockViews.set(block, converted);
            if (converted.type === 'image')
              converted = {
                ...converted,
                reference: { conversationId, messageId: message.id, blockId: block.id },
              };
            return converted;
          }),
          status:
            message.state === 'streaming'
              ? 'streaming'
              : message.state === 'failed'
                ? 'error'
                : message.state === 'cancelled'
                  ? 'aborted'
                  : 'done',
        };
  messageViews.set(message, { conversationId, signature, view });
  return view;
}
export type RunProjection = ReturnType<typeof projectionView>;
function projectionView(
  data: Snapshot,
  needsSnapshot = false,
  startingInput: RunState['startingInput'] = null,
) {
  const operations = operationsFromMessages(data.messages, data.operations);
  const messages = data.messages.flatMap((message) => {
    const view = messageView(message, data.conversation.id, operations);
    return view ? [view] : [];
  });
  if (startingInput && !data.messages.some((message) => message.id === startingInput.messageId))
    messages.push({
      id: startingInput.messageId ?? 'input:' + startingInput.id,
      conversationId: data.conversation.id,
      role: 'user',
      status: 'done',
      createdAt: startingInput.createdAt,
      blocks: startingInput.input.blocks.map((block): ViewBlock =>
        block.type === 'text'
          ? block
          : {
              id: block.id,
              type: 'file',
              path: block.attachment.name,
              kind: 'file',
              size: block.attachment.size,
            },
      ),
    });
  return {
    data,
    conversationId: data.conversation.id,
    cursor: data.cursor,
    epoch: data.conversation.epoch,
    messages,
    run: data.run,
    todos: data.plan ?? [],
    goal: data.goal,
    decisions: data.interactions.filter((item) => item.state === 'pending'),
    pendingInputs: data.pendingInputs.filter((input) => input.id !== startingInput?.id),
    startingInput,
    toolOutputs: Object.fromEntries(
      data.operations.map((operation) => [
        operation.id,
        {
          operationId: operation.id,
          stdout: operation.stdout?.text ?? '',
          stderr: operation.stderr?.text ?? '',
          truncated:
            (operation.stdout?.startOffset ?? 0) > 0 || (operation.stderr?.startOffset ?? 0) > 0,
          status: operation.state,
        },
      ]),
    ),
    usage:
      data.usage?.contextUsed !== undefined && data.usage.contextLimit
        ? ({
            estimatedInputTokens: data.usage.contextUsed,
            maxInputTokens: data.usage.contextLimit,
          } as ComposerContextUsage)
        : undefined,
    needsSnapshot,
  };
}
export function projectRunState(state: RunState): RunProjection {
  return projectionView(state.data, state.needsSnapshot, state.startingInput);
}
export function initialProjection(
  snapshot: GetConversationSnapshot200,
  previous?: RunProjection,
): RunProjection {
  return projectRunState(initialRunState(snapshot, previous));
}
export function reduceRunEvent(state: RunProjection, event: ProductEvent): RunProjection {
  const next = reduceRunState(state, event);
  return next === state ? state : projectRunState(next);
}
