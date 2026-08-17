import { eq } from "drizzle-orm";

import type { Database } from "@/adapters/db/client";
import { tenantIntegrations } from "@/adapters/db/schema";
import { DEMO_TENANT_ID } from "@/adapters/db/seed-constants";

/**
 * Refuses to run a smoke script against a database that holds real channels.
 *
 * Both smoke scripts seed `tenant_integration` with `onConflictDoUpdate` keyed
 * on (tenant, provider), which REPLACES the whole row — the channel array
 * included. Run against a database where an operator has connected real
 * Fanpages, that silently destroys every one of them along with its Page token;
 * it happened twice on the development machine before this guard existed, and
 * the second time cost a set of tokens that had to be re-issued by hand.
 *
 * The rule is deliberately "any channel this script does not own", not a
 * hardcoded blocklist: a new fake channel added to a smoke script is a one-line
 * change here, while an unrecognised real Page must always stop the run.
 *
 * `SMOKE_ALLOW_OVERWRITE=1` is the escape hatch for someone who genuinely means
 * it. It is not read anywhere else, so it cannot be set by accident.
 */

export interface SmokeGuardInput {
  readonly db: Database;
  /** Channel ids the caller is about to seed and is therefore allowed to replace. */
  readonly ownedChannelIds: readonly string[];
  /** Script name, for the error message. */
  readonly scriptName: string;
  readonly env?: Record<string, string | undefined>;
}

const OVERRIDE_ENV = "SMOKE_ALLOW_OVERWRITE";

/** Channel ids present in the database that the script does not own. */
export async function findForeignChannelIds(
  db: Database,
  ownedChannelIds: readonly string[],
): Promise<string[]> {
  const owned = new Set(ownedChannelIds);
  const rows = await db
    .select({ config: tenantIntegrations.config })
    .from(tenantIntegrations)
    .where(eq(tenantIntegrations.tenantId, DEMO_TENANT_ID));

  const foreign: string[] = [];
  for (const row of rows) {
    const channels = (row.config as { channels?: unknown })?.channels;
    if (!Array.isArray(channels)) continue;
    for (const channel of channels) {
      const id = (channel as { channelId?: unknown })?.channelId;
      // An unreadable entry counts as foreign: the point is to protect data this
      // script cannot account for, and "cannot account for" includes "cannot parse".
      if (typeof id !== "string") {
        foreign.push("<unreadable channel entry>");
        continue;
      }
      if (!owned.has(id)) foreign.push(id);
    }
  }
  return foreign;
}

/**
 * Throws unless the database holds only channels this script owns. Call BEFORE
 * the first write.
 */
export async function assertSafeToSeed(input: SmokeGuardInput): Promise<void> {
  const env = input.env ?? process.env;
  const foreign = await findForeignChannelIds(input.db, input.ownedChannelIds);
  if (foreign.length === 0) return;

  if (env[OVERRIDE_ENV] === "1") {
    console.warn(
      `[${input.scriptName}] ${OVERRIDE_ENV}=1 — overwriting ${foreign.length} channel(s) ` +
        `this script does not own: ${foreign.join(", ")}`,
    );
    return;
  }

  throw new Error(
    `[${input.scriptName}] REFUSING TO RUN: this database holds ${foreign.length} channel(s) ` +
      `the smoke seed does not own — ${foreign.join(", ")}.\n` +
      `Seeding replaces the whole tenant_integration row, which would delete those ` +
      `channels and their Page tokens.\n` +
      `Point DATABASE_URL at a throwaway database, or set ${OVERRIDE_ENV}=1 if you ` +
      `really mean to overwrite them.`,
  );
}
