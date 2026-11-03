import { z } from "zod";

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(9203),
    HOST: z.string().min(1).default("0.0.0.0"),
    ROLE: z.enum(["api", "worker", "gateway", "all"]).default("all"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
    DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    // 32-byte hex key for AES-256-GCM encryption of stored model, SSH and Runner credentials.
    MODEL_CONFIG_ENCRYPTION_KEY: z
      .string()
      .regex(/^[\da-f]{64}$/i)
      .optional(),
    AUTH_MODE: z.enum(["dev", "casdoor"]).default("casdoor"),
    AUTH_SERVICE_URL: z.string().default("http://auth.8and1.cn"),
    // Historical auth-service accepts ?token=. Switch explicitly once Bearer is supported.
    AUTH_SERVICE_TOKEN_TRANSPORT: z.enum(["header", "query"]).default("query"),
    AUTH_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(5000),
    // SSE: per-subscriber bounded queue; values outside the safe range are clamped at
    // runtime by the SSE adapter, so the only guard here is the parsing contract.
    SSE_QUEUE_FRAMES: z.coerce.number().int().positive().max(8192).default(256),
    SSE_QUEUE_BYTES: z.coerce
      .number()
      .int()
      .min(65536)
      .max(16 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    SSE_HEARTBEAT_MS: z.coerce.number().int().positive().max(120_000).default(15_000),
    // Worker lease: jobs and run-claim checks claim CAS in one iteration.
    WORKER_LEASE_SECONDS: z.coerce.number().int().positive().max(300).default(30),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().max(64).default(4),
    SWAGGER_UI_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && value.AUTH_MODE !== "casdoor") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Production requires AUTH_MODE=casdoor",
      });
    }
  });

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return environmentSchema.parse({
    ...environment,
    // Compatibility with the previous deployment configuration; this is an Auth Service origin.
    AUTH_SERVICE_URL: environment.AUTH_SERVICE_URL,
  });
}
