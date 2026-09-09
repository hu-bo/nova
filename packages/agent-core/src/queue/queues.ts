// §7 三条队列 —— 消息缓冲，保留多模态内容，出队只看 turn 边界。
// 不 import taskflow（那边元素是 Task，出队条件是依赖+额度，仅同名）。
import type { ContentPart, QueueName } from "../types.js";
import { record } from "../session/record.js";
import type { SessionStorage } from "../session/storage.js";

export interface Queues {
  enqueue(queue: QueueName, message: string | ContentPart[]): Promise<void>;
  drain(queue: QueueName): ContentPart[];
  nonEmpty(queue: QueueName): boolean;
}

export function createQueues(sessionId: string, storage: SessionStorage, currentRunId: () => string): Queues {
  const queues: { [K in QueueName]: ContentPart[][] } = { steering: [], followUp: [], nextRun: [] };
  return {
    // 入队必须落 queue-enqueued Record：用户插了话但 agent 没反应时，这是唯一排查依据
    async enqueue(queue, message) {
      const parts: ContentPart[] =
        typeof message === "string" ? [{ type: "text", text: message }] : structuredClone(message);
      queues[queue].push(parts);
      const summary = parts.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
      await storage.appendRecord(
        sessionId,
        record(currentRunId(), { kind: "queue-enqueued", queue, message: summary }),
      );
    },
    drain(queue) {
      return queues[queue]
        .splice(0)
        .flatMap((parts, index): ContentPart[] => (index === 0 ? parts : [{ type: "text", text: "\n\n" }, ...parts]));
    },
    nonEmpty(queue) {
      return queues[queue].length > 0;
    },
  };
}
