// gRPC Connect 入口与 session 生命周期（docs/runner-sdk.md §2/§3/§8）。
// Runner 始终是建连方：SDK 在 127.0.0.1 随机端口起 h2c listener，
// Runner 进程出站连入。没有入站执行端口，没有第二条执行路径。
import { randomUUID } from "node:crypto";
import { createServer, type Http2Server } from "node:http2";
import type { Socket } from "node:net";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { create } from "@bufbuild/protobuf";
import { AcceptedSchema, RunnerConnection, ServerEnvelopeSchema } from "./gen/runner_pb.js";
import type { Register, RunnerEnvelope } from "./gen/runner_pb.js";
import {
  BoundedQueue,
  RunnerSessionImpl,
  ended,
  type RunnerIdentity,
  type RunnerSession,
  type ServerEnvelopeInit,
} from "./session.js";
import { runnerUnavailable } from "./errors.js";

// The runner shares one bounded outbound stream for heartbeats and work data. Allow a
// transient proxy/backpressure delay without declaring the whole session stale.
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 30_000;
const OUTBOUND_CAPACITY = 64; // server→runner 发送缓冲上限，满则背压到 handleEnvelope

export interface RunnerSdkOptions {
  heartbeatIntervalMs?: number; // 发给 Runner 的心跳周期，缺省 5000
  // Register 后等待 Runner Module 接纳的上限，避免未装配或异常的控制面挂住 gRPC 流。
  admissionTimeoutMs?: number;
  host?: string;
  port?: number;
}

export interface RunnerSessionCandidate {
  readonly identity: RunnerIdentity;
  readonly token: string;
  accept(): RunnerSession;
  reject(code: string, message: string): Promise<void>;
}

export interface RunnerSdk {
  // listen() 之后才有值；格式 http://127.0.0.1:<port>，供 Runner --server 使用
  readonly endpoint: string;
  listen(): Promise<void>;
  onSession(listener: (candidate: RunnerSessionCandidate) => void): () => void;
  close(): Promise<void>;
}

