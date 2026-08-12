/**
 * Infrastructure ports — core declares what it needs, adapters implement it.
 * Pure TypeScript: no imports (see docs/07 section 2).
 */

/** Bindings attached to every log line so "why did this post fail" is answerable. */
export interface LogBindings {
  tenant_id?: string;
  job_id?: string;
  batch_id?: string;
  /** Product code, e.g. "AB123". */
  product_code?: string;
  /** Target channel id/name. */
  channel?: string;
  [key: string]: unknown;
}

/** Extra fields for one specific log line (error code, counts, durations...). */
export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  /** Derive a logger carrying extra bindings. Never mutates the parent. */
  child(bindings: LogBindings): Logger;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  /** `error` accepts the thrown value so adapters can serialise stack + cause. */
  error(message: string, context?: LogContext & { err?: unknown }): void;
}

export interface Clock {
  now(): Date;
  /** Milliseconds since epoch — cheaper than allocating a Date. */
  nowMs(): number;
}
