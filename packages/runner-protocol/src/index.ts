import protobuf from "protobufjs";
import { createHash } from "node:crypto";
import schema from "./generated.json" with { type: "json" };

const root = protobuf.Root.fromJSON(schema);
const runnerEnvelope = root.lookupType("nova.runner.v1.RunnerEnvelope");
const serverEnvelope = root.lookupType("nova.runner.v1.ServerEnvelope");
const operationType = root.lookupType("nova.runner.v1.Operation");
const executionEventType = root.lookupType("nova.execution.v1.ExecutionEvent");
export const RUNNER_PROTOCOL_VERSION = 2;

export type RunnerEnvelope = Record<string, unknown>;
export type ServerEnvelope = Record<string, unknown>;
export type ExecutionEvent = Record<string, unknown>;
export interface RemoteOperation {
  operationId: string;
  targetBootId: string;
  workspaceId: string;
  paramsSha256?: Uint8Array;
  protocolVersion: number;
  expiresAtUnixMs: string | bigint | number;
  timeoutMs: number;
  params:
    | { kind: "listFiles"; path?: string; depth?: number; maxEntries?: number }
    | { kind: "readFile"; path?: string; offset?: string | bigint | number; maxBytes?: number }
    | { kind: "readText"; path?: string; offset?: string | bigint | number; limit?: number; maxBytes?: number }
    | { kind: "search"; query?: string; path?: string; glob?: string; maxResults?: number }
    | { kind: "writeFile"; path?: string; contents?: Uint8Array; expectedSha256?: string }
    | { kind: "applyPatch"; path?: string; edits?: readonly { oldText: string; newText: string }[]; expectedSha256?: string }
    | {
        kind: "executeCommand";
        executable?: string;
        args?: readonly string[];
        cwd?: string;
        env?: Readonly<Record<string, string>>;
        timeoutMs?: number;
        stdin?: Uint8Array;
      };
}
export interface RunnerFailure {
  readonly code: string;
  readonly message: string;
  readonly outcome: "known" | "unknown";
  readonly operationId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function encodeExecutionEvent(message: ExecutionEvent): Uint8Array {
  const converted = executionEventType.fromObject(message);
  const error = executionEventType.verify(converted);
  if (error) throw new TypeError(`Invalid ExecutionEvent: ${error}`);
  return executionEventType.encode(converted).finish();
}

export function decodeExecutionEvent(bytes: Uint8Array): ExecutionEvent {
  return executionEventType.toObject(executionEventType.decode(bytes), {
    longs: String,
    enums: String,
    bytes: Uint8Array,
    defaults: false,
    oneofs: true,
  }) as ExecutionEvent;
}

export function encodeRunnerEnvelope(message: RunnerEnvelope): Uint8Array {
  const converted = runnerEnvelope.fromObject(message);
  const error = runnerEnvelope.verify(converted);
  if (error) throw new TypeError(`Invalid RunnerEnvelope: ${error}`);
  return runnerEnvelope.encode(converted).finish();
}

export function decodeServerEnvelope(bytes: Uint8Array): ServerEnvelope {
  return serverEnvelope.toObject(serverEnvelope.decode(bytes), {
    longs: String,
    enums: String,
    bytes: Uint8Array,
    defaults: false,
    oneofs: true,
  }) as ServerEnvelope;
}

export function encodeServerEnvelope(message: ServerEnvelope): Uint8Array {
  const converted = serverEnvelope.fromObject(message);
  const error = serverEnvelope.verify(converted);
  if (error) throw new TypeError(`Invalid ServerEnvelope: ${error}`);
  return serverEnvelope.encode(converted).finish();
}

export function decodeRunnerEnvelope(bytes: Uint8Array): RunnerEnvelope {
  return runnerEnvelope.toObject(runnerEnvelope.decode(bytes), {
    longs: String,
    enums: String,
    bytes: Uint8Array,
    defaults: true,
    oneofs: true,
  }) as RunnerEnvelope;
}

export function operationParamsSha256(operation: Record<string, unknown>): Buffer {
  const converted = operationType.fromObject(operation);
  const error = operationType.verify(converted);
  if (error) throw new TypeError(`Invalid Operation: ${error}`);
  const value = operationType.toObject(converted, {
    longs: String,
    enums: String,
    bytes: Uint8Array,
    defaults: true,
    arrays: true,
    objects: true,
    oneofs: true,
  }) as Record<string, unknown>;
  const kind = value.params;
  const params = typeof kind === "string" ? value[kind] : undefined;
  if (typeof kind !== "string" || !isRecord(params)) throw new TypeError("Invalid Operation: params is required");

  // Hash the fields as a fixed JSON tuple, rather than serialized Protobuf bytes.
  // Protobuf permits multiple valid byte representations, including map ordering.
  const canonical = [
    value.operationId,
    value.targetBootId,
    value.workspaceId,
    value.protocolVersion,
    uint64Decimal(value.expiresAtUnixMs),
    value.timeoutMs,
    canonicalParams(kind, params),
  ];
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest();
}

function canonicalParams(kind: string, params: Record<string, unknown>): unknown[] {
  const bytes = (value: unknown) => Array.from(value instanceof Uint8Array ? value : []);
  switch (kind) {
    case "listFiles":
      return [kind, params.path, params.depth, params.maxEntries];
    case "readFile":
      return [kind, params.path, uint64Decimal(params.offset), params.maxBytes];
    case "readText":
      return [kind, params.path, uint64Decimal(params.offset), params.limit, params.maxBytes];
    case "search":
      return [kind, params.query, params.path, params.glob, params.maxResults];
    case "writeFile":
      return [kind, params.path, bytes(params.contents), params.expectedSha256];
    case "applyPatch":
      return [
        kind,
        params.path,
        (Array.isArray(params.edits) ? params.edits : []).map((item) => {
          if (!isRecord(item)) throw new TypeError("Invalid Operation: text edit is invalid");
          return [item.oldText, item.newText];
        }),
        params.expectedSha256,
      ];
    case "executeCommand": {
      const env = isRecord(params.env) ? params.env : {};
      const entries = Object.entries(env).sort(([left], [right]) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
      );
      return [kind, params.executable, params.args, params.cwd, entries, params.timeoutMs, bytes(params.stdin)];
    }
    default:
      throw new TypeError("Invalid Operation: unknown params");
  }
}

function uint64Decimal(value: unknown): string {
  const converted = typeof value === "object" && value !== null && "toString" in value
    ? value.toString()
    : String(value);
  if (!/^(0|[1-9]\d*)$/.test(converted) || BigInt(converted) > 18_446_744_073_709_551_615n)
    throw new TypeError("Invalid Operation: uint64 is out of range");
  return converted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
