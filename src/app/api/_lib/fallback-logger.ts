import { AppError } from "@/core/domain/errors";

import type { ErrorLogger } from "./http-errors";

/**
 * Last-resort logger for the window where the container itself cannot be built
 * (bad env, DB pool creation failure) — pino does not exist yet, and returning
 * a 500 with no log line anywhere would be silent error swallowing.
 *
 * Never use this when `getContainer()` succeeded: pino carries the process
 * bindings (service, env) that make logs correlatable.
 */

function serialise(context?: Record<string, unknown> & { err?: unknown }) {
  if (!context) return {};
  const { err, ...rest } = context;
  if (err === undefined) return rest;
  if (AppError.is(err)) return { ...rest, err: err.toLogObject() };
  if (err instanceof Error) return { ...rest, err: { message: err.message, stack: err.stack } };
  return { ...rest, err: { message: String(err) } };
}

function write(level: "warn" | "error", message: string, context?: Record<string, unknown>): void {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    service: "mysp-web",
    logger: "fallback",
    message,
    ...serialise(context),
  });
  if (level === "error") console.error(line);
  else console.warn(line);
}

export const fallbackLogger: ErrorLogger = {
  warn: (message, context) => write("warn", message, context),
  error: (message, context) => write("error", message, context),
};
