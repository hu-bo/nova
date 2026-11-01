export interface QueueItem {
  readonly taskId: string;
  readonly sequence: number;
  readonly priority: number;
  readonly readyAt: number;
  readonly acceptedAt: number;
}
export interface TaskQueue {
  readonly maxPending: number;
  put(item: QueueItem): void;
  remove(taskId: string): void;
  candidates(now: number): readonly QueueItem[];
  nextReadyAt(now: number): number | undefined;
  clear(): void;
}
