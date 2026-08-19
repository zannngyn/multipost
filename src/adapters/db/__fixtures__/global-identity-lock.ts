import { sql } from "drizzle-orm";

import { makeDbHandle, type DbHandle } from "../client";

/**
 * TEST-ONLY mutex for integration files that touch the GLOBAL identity tables
 * (`account` / `identity` / `access_request`).
 *
 * Why it exists: vitest runs test files in parallel against ONE database. Since
 * M1.2, `decide()` writes `identity` rows, and the M1.1 backfill test replays
 * migration SQL over the whole `access_request` table — two files running at
 * once race each other into `identity_session_email_uq` (a write-write race no
 * per-file cleanup can prevent). Tenant-scoped files are untouched: they never
 * collide, and serialising them would only slow the suite.
 *
 * `maxPoolSize: 1` is load-bearing: `pg_advisory_lock` is SESSION-level, so the
 * lock and unlock must run on the very same connection — a pooled handle could
 * unlock on a different one and leave the lock held forever.
 */

/** Arbitrary but fixed: every participating file must use the same key. */
const GLOBAL_IDENTITY_LOCK_KEY = 421_337_001;

export interface GlobalIdentityTestLock {
  acquire(): Promise<void>;
  /** Releases AND closes the dedicated connection. */
  release(): Promise<void>;
}

export function makeGlobalIdentityTestLock(url: string): GlobalIdentityTestLock {
  let handle: DbHandle | null = null;

  return {
    async acquire() {
      handle = makeDbHandle({ url, maxPoolSize: 1 });
      await handle.db.execute(sql`select pg_advisory_lock(${GLOBAL_IDENTITY_LOCK_KEY})`);
    },
    async release() {
      if (!handle) return;
      await handle.db.execute(sql`select pg_advisory_unlock(${GLOBAL_IDENTITY_LOCK_KEY})`);
      await handle.close();
      handle = null;
    },
  };
}
