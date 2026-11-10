import pino from "pino";
import path from "node:path";

export type LoggerOptions = pino.LoggerOptions & {
  environment?: string;
  directory?: string;
};

/** A real Pino instance, including native bindings, serializers and child loggers. */
export function createLogger(service: string, options: LoggerOptions = {}, destination?: pino.DestinationStream) {
  if (!service.trim()) throw new Error("service name is required for logger initialization");
  const {
    environment = process.env.NODE_ENV || "development",
    directory = process.env.LOG_DIR || "logs",
    ...pinoOptions
  } = options;
  const settings: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    ...pinoOptions,
    base: { pid: process.pid, service, env: environment, ...pinoOptions.base },
  };
  if (destination) return pino(settings, destination);
  if (environment === "test") return pino(settings);
  if (environment !== "production") {
    return pino(
      settings,
      pino.transport({
        target: "pino-pretty",
        options: { colorize: true, translateTime: "yyyy-mm-dd HH:MM:ss", ignore: "pid,hostname" },
      }),
    );
  }
  // Keep container stdout available alongside the persistent rotating file.
  return pino(
    settings,
    pino.transport({
      targets: [
        { target: "pino/file", level: settings.level, options: { destination: 1 } },
        {
          target: "pino-transport-rotating-file",
          level: settings.level,
          options: {
            dir: path.resolve(directory),
            filename: service,
            size: "20M",
            interval: "1d",
            retentionDays: 30,
            compress: false,
            // The transport's raw mode drops line separators between records.
            skipPretty: false,
          },
        },
      ],
    }),
  );
}
