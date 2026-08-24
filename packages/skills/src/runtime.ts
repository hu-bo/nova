import { Worker } from "node:worker_threads";
import type { CompiledSkill, CompiledSkillAction } from "./compile.js";
import { validationMessage } from "./compile.js";
import type { SkillConnection, SkillResource } from "./schema.js";

export type SkillTrust = "builtin" | "verified" | "untrusted";

export interface SkillHttpRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface SkillHttpResponse {
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}

export interface ResolvedSkillResource {
  mediaType: string;
  data: string;
  encoding: "utf8" | "base64";
}

export interface SkillHost {
  requestHttp(input: {
    skillId: string;
    connection: SkillConnection;
    request: SkillHttpRequest;
    signal: AbortSignal;
  }): Promise<SkillHttpResponse>;
  readResource(input: {
    skillId: string;
    resource: SkillResource;
    signal: AbortSignal;
  }): Promise<ResolvedSkillResource>;
  log?(input: { skillId: string; actionId: string; level: "info"; message: string }): void;
}

export interface SkillActionResult {
  status: "ok" | "error";
  content: string;
  details: unknown;
}

export interface ExecuteSkillActionOptions {
  trust: SkillTrust;
  signal?: AbortSignal;
  maxResultBytes?: number;
}

export type SkillRuntimeErrorCode =
  | "UNTRUSTED_SKILL"
  | "UNKNOWN_ACTION"
  | "INVALID_INPUT"
  | "INVALID_OUTPUT"
  | "CAPABILITY_DENIED"
  | "VM_ERROR"
  | "TIMEOUT"
  | "CANCELLED";

export class SkillRuntimeError extends Error {
  constructor(
    readonly code: SkillRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillRuntimeError";
  }
}

export async function executeSkillAction(
  skill: CompiledSkill,
  actionId: string,
  input: unknown,
  host: SkillHost,
  options: ExecuteSkillActionOptions,
): Promise<SkillActionResult> {
  if (options.trust === "untrusted")
    throw new SkillRuntimeError("UNTRUSTED_SKILL", "untrusted skills cannot execute VM actions");
  const action = skill.actions.get(actionId);
  if (!action) throw new SkillRuntimeError("UNKNOWN_ACTION", `unknown skill action: ${actionId}`);
  if (!action.validateInput(input))
    throw new SkillRuntimeError("INVALID_INPUT", validationMessage(action.validateInput));
  if (options.signal?.aborted) throw new SkillRuntimeError("CANCELLED", "skill action was cancelled");

  const result = await runWorker(skill, action, structuredClone(input), host, options);
  if (action.validateOutput && !action.validateOutput(result.details)) {
    throw new SkillRuntimeError("INVALID_OUTPUT", validationMessage(action.validateOutput));
  }
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > (options.maxResultBytes ?? 1024 * 1024)) {
    throw new SkillRuntimeError("INVALID_OUTPUT", "skill action result exceeds the configured size limit");
  }
  return result;
}

function runWorker(
  skill: CompiledSkill,
  action: CompiledSkillAction,
  input: unknown,
  host: SkillHost,
  options: ExecuteSkillActionOptions,
): Promise<SkillActionResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(VM_WORKER_SOURCE, {
      eval: true,
      workerData: {
        source: action.action.runtime.source,
        input,
        filename: `${skill.document.id}/${action.action.id}.js`,
        timeoutMs: action.action.runtime.timeoutMs,
      },
    });
    const controller = new AbortController();
    let settled = false;

    const finish = (error?: unknown, result?: SkillActionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      controller.abort();
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const onAbort = (): void => finish(new SkillRuntimeError("CANCELLED", "skill action was cancelled"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => finish(new SkillRuntimeError("TIMEOUT", `skill action exceeded ${action.action.runtime.timeoutMs}ms`)),
      action.action.runtime.timeoutMs,
    );

    worker.on("message", (message: unknown) => {
      if (!isRecord(message)) return;
      if (message.type === "result") {
        try {
          finish(undefined, normalizeResult(message.value));
        } catch (error) {
          finish(error);
        }
        return;
      }
      if (message.type === "error") {
        const code = runtimeErrorCode(message.code) ?? "VM_ERROR";
        finish(new SkillRuntimeError(code, stringValue(message.message, "skill VM failed")));
        return;
      }
      if (message.type === "log") {
        const text = stringValue(message.message, "").slice(0, 4096);
        host.log?.({ skillId: skill.document.id, actionId: action.action.id, level: "info", message: text });
        return;
      }
      if (message.type === "call" && typeof message.callId === "number") {
        void handleHostCall(skill, action, host, controller.signal, message)
          .then((value) => post(worker, { type: "call-result", callId: message.callId, ok: true, value }))
          .catch((error) =>
            post(worker, {
              type: "call-result",
              callId: message.callId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              code: error instanceof SkillRuntimeError ? error.code : undefined,
            }),
          );
      }
    });
    worker.on("error", (error) => finish(new SkillRuntimeError("VM_ERROR", error.message)));
    worker.on("exit", (code) => {
      if (!settled)
        finish(new SkillRuntimeError("VM_ERROR", `skill worker exited before returning a result (${code})`));
    });
  });
}

