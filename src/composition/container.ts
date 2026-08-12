import { makeSystemClock } from "@/adapters/clock/system-clock";
import { closeDbHandle, getDbHandle, type Database } from "@/adapters/db/client";
import { DrizzleTenantRepo } from "@/adapters/db/tenant-repo.drizzle";
import { makePinoLogger } from "@/adapters/logging/pino-logger";
import type { Clock, Logger } from "@/core/ports/infra";
import { makeHealthcheckTenant, type HealthcheckTenant } from "@/core/usecases/healthcheck-tenant";

import { loadConfig, type Config } from "./config";

/**
 * Composition root — the ONLY place that knows both core and adapters.
 * Queue and Google adapters get wired here as their epics land (E2/E5).
 */

export interface Infra {
  config: Config;
  logger: Logger;
  clock: Clock;
  db: Database;
}

export interface Usecases {
  healthcheckTenant: HealthcheckTenant;
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
  const { db } = getDbHandle({ url: config.DATABASE_URL });
  return { config, logger, clock: makeSystemClock(), db };
}

export function makeUsecases(deps: Infra): Usecases {
  const tenants = new DrizzleTenantRepo(deps.db);
  return {
    healthcheckTenant: makeHealthcheckTenant({
      tenants,
      clock: deps.clock,
      logger: deps.logger,
    }),
  };
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

/** Drains the DB pool. For scripts and graceful shutdown, not per request. */
export async function closeContainer(): Promise<void> {
  cached = null;
  await closeDbHandle();
}
