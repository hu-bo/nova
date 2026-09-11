import { createServer, type IncomingHttpHeaders } from "node:http";
import type { ModelConfig } from "../src/index.js";

export interface WireRequest {
  body: any;
  headers: IncomingHttpHeaders;
}
export type Reply = { text?: string; tool?: { name: string; args: unknown }; status?: number; hang?: boolean };
export async function provider(respond: (request: WireRequest, index: number) => Reply | Promise<Reply>) {
  const requests: WireRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = { body: JSON.parse(Buffer.concat(chunks).toString()), headers: req.headers };
    requests.push(request);
    const reply = await respond(request, requests.length - 1);
    if (reply.hang) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      return;
    }
    if (reply.status) {
      res.writeHead(reply.status);
      res.end(JSON.stringify({ error: { type: "api_error", message: "private vendor details" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, data: object) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    if (req.url?.endsWith("/chat/completions")) {
      for (const item of [
        { choices: [{ index: 0, delta: { role: "assistant", content: reply.text ?? "ok" }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ])
        res.write(`data: ${JSON.stringify(item)}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    if (req.url?.endsWith("/responses")) {
      const message = {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: reply.text ?? "ok", annotations: [] }],
      };
      event("response.created", { response: { id: "resp_1", object: "response", status: "in_progress", output: [] } });
      event("response.output_item.added", {
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      });
      event("response.content_part.added", {
        output_index: 0,
        content_index: 0,
        item_id: "msg_1",
        part: { type: "output_text", text: "", annotations: [] },
      });
      event("response.output_text.delta", {
        output_index: 0,
        content_index: 0,
        item_id: "msg_1",
        delta: reply.text ?? "ok",
      });
      event("response.output_item.done", { output_index: 0, item: message });
      event("response.completed", {
        response: {
          id: "resp_1",
          object: "response",
          status: "completed",
          output: [message],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      });
      res.end();
      return;
    }
    event("message_start", {
      message: {
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: request.body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    if (reply.tool) {
      event("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: `call_${requests.length}`, name: reply.tool.name, input: {} },
      });
      event("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.tool.args) },
      });
    } else {
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.text ?? "ok" } });
    }
    event("content_block_stop", { index: 0 });
    event("message_delta", {
      delta: { stop_reason: reply.tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    });
    event("message_stop", {});
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  return {
    requests,
    model: {
      id: "fast",
      protocol: "anthropic",
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKey: "test-secret",
      model: "qwen-test",
      contextWindow: 32768,
      maxOutputTokens: 1024,
    } satisfies ModelConfig,
    async dispose() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
