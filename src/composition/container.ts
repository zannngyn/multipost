import { makeSystemClock } from "@/adapters/clock/system-clock";
import { makePinoLogger } from "@/adapters/logging/pino-logger";
import type { Clock, Logger } from "@/core/ports/infra";

import { loadConfig, type Config } from "./config";

/**
 * Composition root — the ONLY place that knows both core and adapters.
 * DB, queue and Google adapters get wired here as their epics land (E2/E5).
 */

export interface Infra {
  config: Config;
  logger: Logger;
  clock: Clock;
}

export interface Usecases {
  // Filled by feature epics, e.g. composePost: makeComposePost(deps).
  readonly _placeholder?: never;
}

export interface Container extends Infra {
  usecases: Usecases;
}

export function makeInfra(config: Config): Infra {
  const logger = makePinoLogger({
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
    base: { service: "mysp", env: config.NODE_ENV },
  });
  return { config, logger, clock: makeSystemClock() };
}

export function makeUsecases(_deps: Infra): Usecases {
  return {};
}

export function makeContainer(config: Config = loadConfig()): Container {
  const infra = makeInfra(config);
  return { ...infra, usecases: makeUsecases(infra) };
}

let cached: Container | null = null;

/**
 * Lazy singleton for long-lived processes (Next server, worker).
 * Fails fast on bad config the first time it is touched — not at import time,
 * so `next build` does not require a full production env.
 */
export function getContainer(): Container {
  if (!cached) cached = makeContainer();
  return cached;
}
