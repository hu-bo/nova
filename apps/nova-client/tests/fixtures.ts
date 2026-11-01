import type { GetConversationSnapshot200 } from '../src/api/generated/projectsAPI.schemas';
import { productEventSchema, type ProductEvent } from '@nova/agent-ui-contracts';
export const conversationId = '00000000-0000-4000-8000-000000000001';
export const snapshot = (
  overrides: Partial<GetConversationSnapshot200> = {},
): GetConversationSnapshot200 => ({
  conversation: {
    id: conversationId,
    title: '测试会话',
    mode: 'chat',
    projectId: null,
    epoch: 1,
    configuration: { backendId: 'nova', modelId: null, mode: 'build' },
  },
  cursor: '0',
  run: null,
  messages: [],
  beforeSequence: null,
  operations: [],
  interactions: [],
  pendingInputs: [],
  plan: [],
  goal: null,
  binding: null,
  capabilities: {
    tools: true,
    approval: true,
    question: false,
    steering: true,
    resume: true,
    compact: false,
    images: false,
    files: true,
  },
  ...overrides,
});
export const message = {
  id: 'm',
  runId: 'run-1',
  sequence: '1',
  role: 'assistant' as const,
  state: 'streaming' as const,
  createdAt: '2026-10-14T00:00:00Z',
  blocks: [{ id: 'b', type: 'text' as const, text: '' }],
};
export function event(
  type: ProductEvent['type'],
  sequence: number | string,
  payload: unknown,
): ProductEvent {
  return productEventSchema.parse({ runId: 'run-1', sequence: String(sequence), type, payload });
}
