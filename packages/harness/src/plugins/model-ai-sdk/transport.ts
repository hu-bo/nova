import { createHash } from "node:crypto";
import { FrameworkError } from "../../contracts/errors.js";

export interface AiSdkModelLogger {
  child(bindings: Record<string, unknown>): AiSdkModelLogger;
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface AiSdkModelOptions {
  fetch?: typeof globalThis.fetch;
  resolveImageUrl?: (uri: string) => Promise<string>;
  logger?: AiSdkModelLogger;
  requestTimeoutMs?: number;
}

/** Observe HTTP without exposing request text, credentials, query parameters or provider error bodies. */
export function modelTransport(
  options: AiSdkModelOptions,
  log: AiSdkModelLogger | undefined,
  startedAt: number,
  diagnostics: { readChunks: number; responseBytes: number; reachedEof: boolean },
): typeof globalThis.fetch {
  return async (input, init) => {
    const endpoint = new URL(input instanceof Request ? input.url : String(input));
    const serialized = typeof init?.body === "string" ? init.body : "";
    const requestLog = log?.child({
      providerOrigin: endpoint.origin,
      providerPath: endpoint.pathname,
      requestBytes: Buffer.byteLength(serialized),
      requestHash: createHash("sha256").update(serialized).digest("hex"),
    });
    requestLog?.info({}, "Model request started");
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(input, { ...init, redirect: "error" });
    } catch {
      throw new FrameworkError("MODEL_TRANSPORT", "Model transport failed.");
    }
    requestLog?.info(
      {
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
        contentEncoding: response.headers.get("content-encoding"),
        upstreamRequestId: (response.headers.get("x-request-id") ?? response.headers.get("request-id"))?.slice(0, 200),
        elapsedMs: Date.now() - startedAt,
      },
      "Model response received",
    );
    // Let the SDK classify HTTP errors, while discarding sensitive provider response text.
    if (!response.ok) {
      await response.body?.cancel();
      return new Response("", { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    if (!response.body) throw new FrameworkError("MODEL_PROTOCOL", "Model response has no stream.");
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          diagnostics.readChunks++;
          diagnostics.responseBytes += chunk.byteLength;
          if (diagnostics.responseBytes > 8 * 1024 * 1024)
            throw new FrameworkError("MODEL_OUTPUT_LIMIT", "Model output exceeded its limit.");
          controller.enqueue(chunk);
        },
        flush() {
          diagnostics.reachedEof = true;
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
