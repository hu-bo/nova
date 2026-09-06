import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearch } from "./web-search.js";

const apiKey = "tvly-test-secret";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("web_search", () => {
  it("sends bounded defaults and returns compact sources with complete details", async () => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = input;
      requestInit = init;
      return response({
        query: "latest Nova release",
        results: [
          {
            title: "Nova release notes",
            url: "https://example.com/nova",
            content: "Nova shipped a new release.",
            score: 0.91,
          },
        ],
        response_time: "1.25",
        request_id: "request-1",
        usage: { credits: 1 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = createWebSearch({ apiKey });

    const result = await tool.execute(tool.schema.parse({ query: " latest Nova release " }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestUrl).toBe("https://api.tavily.com/search");
    expect(requestInit?.headers).toMatchObject({
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      query: "latest Nova release",
      topic: "general",
      search_depth: "basic",
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      auto_parameters: false,
      safe_search: true,
      include_usage: true,
      chunks_per_source: 2,
    });
    expect(result.status).toBe("ok");
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("URL: https://example.com/nova"),
    });
    expect(result.details).toEqual({
      query: "latest Nova release",
      results: [
        {
          title: "Nova release notes",
          url: "https://example.com/nova",
          content: "Nova shipped a new release.",
          score: 0.91,
        },
      ],
      responseTime: 1.25,
      requestId: "request-1",
      credits: 1,
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("maps optional search controls to Tavily parameters", async () => {
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return response({ query: "markets", results: [], response_time: 0.5, usage: { credits: 2 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = createWebSearch({ apiKey });

    const result = await tool.execute(
      tool.schema.parse({
        query: "markets",
        topic: "finance",
        searchDepth: "advanced",
        timeRange: "week",
        maxResults: 8,
        includeDomains: ["reuters.com"],
        excludeDomains: ["example.com"],
      }),
    );

    const body = JSON.parse(String(requestInit?.body));
    expect(body).toMatchObject({
      topic: "finance",
      search_depth: "advanced",
      time_range: "week",
      max_results: 8,
      include_domains: ["reuters.com"],
      exclude_domains: ["example.com"],
    });
    expect(result.status).toBe("ok");
    expect(result.content).toEqual([{ type: "text", text: "No web search results found for: markets" }]);
  });

  it("rejects invalid tool arguments through the canonical schema", () => {
    const tool = createWebSearch({ apiKey });

    expect(tool.schema.safeParse({ query: " " }).success).toBe(false);
    expect(tool.schema.safeParse({ query: "x", maxResults: 11 }).success).toBe(false);
    expect(tool.schema.safeParse({ query: "x", includeDomains: Array(11).fill("example.com") }).success).toBe(false);
  });

  it.each([
    [400, "INVALID_REQUEST", false],
    [401, "AUTHENTICATION_FAILED", false],
    [432, "QUOTA_EXCEEDED", false],
    [433, "QUOTA_EXCEEDED", false],
    [500, "PROVIDER_UNAVAILABLE", true],
  ] as const)("maps provider HTTP %s to %s", async (status, code, retryable) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({}, status, { "x-request-id": "request-error" })),
    );
    const tool = createWebSearch({ apiKey });

    const result = await tool.execute(tool.schema.parse({ query: "test" }));

    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ code, retryable, providerStatus: status, requestId: "request-error" });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("preserves retry-after metadata without retrying a rate-limited request", async () => {
    const fetchMock = vi.fn(async () => response({}, 429, { "retry-after": "60" }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = createWebSearch({ apiKey });

    const result = await tool.execute(tool.schema.parse({ query: "test" }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 60 });
  });

  it("rejects malformed provider responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ query: "test", results: "invalid" })),
    );
    const tool = createWebSearch({ apiKey });

    const result = await tool.execute(tool.schema.parse({ query: "test" }));

    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ code: "INVALID_PROVIDER_RESPONSE", retryable: false });
  });

  it("rejects invalid provider JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json")),
    );
    const tool = createWebSearch({ apiKey });

    const result = await tool.execute(tool.schema.parse({ query: "test" }));

    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ code: "INVALID_PROVIDER_RESPONSE", retryable: false });
  });

  it("propagates the call signal to fetch and cancels promptly", async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        fetchSignal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          fetchSignal!.addEventListener("abort", () => reject(fetchSignal!.reason), { once: true });
        });
      }),
    );
    const controller = new AbortController();
    const tool = createWebSearch({ apiKey });

    const pending = tool.execute(tool.schema.parse({ query: "test" }), undefined, controller.signal);
    controller.abort();
    const result = await pending;

    expect(fetchSignal?.aborted).toBe(true);
    expect(result.details).toMatchObject({ code: "CANCELLED", retryable: false });
  });

  it("maps the provider timeout to a retryable availability error", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    );
    const tool = createWebSearch({ apiKey });

    const pending = tool.execute(tool.schema.parse({ query: "test" }));
    timeout.abort();
    const result = await pending;

    expect(result.content).toEqual([{ type: "text", text: "Web search timed out after 20 seconds" }]);
    expect(result.details).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });
});

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
