import { afterEach, expect, it, vi } from "vitest";
import { createModel } from "./index.js";
import type { ModelEvent, ModelRef } from "./types.js";

afterEach(() => vi.unstubAllGlobals());

it.each(["chat-completions", "responses", "anthropic"] as const)(
  "serializes image bytes in %s requests",
  async (api) => {
    const ref: ModelRef = {
      provider: api === "anthropic" ? "anthropic" : "openai",
      model: "vision",
      apiKey: "test",
      inputModalities: ["text", "image"],
      ...(api === "anthropic" ? {} : { wireApi: api }),
    };
    const terminal =
      api === "anthropic"
        ? { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }
        : api === "responses"
          ? { type: "response.completed", response: {} }
          : { choices: [{ delta: {}, finish_reason: "stop" }] };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          `data: ${JSON.stringify(terminal)}\n\n${api === "anthropic" ? 'data: {"type":"message_stop"}\n\n' : ""}`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const events: ModelEvent[] = [];
    for await (const event of createModel(ref).stream(
      {
        system: "",
        tools: [],
        messages: [
          {
            id: "m1",
            role: "user",
            createdAt: 0,
            blocks: [
              { type: "text", text: "describe" },
              { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
            ],
          },
        ],
      },
      new AbortController().signal,
    ))
      events.push(event);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    const content = api === "responses" ? sent.input[0].content : sent.messages[0].content;
    expect(content[1]).toEqual(
      api === "anthropic"
        ? { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }
        : api === "responses"
          ? { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }
          : { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
    );
    expect(events.at(-1)).toMatchObject({ type: "finish", stopReason: "stop" });
  },
);
