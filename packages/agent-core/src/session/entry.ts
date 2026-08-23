// §5.1 Entry —— 会话内容流：进模型上下文，parentId 构成树（不是数组）。
import type { Message } from "../types.js";
import type { ThinkingLevel } from "@nova/model-adapters";

export type EntryId = string;

export interface EntryBase { id: EntryId; parentId: EntryId | null; ts: number }

export type Entry = EntryBase & (
  | { kind: "message"; message: Message }
  | { kind: "model"; model: string }
  | { kind: "thinking-level"; level: ThinkingLevel }
  | { kind: "active-tools"; tools: string[] }
  | { kind: "compaction"; summary: string; replacedFrom: EntryId; replacedTo: EntryId }
);

let counter = 0;
export function newEntryId(): EntryId {
  counter += 1;
  return `entry-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Omit 对联合类型不逐成员分发，直接 Omit<Entry, …> 会丢掉各 kind 的专有字段，需要 distributive 版本
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type EntryParts = DistributiveOmit<Entry, "id" | "parentId" | "ts">;

export function entry(parts: EntryParts & { id?: EntryId; parentId?: EntryId | null; ts?: number }): Entry {
  return { id: newEntryId(), parentId: null, ts: Date.now(), ...parts } as Entry;
}
