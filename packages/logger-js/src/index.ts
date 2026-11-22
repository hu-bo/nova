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
  // Keep container stdout as JSON lines for log platforms; the persistent rotating file renders
  // readable `TIME LEVEL [service] message {extras}` text lines for operators.
  return pino(
    settings,
    pino.transport({
      targets: [
        { target: "pino/file", level: settings.level, options: { destination: 1 } },
        {
          // Resolve as a file URL relative to this module so the worker loads the bundled transport.
          target: new URL("./rotating-file-transport.js", import.meta.url).href,
          level: settings.level,
          options: {
            dir: path.resolve(directory),
            filename: service,
            size: "20M",
            interval: "1d",
            retentionDays: 30,
            // Base bindings repeat on every record; the file name already carries the service.
            ignore: Object.keys(settings.base ?? {}).filter((key) => key !== "service"),
          },
        },
      ],
    }),
  );
}
