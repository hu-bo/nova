import { text, type Tool, z } from "./shared.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const PROVIDER_TIMEOUT_MS = 20_000;

const domain = z.string().trim().min(1).max(255);
const webUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "Search result URL must use HTTP(S)");
const schema = z.object({
  query: z.string().trim().min(1),
  topic: z.enum(["general", "news", "finance"]).default("general"),
  searchDepth: z.enum(["basic", "advanced"]).default("basic"),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  maxResults: z.number().int().min(1).max(10).default(5),
  includeDomains: z.array(domain).max(10).optional(),
  excludeDomains: z.array(domain).max(10).optional(),
});

const responseSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: webUrl,
      content: z.string(),
      score: z.number(),
    }),
  ),
  response_time: z.union([z.number(), z.string()]),
  request_id: z.string().optional(),
  usage: z.object({ credits: z.number() }).optional(),
});

export type WebSearchArgs = z.output<typeof schema>;
export type WebSearchResult = z.output<typeof responseSchema>["results"][number];

export interface WebSearchDetails {
  query: string;
  results: WebSearchResult[];
  responseTime: number;
  requestId?: string;
  credits?: number;
}

export interface WebSearchErrorDetails {
  code:
    | "INVALID_REQUEST"
    | "AUTHENTICATION_FAILED"
    | "RATE_LIMITED"
    | "QUOTA_EXCEEDED"
    | "PROVIDER_UNAVAILABLE"
    | "INVALID_PROVIDER_RESPONSE"
    | "CANCELLED";
  message: string;
  retryable: boolean;
  providerStatus?: number;
  retryAfterSeconds?: number;
  requestId?: string;
}

export function createWebSearch({
  apiKey,
}: {
  apiKey: string;
}): Tool<WebSearchArgs, WebSearchDetails | WebSearchErrorDetails> {
  if (!apiKey.trim()) throw new Error("Tavily API key must not be empty");

  return {
    name: "web_search",
    description:
      "Search the public web for current or unknown facts. Returns source titles, URLs, and relevant snippets; cite the returned URLs in the answer.",
    schema,
    risk: "read",
    requiresContext: false,
    async execute(args, _ctx, signal) {
      const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await fetch(TAVILY_SEARCH_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: args.query,
            topic: args.topic,
            search_depth: args.searchDepth,
            ...(args.timeRange ? { time_range: args.timeRange } : {}),
            max_results: args.maxResults,
            ...(args.includeDomains ? { include_domains: args.includeDomains } : {}),
            ...(args.excludeDomains ? { exclude_domains: args.excludeDomains } : {}),
            include_answer: false,
            include_raw_content: false,
            include_images: false,
            auto_parameters: false,
            safe_search: true,
            include_usage: true,
            chunks_per_source: 2,
          }),
          signal: requestSignal,
        });

        if (!response.ok) return providerError(response);

        let decoded: unknown;
        try {
          decoded = await response.json();
        } catch {
          return failure(
            {
              code: "INVALID_PROVIDER_RESPONSE",
              message: "Tavily returned invalid JSON",
              retryable: false,
              requestId: response.headers.get("x-request-id") ?? undefined,
            },
            "Web search returned an invalid response",
          );
        }
        const parsed = responseSchema.safeParse(decoded);
        if (!parsed.success) {
          return failure(
            {
              code: "INVALID_PROVIDER_RESPONSE",
              message: "Tavily returned an invalid search response",
              retryable: false,
              requestId: response.headers.get("x-request-id") ?? undefined,
            },
            "Web search returned an invalid response",
          );
        }

        const responseTime = Number(parsed.data.response_time);
        if (!Number.isFinite(responseTime)) {
          return failure(
            {
              code: "INVALID_PROVIDER_RESPONSE",
              message: "Tavily returned an invalid response time",
              retryable: false,
              requestId: parsed.data.request_id,
            },
            "Web search returned an invalid response",
          );
        }

        const details: WebSearchDetails = {
          query: parsed.data.query,
          results: parsed.data.results,
          responseTime,
          ...(parsed.data.request_id ? { requestId: parsed.data.request_id } : {}),
          ...(parsed.data.usage ? { credits: parsed.data.usage.credits } : {}),
        };
        return {
          status: "ok",
          content: text(formatResults(details.query, details.results)),
          details,
        };
      } catch {
        if (signal?.aborted) {
          return failure(
            { code: "CANCELLED", message: "Web search was cancelled", retryable: false },
            "Web search was cancelled",
          );
        }
        return failure(
          { code: "PROVIDER_UNAVAILABLE", message: "Tavily search is unavailable", retryable: true },
          timeout.aborted ? "Web search timed out after 20 seconds" : "Web search is unavailable",
        );
      }
    },
  };
}

function providerError(response: Response) {
  const providerStatus = response.status;
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const base = { providerStatus, ...(requestId ? { requestId } : {}) };
  switch (providerStatus) {
    case 400:
      return failure(
        { ...base, code: "INVALID_REQUEST", message: "Tavily rejected the search request", retryable: false },
        "Web search request was rejected",
      );
    case 401:
      return failure(
        { ...base, code: "AUTHENTICATION_FAILED", message: "Tavily authentication failed", retryable: false },
        "Web search authentication failed",
      );
    case 429: {
      const retryAfterSeconds = retryAfter(response.headers.get("retry-after"));
      return failure(
        {
          ...base,
          code: "RATE_LIMITED",
          message: "Tavily rate limit exceeded",
          retryable: true,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        },
        retryAfterSeconds === undefined
          ? "Web search rate limit exceeded"
          : `Web search rate limit exceeded; retry after ${retryAfterSeconds} seconds`,
      );
    }
    case 432:
    case 433:
      return failure(
        { ...base, code: "QUOTA_EXCEEDED", message: "Tavily search quota exceeded", retryable: false },
        "Web search quota exceeded",
      );
    default:
      return failure(
        { ...base, code: "PROVIDER_UNAVAILABLE", message: "Tavily search is unavailable", retryable: true },
        "Web search is unavailable",
      );
  }
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function failure(details: WebSearchErrorDetails, message: string) {
  return { status: "error" as const, content: text(message), details };
}

function formatResults(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) return `No web search results found for: ${query}`;
  return [
    `Web search results for: ${query}`,
    ...results.flatMap((result, index) => [
      `${index + 1}. ${result.title}`,
      `URL: ${result.url}`,
      `Snippet: ${result.content}`,
    ]),
  ].join("\n");
}
