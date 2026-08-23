// §7 三条队列 —— 消息缓冲，不是调度器：元素是 string，出队只看 turn 边界。
// 不 import taskflow（那边元素是 Task，出队条件是依赖+额度，仅同名）。
import type { QueueName } from "../types.js";
import { record } from "../session/record.js";
import type { SessionStorage } from "../session/storage.js";

export interface Queues {
  enqueue(queue: QueueName, message: string): Promise<void>;
  drain(queue: QueueName): string[];
  nonEmpty(queue: QueueName): boolean;
}

export function createQueues(sessionId: string, storage: SessionStorage, currentRunId: () => string): Queues {
  const queues: { [K in QueueName]: string[] } = { steering: [], followUp: [], nextRun: [] };
  return {
    // 入队必须落 queue-enqueued Record：用户插了话但 agent 没反应时，这是唯一排查依据
    async enqueue(queue, message) {
      queues[queue].push(message);
      await storage.appendRecord(sessionId, record(currentRunId(), { kind: "queue-enqueued", queue, message }));
    },
    drain(queue) {
      return queues[queue].splice(0);
    },
    nonEmpty(queue) {
      return queues[queue].length > 0;
    },
  };
}
