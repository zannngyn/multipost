import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { AppError } from "@/core/domain/errors";

import * as schema from "./schema";

/**
 * Postgres connection + drizzle handle. The ONLY place a driver is instantiated.
 * Long-lived processes (Next server, worker) use `getDbHandle`; scripts and
 * tests use `makeDbHandle` so they can close deterministically.
 */

export type Database = PostgresJsDatabase<typeof schema>;

/** The handle drizzle hands to a `db.transaction(...)` callback. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Anything that can run a statement — same query API inside or outside a tx. */
export type DbExecutor = Database | Transaction;

/** Small on purpose: one VPS, several Node processes sharing one Postgres. */
const DEFAULT_POOL_MAX = 5;
const DEFAULT_CONNECT_TIMEOUT_S = 10;

export interface DbHandle {
  db: Database;
  /** Drains the pool. Safe to call twice. */
  close(): Promise<void>;
}

export interface DbOptions {
  url: string;
  maxPoolSize?: number;
  /** Seconds to wait for a TCP connection before failing. */
  connectTimeoutSeconds?: number;
}

function assertUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new AppError("INVALID_INPUT", {
      message: "DATABASE_URL is missing or empty",
      userMessage: "Thiếu cấu hình kết nối cơ sở dữ liệu.",
    });
  }
  if (!url.startsWith("postgres://") && !url.startsWith("postgresql://")) {
    throw new AppError("INVALID_INPUT", {
      message: "DATABASE_URL must be a postgres connection string",
      userMessage: "Cấu hình kết nối cơ sở dữ liệu không hợp lệ.",
    });
  }
}

export function makeDbHandle(options: DbOptions): DbHandle {
  assertUrl(options.url);

  let sql: postgres.Sql;
  try {
    sql = postgres(options.url, {
      max: options.maxPoolSize ?? DEFAULT_POOL_MAX,
      connect_timeout: options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_S,
      // Lazy: postgres.js connects on first query, so a bad host fails at the
      // query site (wrapped as DB_ERROR) instead of at import time.
      onnotice: () => {},
    });
  } catch (error) {
    // Bad URL shape / unsupported option — never let a driver error escape raw.
    throw AppError.from(error, "DB_ERROR", { stage: "connect" });
  }

  const db = drizzle(sql, { schema });
  let closed = false;

  return {
    db,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await sql.end({ timeout: 5 });
      } catch (error) {
        throw AppError.from(error, "DB_ERROR", { stage: "close" });
      }
    },
  };
}

let cached: DbHandle | null = null;

/** Process-wide singleton. Reuses the pool across hot reloads and requests. */
export function getDbHandle(options: DbOptions): DbHandle {
  if (!cached) cached = makeDbHandle(options);
  return cached;
}

export async function closeDbHandle(): Promise<void> {
  const handle = cached;
  cached = null;
  if (handle) await handle.close();
}
