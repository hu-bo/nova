import fastifyEnv from "@fastify/env";
import type { FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";

const configSchema = {
  type: "object",
  required: ["DATABASE_URL", "AUTH_SERVICE_URL", "MODEL_CONFIG_ENCRYPTION_KEY"],
  properties: {
    HOST: { type: "string", default: "127.0.0.1" },
    PORT: { type: "integer", minimum: 1, maximum: 65_535, default: 9203 },
    DATABASE_URL: { type: "string", minLength: 1 },
    AUTH_SERVICE_URL: { type: "string", pattern: "^https?://\\S+$", default: "http://auth.8and1.cn" },
    MODEL_CONFIG_ENCRYPTION_KEY: { type: "string", minLength: 43, maxLength: 44 },
    RUNNER_HOST: { type: "string", default: "127.0.0.1" },
    RUNNER_PORT: { type: "integer", minimum: 1, maximum: 65_535, default: 9204 },
    RUNNER_PUBLIC_URL: { type: "string", pattern: "^https?://\\S+$" },
    MINIO_ENDPOINT: { type: "string", default: "minio.8and1.cn" },
    MINIO_PORT: { type: "integer", minimum: 1, maximum: 65_535, default: 80 },
    MINIO_USE_SSL: { type: "boolean", default: false },
    MINIO_ACCESS_KEY: { type: "string", default: "" },
    MINIO_SECRET_KEY: { type: "string", default: "" },
    MINIO_BUCKET: { type: "string", default: "config" },
  },
} as const;

export interface ServerConfig {
  HOST: string;
  PORT: number;
  DATABASE_URL: string;
  AUTH_SERVICE_URL: string;
  MODEL_CONFIG_ENCRYPTION_KEY: string;
  RUNNER_HOST: string;
  RUNNER_PORT: number;
  RUNNER_PUBLIC_URL: string;
  MINIO_ENDPOINT: string;
  MINIO_PORT: number;
  MINIO_USE_SSL: boolean;
  MINIO_ACCESS_KEY: string;
  MINIO_SECRET_KEY: string;
  MINIO_BUCKET: string;
}

type EnvironmentConfig = Omit<ServerConfig, "RUNNER_PUBLIC_URL"> & {
  RUNNER_PUBLIC_URL?: string;
};

export async function loadConfig(app: FastifyInstance, data: NodeJS.ProcessEnv = process.env): Promise<ServerConfig> {
  await app.register(fastifyEnv, {
    schema: configSchema,
    data,
    dotenv: { path: fileURLToPath(new URL("../../.env", import.meta.url)) },
  });
  const config = app.getEnvs<EnvironmentConfig>();
  const advertisedHost =
    config.RUNNER_HOST === "0.0.0.0" || config.RUNNER_HOST === "::" ? "127.0.0.1" : config.RUNNER_HOST;
  return {
    ...config,
    RUNNER_PUBLIC_URL: config.RUNNER_PUBLIC_URL ?? `http://${advertisedHost}:${config.RUNNER_PORT}`,
  };
}
