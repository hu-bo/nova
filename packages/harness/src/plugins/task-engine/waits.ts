import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "../../contracts/message.js";
import type { TaskSignal, WaitDefinition, SignalReceipt } from "../../contracts/continuation.js";
import { FrameworkError } from "../../contracts/errors.js";
import { jsonValue } from "../../shared/json.js";
interface WaitRecord {
  taskId: string;
  namespace: string;
  definition: WaitDefinition;
  signal?: TaskSignal;
  consumed: boolean;
  state?: JsonValue;
}
export class WaitRegistry {
  private readonly waits = new Map<string, WaitRecord>();
  constructor(
    private readonly capacity: number,
    private readonly wake: (taskId: string) => void,
  ) {}
  create(taskId: string, namespace: string, definition: WaitDefinition): string {
    if (!Number.isFinite(definition.expiresAt) || definition.expiresAt <= Date.now())
      throw new FrameworkError("INVALID_WAIT", "Wait expiry must be in the future.");
    if ([...this.waits.values()].some((wait) => wait.taskId === taskId && !wait.consumed))
      throw new FrameworkError("INVALID_WAIT", "A task may have only one active wait.");
    if (this.waits.size >= this.capacity) throw new FrameworkError("WAIT_LIMIT", "Wait capacity reached.");
    const id = randomUUID();
    this.waits.set(id, { taskId, namespace, definition, consumed: false });
    return id;
  }
  suspend(taskId: string, waitId: string, state: JsonValue): number {
    const wait = this.waits.get(waitId);
    if (!wait || wait.taskId !== taskId || wait.consumed)
      throw new FrameworkError("INVALID_WAIT", "Wait was not preregistered.");
    wait.state = jsonValue(state);
    if (wait.signal) this.wake(taskId);
    return wait.definition.expiresAt;
  }
  expires(taskId: string, waitId: string): number {
    const wait = this.waits.get(waitId);
    if (!wait || wait.taskId !== taskId || wait.consumed)
      throw new FrameworkError("INVALID_WAIT", "Wait was not preregistered.");
    return wait.definition.expiresAt;
  }
  signal(input: TaskSignal): SignalReceipt {
    if (
      typeof input.taskId !== "string" ||
      !input.taskId ||
      typeof input.waitId !== "string" ||
      !input.waitId ||
      typeof input.eventId !== "string" ||
      !input.eventId
    )
      throw new FrameworkError("INVALID_SIGNAL", "Signal identity is invalid.");
    const wait = this.waits.get(input.waitId);
    if (
      !wait ||
      wait.taskId !== input.taskId ||
      (input.namespace ?? "local") !== wait.namespace ||
      wait.definition.expiresAt <= Date.now()
    )
      return { status: "ignored" };
    if (wait.consumed || wait.signal) return { status: "duplicate" };
    let payload: JsonValue;
    try {
      payload = jsonValue(input.payload);
    } catch {
      throw new FrameworkError("INVALID_SIGNAL", "Signal payload is invalid.");
    }
    let validated = payload;
    if (wait.definition.inputSchema) {
      try {
        const parsed = jsonValue(wait.definition.inputSchema.parse(payload));
        if (!isDeepStrictEqual(parsed, payload))
          throw new FrameworkError("INVALID_SIGNAL", "Signal payload must not be coerced or defaulted.");
        validated = parsed;
      } catch (error) {
        if (error instanceof FrameworkError) throw error;
        throw new FrameworkError("INVALID_SIGNAL", "Signal payload is invalid.");
      }
    }
    wait.signal = {
      ...input,
      payload: validated,
    };
    if (wait.state !== undefined) this.wake(input.taskId);
    return { status: "accepted" };
  }
  take(taskId: string): { state: JsonValue; signal: TaskSignal } | undefined {
    for (const wait of this.waits.values())
      if (wait.taskId === taskId && wait.signal && wait.state !== undefined && !wait.consumed) {
        wait.consumed = true;
        return { state: wait.state, signal: wait.signal };
      }
    return undefined;
  }
  expiry(taskId: string): number | undefined {
    return [...this.waits.values()]
      .filter((wait) => wait.taskId === taskId && !wait.consumed)
      .reduce<
        number | undefined
      >((minimum, wait) => Math.min(minimum ?? Infinity, wait.definition.expiresAt), undefined);
  }
  clear(taskId: string): void {
    for (const [id, wait] of this.waits) if (wait.taskId === taskId) this.waits.delete(id);
  }
}
