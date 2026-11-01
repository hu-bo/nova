import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import {
  decodeRunnerEnvelope,
  encodeServerEnvelope,
  RUNNER_PROTOCOL_VERSION,
} from "@nova/runner-protocol";
import { messageBytes } from "./errors.js";
import { parseIdentity, RunnerSessionImpl } from "./session.js";
import type {
  RunnerSdk,
  RunnerSdkOptions,
  RunnerSession,
  RunnerSessionCandidate,
  RunnerIdentity,
} from "./types.js";

const DEFAULT_PATH = "/runner/v1/connect";
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 30_000;

export function createRunnerSdk(options: RunnerSdkOptions = {}): RunnerSdk {
  const ownServer = options.server ? null : createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const httpServer = options.server ?? ownServer!;
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  const path = options.path ?? DEFAULT_PATH;
  const sessions = new Map<string, RunnerSessionImpl>();
  let listener: ((candidate: RunnerSessionCandidate) => void | Promise<void>) | undefined;
  let listening = false;
  let closed = false;

  const diagnostic = (code: string) => {
    try { options.onDiagnostic?.({ code }); } catch { /* Diagnostic callbacks cannot break transport handling. */ }
  };
  const endpoint = () => {
    if (!httpServer.listening) return `ws://${endpointHost(options.host ?? "127.0.0.1")}:${options.port ?? 0}${path}`;
    const address = httpServer.address();
    if (!address || typeof address === "string") return `ws://${endpointHost(options.host ?? "127.0.0.1")}:0${path}`;
    const host = endpointHost(options.host ?? (address.address === "::" ? "::1" : address.address));
    return `ws://${host}:${address.port}${path}`;
  };

  httpServer.on("upgrade", (request, socket, head) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://localhost"); }
    catch { socket.destroy(); return; }
    if (closed || url.pathname !== path) { socket.destroy(); return; }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      websocketServer.emit("connection", client, request);
    });
  });

  websocketServer.on("connection", (socket, request) => {
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!token) { socket.close(1008, "Credentials required"); return; }
    let accepted = false;
    const timeout = setTimeout(() => {
      if (!accepted) socket.close(1008, "Session admission timed out");
    }, options.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS);
    timeout.unref();
    const reject = (code: string, message: string) => {
      if (accepted || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(encodeServerEnvelope({ requestId: randomUUID(), rejection: { code, message } }), { binary: true }, () => {
          socket.close(1008, "Connection not admitted");
        });
      } catch { socket.close(1008, "Connection not admitted"); }
    };
    const firstMessage = (frame: WebSocket.RawData, binary: boolean) => {
      socket.off("message", firstMessage);
      if (!binary) { reject("INVALID", "Binary Protobuf is required."); return; }
      let identity: RunnerIdentity;
      try {
        const envelope = decodeRunnerEnvelope(messageBytes(frame));
        if (envelope.payload !== "hello") throw new TypeError("Runner Hello is required");
        identity = parseIdentity(envelope.hello);
        if (identity.protocolVersion !== RUNNER_PROTOCOL_VERSION) throw new TypeError("Unsupported Runner protocol version");
      } catch {
        diagnostic("RUNNER_INVALID_HELLO");
        reject("INVALID", "Runner handshake is invalid or unsupported.");
        return;
      }
      const currentListener = listener;
      if (!currentListener) { reject("UNAVAILABLE", "No Session admission callback is registered."); return; }
      const candidate: RunnerSessionCandidate = {
        identity,
        token,
        accept: async ({ principalId }) => {
          if (accepted || socket.readyState !== WebSocket.OPEN) throw new Error("Runner candidate is no longer available");
          if (!principalId || principalId.trim() !== principalId) throw new TypeError("principalId must be a non-empty stable identifier");
          const key = sessionKey(principalId, identity);
          for (const [oldKey, oldSession] of sessions) {
            if (oldSession.principalId !== principalId || oldSession.identity.runnerId !== identity.runnerId || oldSession.bootId === identity.bootId) continue;
            oldSession.runnerRestarted(identity.bootId);
            sessions.delete(oldKey);
          }
          const prior = sessions.get(key);
          if (prior && !sameIdentity(prior.identity, identity)) throw new TypeError("Runner identity changed within a boot session");
          const session = prior ?? new RunnerSessionImpl(identity, principalId, ({ code }) => diagnostic(code));
          const epoch = randomUUID();
          session.attach(socket, epoch, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS);
          if (!prior) sessions.set(key, session);
          accepted = true;
          clearTimeout(timeout);
          return session;
        },
        reject,
      };
      void Promise.resolve().then(() => currentListener(candidate)).catch(() => {
        diagnostic("RUNNER_ADMISSION_CALLBACK_FAILED");
        reject("DENIED", "Runner Session admission failed.");
      });
    };
    socket.on("message", firstMessage);
    socket.on("close", () => clearTimeout(timeout));
  });

  return {
    get endpoint() { return endpoint(); },
    async listen() {
      if (closed) throw new Error("Runner SDK is closed");
      if (listening || httpServer.listening) { listening = true; return; }
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { httpServer.off("listening", onListening); reject(error); };
        const onListening = () => { httpServer.off("error", onError); resolve(); };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(options.port ?? 0, options.host ?? "127.0.0.1");
      });
      listening = true;
    },
    onSession(nextListener) {
      if (listener) throw new Error("Only one Runner Session admission callback may be registered");
      listener = nextListener;
      return () => { if (listener === nextListener) listener = undefined; };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const session of sessions.values()) await session.close();
      sessions.clear();
      websocketServer.close();
      if (ownServer?.listening) await new Promise<void>((resolve) => ownServer.close(() => resolve()));
    },
  };
}

function sessionKey(principalId: string, identity: RunnerIdentity): string {
  return JSON.stringify([principalId, identity.runnerId, identity.bootId]);
}

function sameIdentity(left: RunnerIdentity, right: RunnerIdentity): boolean {
  return left.runnerId === right.runnerId && left.bootId === right.bootId &&
    left.protocolVersion === right.protocolVersion &&
    left.version === right.version && left.platform === right.platform &&
    left.maxConcurrency === right.maxConcurrency &&
    JSON.stringify(left.workspaces) === JSON.stringify(right.workspaces) &&
    JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities);
}

function endpointHost(value: string): string {
  if (value === "0.0.0.0") return "127.0.0.1";
  if (value === "::") return "[::1]";
  if (value.includes(":") && !value.startsWith("[")) return `[${value}]`;
  return value;
}
