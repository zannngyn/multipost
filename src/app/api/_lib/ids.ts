import { z } from "zod";

/**
 * Identifier guard for route handlers (CLAUDE.md technical rule 2 — validate at
 * the boundary).
 *
 * Why it exists: `post_batch.id`, `post_job.id` and `channel_group.id` are
 * `uuid` columns. A typo in the URL (`/batches/abc`) reaches Postgres as an
 * invalid cast and comes back as DB_ERROR 503 — an infrastructure alarm for
 * what is really a bad request, and one that tells the operator to "thử lại sau
 * ít phút" for something retrying can never fix.
 *
 * Loose pattern on purpose, mirroring `isTenantId` in core/domain/tenant.ts:
 * the seeded fixture ids carry no RFC-4122 version nibble and `z.uuid()` would
 * reject them.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidField(message: string) {
  return z.string({ error: message }).trim().regex(UUID_PATTERN, message);
}
