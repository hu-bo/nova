import {
  applyEvent,
  mergeSnapshot,
  snapshotSchema,
  isActiveRun,
  type ProductEvent,
  type QueuedInput,
  type Snapshot,
} from '@nova/agent-ui-contracts';
import type { GetConversationSnapshot200 } from '@/api/generated/projectsAPI.schemas';
export { isActiveRun } from '@nova/agent-ui-contracts';

export type RunState = {
  data: Snapshot;
  cursor: string;
  run: Snapshot['run'];
  needsSnapshot: boolean;
  startingInput: (QueuedInput & { createdAt: number }) | null;
};
const stateOf = (data: Snapshot, startingInput: RunState['startingInput']): RunState => ({
  data,
  cursor: data.cursor,
  run: data.run,
  needsSnapshot: false,
  startingInput,
});

function selectStartingInput(data: Snapshot, previous: RunState['startingInput'], newRun = false) {
  if (data.run?.state === 'cancelled_unconfirmed') return null;
  if (previous) {
    const queued = data.pendingInputs.find((input) => input.id === previous.id);
    if (queued) return { ...previous, ...queued };
    // Consumption can arrive before the corresponding message commit.
    if (
      previous.state === 'consumed' &&
      previous.messageId &&
      !data.messages.some((message) => message.id === previous.messageId)
    )
      return previous;
  }
  const input = data.pendingInputs.find(
    (item) =>
      item.state === 'queued' &&
      item.input.mode === 'next_run' &&
      (item.runId ? item.runId === data.run?.id : !isActiveRun(data.run?.state) || newRun),
  );
  return input ? { ...input, createdAt: Date.now() } : null;
}

export function initialRunState(
  snapshot: GetConversationSnapshot200,
  previous?: RunState,
): RunState {
  const { binding: _binding, ...core } = snapshot;
  const data = mergeSnapshot(snapshotSchema.parse(core), previous?.data);
  return stateOf(data, selectStartingInput(data, previous?.startingInput ?? null));
}
export function reduceRunState(state: RunState, event: ProductEvent): RunState {
  try {
    const next = applyEvent(state.data, event);
    if (next === state.data) return state;
    let startingInput = state.startingInput;
    if (
      startingInput &&
      !startingInput.messageId &&
      event.type === 'message.committed' &&
      event.payload.message.role === 'user' &&
      event.payload.message.runId === next.run?.id
    )
      startingInput = { ...startingInput, messageId: event.payload.message.id };
    if (event.type === 'input.consumed' && event.payload.input.id === startingInput?.id)
      startingInput = { ...startingInput, ...event.payload.input, state: 'consumed' };
    if (
      (event.type === 'input.removed' || event.type === 'input.rejected') &&
      event.payload.input.id === startingInput?.id
    )
      startingInput = null;
    return stateOf(
      next,
      selectStartingInput(
        next,
        startingInput,
        event.type === 'run.changed' && event.payload.run.id !== state.run?.id,
      ),
    );
  } catch (error) {
    if (import.meta.env.DEV)
      console.debug('[runs] 事件套用失败 type=%s seq=%s', event.type, event.sequence, error);
    return { ...state, needsSnapshot: true };
  }
}