export function createRunnerSdk(options: RunnerSdkOptions = {}): RunnerSdk {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const admissionTimeoutMs = options.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (!Number.isFinite(admissionTimeoutMs) || admissionTimeoutMs <= 0) {
    throw new RangeError("admissionTimeoutMs must be a positive finite number");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError("port must be between 0 and 65535");

  // Session 接纳有唯一 owner（Runner Module）。观察者应由该 Module 自己暴露，避免
  // 多个 listener 竞争 accept()/reject()，把连接归属变成时序问题。
  let sessionListener: ((candidate: RunnerSessionCandidate) => void) | null = null;
  const sessions = new Set<RunnerSessionImpl>();
  const sockets = new Set<Socket>();
  const admissions = new Set<{ reject(code: string, message: string): void }>();
  let server: Http2Server | null = null;
  let listening: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let endpoint = "";

  const connectHandler = async function* (
    requests: AsyncIterable<RunnerEnvelope>,
    context: HandlerContext,
  ): AsyncIterable<ServerEnvelopeInit> {
    const token = bearerToken(context.requestHeader);
    if (!token) throw new ConnectError("runner token is required", Code.Unauthenticated);
    // 1. 首帧必须是 Register，否则拒绝连接
    const iterator = requests[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done === true || first.value.payload.case !== "register") {
      throw new ConnectError("first envelope must be Register", Code.InvalidArgument);
    }
    const register: Register = first.value.payload.value;

    // 2. 接纳决策交给唯一的 Runner Module owner。
    const outbound = new BoundedQueue<ServerEnvelopeInit>(OUTBOUND_CAPACITY);
    type Decision =
      { kind: "accepted"; session: RunnerSessionImpl } | { kind: "rejected"; code: string; message: string };
    let decide!: (decision: Decision) => void;
    const decided = new Promise<Decision>((resolve) => {
      decide = resolve;
    });
    let settled = false;
    const settle = (decision: Decision): boolean => {
      if (settled) return false;
      settled = true;
      decide(decision);
      return true;
    };
    const admission = {
      reject(code: string, message: string) {
        settle({ kind: "rejected", code, message });
      },
    };
    const candidate: RunnerSessionCandidate = {
      identity: register,
      token,
      accept() {
        const session = new RunnerSessionImpl(register, `runner-session-${randomUUID()}`, outbound);
        if (!settle({ kind: "accepted", session })) throw new Error("candidate already settled");
        return session;
      },
      async reject(code: string, message: string) {
        admission.reject(code, message);
      },
    };
    admissions.add(admission);
    const timer = setTimeout(() => {
      admission.reject("ADMISSION_TIMEOUT", "runner admission timed out");
    }, admissionTimeoutMs);
    if (sessionListener === null) {
      admission.reject("UNAVAILABLE", "runner session handler is not registered");
    } else {
      try {
        sessionListener(candidate);
      } catch {
        admission.reject("INTERNAL", "runner session handler failed");
      }
    }
    const decision = await decided.finally(() => {
      clearTimeout(timer);
      admissions.delete(admission);
    });
    if (decision.kind === "rejected") {
      throw new ConnectError(`${decision.code}: ${decision.message}`, Code.Unauthenticated);
    }
    const accepted = decision.session;
    sessions.add(accepted);

    // 3. 回复 Accepted，之后双向泵送
    yield {
      requestId: first.value.requestId,
      payload: {
        case: "accepted",
        value: create(AcceptedSchema, {
          heartbeatIntervalMs,
          generation: accepted.generation,
        }),
      },
    };

    // 入站泵：Runner → SDK。handleEnvelope 的 push 挂起 = 背压直达 Runner
    const pump = (async () => {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) break;
          await accepted.handleEnvelope(next.value);
        }
      } catch {
        // 传输错误与正常结束同样处理：会话失效，不重放任何请求
      }
      accepted.failTransport(runnerUnavailable());
    })();

    try {
      // 出站泵：SDK → Runner，经同一个 generator 交给 connect
      for (;;) {
        const item = await outbound.shift();
        if (item === ended) break;
        yield item;
      }
    } finally {
      accepted.failTransport(runnerUnavailable()); // 幂等
      sessions.delete(accepted);
      void pump; // 响应结束后 Runner 会关闭连接，入站泵随之退出
    }
  };

  // h2c prior-knowledge：tonic 客户端用 http:// 连入，Node http2 明文服务直接承接
  const handler = connectNodeAdapter({
    routes(router: ConnectRouter) {
      router.service(RunnerConnection, { connect: connectHandler });
    },
  });

  return {
    get endpoint() {
      return endpoint;
    },

    async listen() {
      if (closing !== null) await closing;
      if (listening !== null) return listening;
      if (server !== null) return;

      const httpServer = createServer(handler);
      server = httpServer; // 在 await 前发布，close() 才能收敛启动中的 listener
      httpServer.on("connection", (socket: Socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      const start = (async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            httpServer.once("error", onError);
            httpServer.listen(port, host, () => {
              httpServer.off("error", onError);
              resolve();
            });
          });
          const address = httpServer.address();
          if (address === null || typeof address === "string") {
            throw new Error("listener has no bound address");
          }
          const advertisedHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
          endpoint = `http://${advertisedHost}:${address.port}`;
        } catch (error) {
          if (server === httpServer) server = null;
          endpoint = "";
          throw error;
        }
      })();
      listening = start;
      try {
        await start;
      } finally {
        if (listening === start) listening = null;
      }
    },

    onSession(listener) {
      if (sessionListener !== null) throw new Error("runner session handler is already registered");
      sessionListener = listener;
      return () => {
        if (sessionListener === listener) sessionListener = null;
      };
    },

    async close() {
      if (closing !== null) return closing;
      const close = (async () => {
        await listening?.catch(() => undefined);
        for (const admission of admissions) admission.reject("UNAVAILABLE", "sdk closed");
        admissions.clear();
        for (const session of sessions) session.failTransport(runnerUnavailable("sdk closed"));
        sessions.clear();
        const httpServer = server;
        server = null;
        endpoint = "";
        if (httpServer === null) return;
        const closed = new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        await closed;
      })();
      closing = close;
      try {
        await close;
      } finally {
        if (closing === close) closing = null;
      }
    },
  };
}

function bearerToken(headers: Headers): string | null {
  const value = headers.get("authorization");
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
