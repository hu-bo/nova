import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import pino from "pino";
import type { Bindings, ChildLoggerOptions, DestinationStream, LoggerOptions as PinoLoggerOptions } from "pino";

dayjs.extend(utc);

type LogMethods = Pick<pino.Logger, "debug" | "error" | "fatal" | "info" | "silent" | "trace" | "warn">;

export type Logger = LogMethods & {
  level: pino.LevelWithSilentOrString;
  child(scope: string): Logger;
  child(bindings: Bindings, options?: ChildLoggerOptions): Logger;
};

export type LoggerOptions = PinoLoggerOptions & {
  stream?: DestinationStream;
};

export interface DailyFileStream extends DestinationStream {
  close(): Promise<void>;
}

export function createDailyFileStream(directory: string): DailyFileStream {
  mkdirSync(directory, { recursive: true });
  let currentDate = "";
  let stream: WriteStream | undefined;

  const rotate = (): WriteStream => {
    const date = dayjs().utcOffset(8).format("YYYY-MM-DD");
    if (stream && currentDate === date) return stream;
    stream?.end();
    currentDate = date;
    stream = createWriteStream(join(directory, `${date}.log`), { flags: "a" });
    return stream;
  };

  return {
    write(message: string) {
      rotate().write(message);
    },
    async close() {
      if (!stream) return;
      const active = stream;
      stream = undefined;
      await new Promise<void>((resolve, reject) => {
        active.once("error", reject);
        active.end(resolve);
      });
    },
  };
}

function createScopedLogger(logger: pino.Logger): Logger {
  return {
    debug: logger.debug.bind(logger),
    error: logger.error.bind(logger),
    fatal: logger.fatal.bind(logger),
    info: logger.info.bind(logger),
    silent: logger.silent.bind(logger),
    trace: logger.trace.bind(logger),
    warn: logger.warn.bind(logger),
    get level() {
      return logger.level;
    },
    set level(value: pino.LevelWithSilentOrString) {
      logger.level = value;
    },
    child(scopeOrBindings: string | Bindings) {
      return createScopedLogger(
        logger.child(typeof scopeOrBindings === "string" ? { scope: scopeOrBindings } : scopeOrBindings),
      );
    },
  };
}

export function createLogger(service: string, options: LoggerOptions = {}): Logger {
  const { base, stream, ...pinoOptions } = options;
  const logger = pino(
    {
      ...pinoOptions,
      level: options.level ?? process.env.LOG_LEVEL ?? "info",
      base: { ...(base ?? {}), service },
      timestamp: options.timestamp ?? (() => `,"time":"${dayjs().utcOffset(8).format("YYYY-MM-DD HH:mm:ss")}"`),
      formatters: {
        ...options.formatters,
        level: (label) => ({ level: label }),
      },
    },
    stream,
  );

  return createScopedLogger(logger);
}
