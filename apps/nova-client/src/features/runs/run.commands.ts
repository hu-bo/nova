import {
  cancelRun as cancelRunRequest,
  respondInteraction as respondInteractionRequest,
} from '@/api/generated/runs';
import type { RespondInteractionBody } from '@/api/generated/projectsAPI.schemas';
export const cancelRun = (id: string, key: string) =>
  cancelRunRequest(id, {}, { idempotencyKey: key });
export const respondInteraction = (
  runId: string,
  id: string,
  payload: RespondInteractionBody,
  key: string,
) => respondInteractionRequest(runId, id, payload, { idempotencyKey: key });
