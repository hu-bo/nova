// §5.3 存储接口 —— 定在 agent-core，实现由外部注入。两条流都 append-only，没有 update/delete。
import type { Entry, EntryId } from "./entry.js";
import type { Record } from "./record.js";

export interface RecordFilter {
  runId?: string;
  kind?: Record["kind"];
  limit?: number;
  desc?: boolean;
}

export interface SessionStorage {
  appendEntry(sessionId: string, entry: Entry): Promise<void>;
  appendRecord(sessionId: string, record: Record): Promise<void>;
  /** 返回该分支（从 leaf 沿 parentId 回溯），已按序（根 → 叶）。leafId 缺省 = 最后写入的叶。 */
  loadEntries(sessionId: string, leafId?: EntryId): Promise<Entry[]>;
  loadRecords(sessionId: string, filter?: RecordFilter): Promise<Record[]>;
}

// 集成测试 / CLI 用内存实现。PG 实现在 agent-server，不在本包。
export function memoryStorage(): SessionStorage {
  const sessions = new Map<string, { entries: Map<EntryId, Entry>; lastLeaf: EntryId | null; records: Record[] }>();

  function getSession(sessionId: string) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { entries: new Map(), lastLeaf: null, records: [] };
      sessions.set(sessionId, state);
    }
    return state;
  }

  return {
    async appendEntry(sessionId, entry) {
      const state = getSession(sessionId);
      state.entries.set(entry.id, entry);
      state.lastLeaf = entry.id;
    },
    async appendRecord(sessionId, record) {
      getSession(sessionId).records.push(record);
    },
    async loadEntries(sessionId, leafId) {
      const state = getSession(sessionId);
      const leaf = leafId ?? state.lastLeaf;
      if (!leaf) return [];
      // 从叶回溯到根再反转；树里混入孤儿 id 说明实现写坏了，直接抛而不是静默截断
      const branch: Entry[] = [];
      let current: EntryId | null = leaf;
      while (current !== null) {
        const entry = state.entries.get(current);
        if (!entry) throw new Error(`entry not found: ${current}`);
        branch.push(entry);
        current = entry.parentId;
      }
      return branch.reverse();
    },
    async loadRecords(sessionId, filter) {
      let records = getSession(sessionId).records;
      if (filter?.runId !== undefined) records = records.filter((record) => record.runId === filter.runId);
      if (filter?.kind !== undefined) records = records.filter((record) => record.kind === filter.kind);
      if (filter?.desc) records = [...records].reverse();
      if (filter?.limit !== undefined) records = records.slice(0, filter.limit);
      return records;
    },
  };
}
