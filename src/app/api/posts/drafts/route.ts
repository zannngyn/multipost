import { createHash } from "node:crypto";

import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import type { TenantId } from "@/composition/require-tenant";

/**
 * E10 — the compose screen's draft: read it back, autosave it, throw it away.
 *
 * Thin by contract (docs/07 §3.3). Everything that decides what a draft may
 * contain lives in `core/domain/post-draft.ts`: the whitelist (a payload with
 * stock/price/note/URL comes back 422 DRAFT_PAYLOAD_REJECTED), the 64 KiB cap
 * (413 DRAFT_TOO_LARGE) and the shape itself. This file only resolves WHO the
 * draft belongs to and hands the payload over untouched.
 *
 * Identity: the owner is read from the SESSION, never from the body. A draft
 * addressed by tenant alone would be tenant-SHARED, and two operators on the
 * same tenant would silently overwrite each other's work.
 *
 * M1.3b — editor, tier R to read and M to write (doc 10 §4.2). There is
 * deliberately NO parameter naming another owner: a draft is "chỉ chính chủ",
 * admin and owner included, so the route physically cannot address one.
 *
 * The owner is the ACCOUNT, not the e-mail (closes the last field-level TODO of
 * doc 10 §4.2). An address is an attribute of an identity (docs/09 §3.1): key
 * ownership on it and an operator who changes e-mail silently loses their work,
 * while the old address — reused by a new colleague — inherits it. `account.id`
 * is the stable identifier, and `app_user` has carried `account_id` with
 * `UNIQUE (tenant_id, account_id)` since M1.1.
 *
 * "No app_user row for this account" is NOT an error. It is a real state (the
 * dev bypass without a row, an M1.1 backfill leftover whose `account_id` stayed
 * NULL), and it answers `persisted: false` so the screen can say "nháp chỉ lưu
 * trên máy này" out loud — the one thing it must not do is look like a
 * successful save.
 */

const ROUTE_GET = "GET /api/posts/drafts";
const ROUTE_PUT = "PUT /api/posts/drafts";
const ROUTE_DELETE = "DELETE /api/posts/drafts";

/** Answered when the session account matches no `app_user` row of this tenant. */
const NO_USER_REASON = "NO_USER";

/**
 * Owner key handed to the browser so its `localStorage` buffer can be scoped to
 * the SAME (tenant, owner) pair the DB indexes on.
 *
 * A hash, not the id: `app_user.id` is an internal identifier and there is no
 * reason for it to sit in a key any script on the page can read. It is salted
 * with the tenant, so the same operator on two tenants gets two buckets, and
 * truncated to 16 hex chars — long enough that two operators never collide,
 * short enough to keep the key readable while debugging.
 */
function ownerKeyFor(tenantId: string, ownerUserId: string): string {
  return createHash("sha256").update(`${tenantId}:${ownerUserId}`).digest("hex").slice(0, 16);
}

const SaveSchema = z
  .object({
    /**
     * Deliberately `unknown`: the draft shape is core's business, and validating
     * it twice with two slightly different schemas is how the two drift apart.
     * The usecase rejects a bad payload with a code this route already maps.
     */
    payload: z.unknown(),
  })
  .refine((body) => body.payload !== undefined, {
    message: "Thiếu nội dung nháp.",
    path: ["payload"],
  });

export const dynamic = "force-dynamic";

/**
 * `app_user.id` of the caller, or null when this account has no row here.
 *
 * Not an authorisation check — `requireTenantContext` already proved the
 * membership, and the lookup is scoped to the tenant it returned. This is the
 * ownership key, and refusing to guess it is the point.
 *
 * A session with no `accountId` (the local dev bypass on a box with no database)
 * is a legitimate state, not a failure: it means there is nowhere on the server
 * for this person's draft to live, which is exactly what `null` says.
 */
async function resolveOwnerUserId(
  tenantId: TenantId,
  accountId: string | null,
): Promise<string | null> {
  const trimmed = accountId?.trim() ?? "";
  if (trimmed.length === 0) return null;

  return getContainer().usecases.findDraftOwnerUserId(tenantId, trimmed);
}

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first -----------------------------------------------------
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE_GET}`,
      tier: "R",
      minRole: "editor",
    });
    const ownerUserId = await resolveOwnerUserId(ctx.tenantId, session.accountId);

    // No owner means no server-side draft, not a failure.
    if (ownerUserId === null) {
      logger.warn("Draft read without a resolvable operator", {
        route: ROUTE_GET,
        tenant_id: ctx.tenantId,
        reason: NO_USER_REASON,
      });
      // `ownerKey: null` tells the client to use its anonymous bucket instead of
      // reading whatever a named operator left on this machine.
      return Response.json({ draft: null, updatedAt: null, persisted: false, ownerKey: null });
    }

    const stored = await container.usecases.loadPostDraft({
      tenantId: ctx.tenantId,
      ownerUserId,
    });

    return Response.json({
      draft: stored?.payload ?? null,
      updatedAt: stored?.updatedAt ?? null,
      persisted: true,
      ownerKey: ownerKeyFor(ctx.tenantId, ownerUserId),
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_GET } });
  }
}

export async function PUT(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first -----------------------------------------------------
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE_PUT}`,
      tier: "M",
      minRole: "editor",
    });

    // `readJsonBody` parses the body itself, so a `text/plain` beacon body is
    // read exactly like an `application/json` one.
    const body = await readJsonBody(request, SaveSchema, { route: ROUTE_PUT });
    const ownerUserId = await resolveOwnerUserId(ctx.tenantId, session.accountId);

    if (ownerUserId === null) {
      logger.warn("Draft autosave without a resolvable operator", {
        route: ROUTE_PUT,
        tenant_id: ctx.tenantId,
        reason: NO_USER_REASON,
      });
      // 200, not an error: nothing went wrong, the draft simply has nowhere to
      // live on the server. The screen turns this into "chỉ lưu trên máy này".
      return Response.json({ updatedAt: null, persisted: false, reason: NO_USER_REASON });
    }

    const saved = await container.usecases.savePostDraft({
      tenantId: ctx.tenantId,
      ownerUserId,
      payload: body.payload,
    });

    return Response.json({ updatedAt: saved.updatedAt, persisted: true });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_PUT } });
  }
}

/**
 * `navigator.sendBeacon` can only send POST, and it is the only way to flush a
 * draft while the tab is closing. Same handler, same idempotent upsert — a
 * second identical call writes the same row again and changes nothing.
 */
export const POST = PUT;

export async function DELETE(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first -----------------------------------------------------
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE_DELETE}`,
      tier: "M",
      minRole: "editor",
    });
    const ownerUserId = await resolveOwnerUserId(ctx.tenantId, session.accountId);

    // No owner = no row addressed to anyone; "already gone" is the same outcome
    // the caller asked for, so it answers 204 rather than inventing a failure.
    if (ownerUserId !== null) {
      await container.usecases.discardPostDraft({ tenantId: ctx.tenantId, ownerUserId });
    } else {
      logger.warn("Draft discard without a resolvable operator", {
        route: ROUTE_DELETE,
        tenant_id: ctx.tenantId,
        reason: NO_USER_REASON,
      });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_DELETE } });
  }
}