async function handleHostCall(
  skill: CompiledSkill,
  action: CompiledSkillAction,
  host: SkillHost,
  signal: AbortSignal,
  message: Record<string, unknown>,
): Promise<unknown> {
  if (signal.aborted) throw new SkillRuntimeError("CANCELLED", "skill action was cancelled");
  if (message.callType === "http") {
    const payload = recordValue(message.payload, "invalid HTTP request");
    const connectionId = stringValue(payload.connectionId, "");
    if (!action.action.runtime.capabilities.http.includes(connectionId))
      throw denied(`HTTP connection is not allowed: ${connectionId}`);
    const connection = skill.connections.get(connectionId);
    if (!connection) throw denied(`unknown HTTP connection: ${connectionId}`);
    const request = normalizeHttpRequest(payload.request);
    assertHttpAllowed(connection, request);
    return host.requestHttp({ skillId: skill.document.id, connection, request, signal });
  }
  if (message.callType === "resource") {
    const payload = recordValue(message.payload, "invalid resource request");
    const resourceId = stringValue(payload.resourceId, "");
    if (!action.action.runtime.capabilities.resources.includes(resourceId))
      throw denied(`resource is not allowed: ${resourceId}`);
    const resource = skill.resources.get(resourceId);
    if (!resource) throw denied(`unknown resource: ${resourceId}`);
    if (resource.content.kind === "inline") {
      return {
        mediaType: resource.mediaType,
        data: resource.content.data,
        encoding: resource.content.encoding,
      } satisfies ResolvedSkillResource;
    }
    return host.readResource({ skillId: skill.document.id, resource, signal });
  }
  throw denied(`unknown host capability: ${String(message.callType)}`);
}

function normalizeHttpRequest(value: unknown): SkillHttpRequest {
  const request = recordValue(value, "HTTP request must be an object");
  const result: SkillHttpRequest = {
    method: stringValue(request.method, "").toUpperCase(),
    path: stringValue(request.path, ""),
  };
  if (request.query !== undefined) result.query = stringRecord(request.query, "query");
  if (request.headers !== undefined) result.headers = stringRecord(request.headers, "headers");
  if (request.body !== undefined) result.body = request.body;
  return result;
}

function assertHttpAllowed(connection: SkillConnection, request: SkillHttpRequest): void {
  if (!connection.allowedMethods.includes(request.method as SkillConnection["allowedMethods"][number])) {
    throw denied(`HTTP method is not allowed: ${request.method}`);
  }
  if (!request.path.startsWith("/")) throw denied("HTTP path must be absolute within the configured origin");
  const base = new URL(connection.baseUrl);
  const target = new URL(request.path, base);
  if (target.origin !== base.origin) throw denied("HTTP request cannot change the configured origin");
  const allowed = connection.allowedPathPrefixes.some(
    (prefix) => target.pathname === prefix || target.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
  );
  if (!allowed) throw denied(`HTTP path is not allowed: ${target.pathname}`);
  for (const name of Object.keys(request.headers ?? {})) {
    if (["authorization", "cookie", "host", "proxy-authorization"].includes(name.toLowerCase())) {
      throw denied(`HTTP header is managed by the host: ${name}`);
    }
  }
}

function normalizeResult(value: unknown): SkillActionResult {
  const result = recordValue(value, "skill action must return an object");
  const status = result.status ?? "ok";
  if (status !== "ok" && status !== "error")
    throw new SkillRuntimeError("INVALID_OUTPUT", "status must be ok or error");
  if (typeof result.content !== "string") throw new SkillRuntimeError("INVALID_OUTPUT", "content must be a string");
  return { status, content: result.content, details: result.details ?? null };
}

function runtimeErrorCode(value: unknown): SkillRuntimeErrorCode | undefined {
  return [
    "UNTRUSTED_SKILL",
    "UNKNOWN_ACTION",
    "INVALID_INPUT",
    "INVALID_OUTPUT",
    "CAPABILITY_DENIED",
    "VM_ERROR",
    "TIMEOUT",
    "CANCELLED",
  ].includes(String(value))
    ? (value as SkillRuntimeErrorCode)
    : undefined;
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  const input = recordValue(value, `${field} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== "string") throw new SkillRuntimeError("CAPABILITY_DENIED", `${field}.${key} must be a string`);
    result[key] = item;
  }
  return result;
}

function denied(message: string): SkillRuntimeError {
  return new SkillRuntimeError("CAPABILITY_DENIED", message);
}

function recordValue(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SkillRuntimeError("CAPABILITY_DENIED", message);
  return value;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function post(worker: Worker, message: unknown): void {
  try {
    worker.postMessage(message);
  } catch {
    /* worker already terminated */
  }
}

const VM_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
let nextCallId = 1;
const pending = new Map();

function callHost(callType, payload) {
  const callId = nextCallId++;
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    parentPort.postMessage({ type: "call", callId, callType, payload });
  });
}

parentPort.on("message", message => {
  if (!message || message.type !== "call-result") return;
  const call = pending.get(message.callId);
  if (!call) return;
  pending.delete(message.callId);
  if (message.ok) call.resolve(message.value);
  else {
    const error = new Error(String(message.error || "host call failed"));
    error.code = message.code;
    call.reject(error);
  }
});

const sdk = Object.freeze({
  http: Object.freeze({
    request: (connectionId, request) => callHost("http", { connectionId, request })
  }),
  resources: Object.freeze({
    read: resourceId => callHost("resource", { resourceId })
  }),
  log: Object.freeze({
    info: message => parentPort.postMessage({ type: "log", message: String(message) })
  })
});

const context = vm.createContext(
  { __input: workerData.input, __sdk: sdk },
  { codeGeneration: { strings: false, wasm: false } }
);

try {
  const script = new vm.Script(
    "Promise.resolve((" + workerData.source + ")({ input: __input, sdk: __sdk }))",
    { filename: workerData.filename }
  );
  const result = script.runInContext(context, { timeout: workerData.timeoutMs });
  Promise.resolve(result).then(
    value => parentPort.postMessage({ type: "result", value }),
    error => parentPort.postMessage({ type: "error", message: error && error.message ? error.message : String(error), code: error && error.code })
  );
} catch (error) {
  parentPort.postMessage({ type: "error", message: error && error.message ? error.message : String(error), code: error && error.code });
}
`;
