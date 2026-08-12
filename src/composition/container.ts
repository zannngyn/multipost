import { makeSystemClock } from "@/adapters/clock/system-clock";
import { DrizzleCatalogConfigRepo } from "@/adapters/db/catalog-config-repo.drizzle";
import { closeDbHandle, getDbHandle, type Database } from "@/adapters/db/client";
import { DrizzleMediaRepo } from "@/adapters/db/media-repo.drizzle";
import { DrizzleProductRepo } from "@/adapters/db/product-repo.drizzle";
import { DrizzleSyncRunRepo } from "@/adapters/db/sync-run-repo.drizzle";
import { DrizzleTenantRepo } from "@/adapters/db/tenant-repo.drizzle";
import { makePinoLogger } from "@/adapters/logging/pino-logger";
import type { DriveSource } from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type { SheetSource } from "@/core/ports/sheet-source";
import { makeComposePost, type ComposePost } from "@/core/usecases/compose-post";
import { makeHealthcheckTenant, type HealthcheckTenant } from "@/core/usecases/healthcheck-tenant";
import { makeSyncCatalog, type SyncCatalog } from "@/core/usecases/sync-catalog";

import { makeLazyGenerateCaptions, type GenerateCaptions } from "./ai-engine";
import { loadConfig, type Config } from "./config";
import { makeLazyGoogleSources } from "./google-sources";

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
  syncCatalog: SyncCatalog;
  composePost: ComposePost;
  generateCaptions: GenerateCaptions;
}

/**
 * Injection seam for the catalog sources. Production leaves it empty (the real
 * Google adapters are built lazily); the fixture sources of `sample-data/` are
 * passed in by scripts and integration tests.
 */
export interface UsecaseOverrides {
  drive?: DriveSource;
  sheet?: SheetSource;
}

export interface Container extends Infra {
  usecases: Usecases;
}

export interface InfraOptions {
  /** pino `service` binding. Web and worker share this wiring, not their logs. */
  serviceName?: string;
}

export function makeInfra(config: Config, options: InfraOptions = {}): Infra {
  const logger = makePinoLogger({
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
    base: { service: options.serviceName ?? "mysp", env: config.NODE_ENV },
  });
  const { db } = getDbHandle({ url: config.DATABASE_URL });
  return { config, logger, clock: makeSystemClock(), db };
}

export function makeUsecases(deps: Infra, overrides: UsecaseOverrides = {}): Usecases {
  const tenants = new DrizzleTenantRepo(deps.db);
  const products = new DrizzleProductRepo(deps.db);
  const media = new DrizzleMediaRepo(deps.db);
  const syncRuns = new DrizzleSyncRunRepo(deps.db);
  const catalogConfig = new DrizzleCatalogConfigRepo(deps.db);
  const google = makeLazyGoogleSources({ logger: deps.logger });

  return {
    healthcheckTenant: makeHealthcheckTenant({
      tenants,
      clock: deps.clock,
      logger: deps.logger,
    }),
    syncCatalog: makeSyncCatalog({
      drive: overrides.drive ?? google.drive,
      sheet: overrides.sheet ?? google.sheet,
      catalogConfig,
      products,
      media,
      syncRuns,
      clock: deps.clock,
      logger: deps.logger,
    }),
    composePost: makeComposePost({ products, media, logger: deps.logger }),
    generateCaptions: makeLazyGenerateCaptions({ logger: deps.logger, clock: deps.clock }),
  };
}

export function makeContainer(
  config: Config = loadConfig(),
  overrides: UsecaseOverrides = {},
): Container {
  const infra = makeInfra(config);
  return { ...infra, usecases: makeUsecases(infra, overrides) };
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
