import type { AgentMessage } from "./message.js";
import type { ModelRouteSnapshot } from "./model.js";
export interface ContextInput {
  readonly signal: AbortSignal;
  readonly route?: ModelRouteSnapshot;
  readonly toolSchemaCharacters: number;
}
export interface ContextContribution {
  readonly id: string;
  readonly order: number;
  build(input: ContextInput): Promise<readonly AgentMessage[]>;
}
export interface ContextBuilder {
  build(input: ContextInput): Promise<readonly AgentMessage[]>;
}
export interface ContextCompactor {
  compact(input: { signal: AbortSignal; route?: ModelRouteSnapshot }): Promise<boolean>;
}
