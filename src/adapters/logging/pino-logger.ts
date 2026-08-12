import pino, { type Logger as PinoLogger } from "pino";

import { AppError } from "@/core/domain/errors";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface PinoLoggerOptions {
  level: LogLevel;
  /** Human-readable output for local dev. Never enable in production. */
  pretty?: boolean;
  /** Bindings applied to every line (service name, env, version...). */
  base?: LogBindings;
}

/** Keys never allowed in logs, whatever nesting they appear at. */
const REDACTED_PATHS = [
  "*.password",
  "*.token",
  "*.access_token",
  "*.refresh_token",
  "*.secret",
  "*.client_secret",
  "*.authorization",
];

/** Serialise a thrown value; AppError keeps its code/context/cause. */
function serialiseError(err: unknown): Record<string, unknown> {
  if (AppError.is(err)) return { err: err.toLogObject() };
  if (err instanceof Error) {
    return { err: { name: err.name, message: err.message, stack: err.stack } };
  }
  return { err: { message: String(err) } };
}

class PinoLoggerAdapter implements Logger {
  constructor(private readonly logger: PinoLogger) {}

  child(bindings: LogBindings): Logger {
    return new PinoLoggerAdapter(this.logger.child(bindings));
  }

  debug(message: string, context?: LogContext): void {
    this.logger.debug(context ?? {}, message);
  }

  info(message: string, context?: LogContext): void {
    this.logger.info(context ?? {}, message);
  }

  warn(message: string, context?: LogContext): void {
    this.logger.warn(context ?? {}, message);
  }

  error(message: string, context?: LogContext & { err?: unknown }): void {
    if (!context) {
      this.logger.error({}, message);
      return;
    }
    const { err, ...rest } = context;
    const payload = err === undefined ? rest : { ...rest, ...serialiseError(err) };
    this.logger.error(payload, message);
  }
}

export function makePinoLogger(options: PinoLoggerOptions): Logger {
  const transport = options.pretty
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
    : undefined;

  const logger = pino({
    level: options.level,
    base: options.base ?? {},
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(transport ? { transport } : {}),
  });

  return new PinoLoggerAdapter(logger);
}
