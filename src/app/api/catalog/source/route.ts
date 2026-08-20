import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";

/**
 * "Nguồn dữ liệu" card of the sync screen: WHICH Drive folder and WHICH Sheet
 * tab this tenant reads from (`tenant_integration`, provider google).
 * Thin by contract (docs/07 §3.3): validate -> usecase -> map errors.
 *
 * A tenant with no integration row is NOT an error — it is a tenant nobody has
 * configured yet. The usecase answers `null` and this route turns it into a 200
 * with `state: "not_configured"`, so the screen shows an empty state with the
 * one sentence an operator needs instead of a red box they cannot act on.
 *
 * Auth (M1.3b, doc 10 §4.1): GET = viewer, tier R. PUT = admin, tier S —
 * changing the source is what the NEXT sync deletes the old catalog for, so the
 * membership is read fresh, never from a cache. The tenant comes from
 * `requireTenantContext`; a `tenantId` an old UI build still sends is stripped
 * and ignored (transition rule, docs/11 §3.2).
 */

const ROUTE = "GET /api/catalog/source";
const ROUTE_PUT = "PUT /api/catalog/source";

/**
 * A pasted browser URL and a bare id are both accepted — the USECASE parses
 * them (one parser, shared with any other caller). This schema only enforces
 * what is true of both: present, not blank, not absurdly long.
 */
const MAX_SOURCE_REF = 512;

const UpdateBodySchema = z.object({
  driveFolder: z
    .string({ error: "Thiếu thư mục Drive." })
    .trim()
    .min(1, "Nhập link hoặc ID thư mục Drive.")
    .max(MAX_SOURCE_REF, "Link thư mục Drive quá dài."),
  spreadsheet: z
    .string({ error: "Thiếu bảng Sheet." })
    .trim()
    .min(1, "Nhập link hoặc ID bảng Google Sheet.")
    .max(MAX_SOURCE_REF, "Link bảng Sheet quá dài."),
  sheetName: z
    .string({ error: "Thiếu tên tab." })
    .trim()
    .min(1, "Nhập tên tab chứa bảng sản phẩm.")
    .max(128, "Tên tab quá dài."),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first: no membership, no answer (doc 10 §3) --------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
      minRole: "viewer",
    });

    const source = await container.usecases.getCatalogSource({ tenantId: ctx.tenantId });

    // `not_configured` is a 200 EMPTY STATE, and stays distinct from the 404 of
    // "no membership" — the two meanings must never be merged (doc 10 §3).
    if (!source) {
      return Response.json({ state: "not_configured", tenantId: ctx.tenantId });
    }

    return Response.json({ state: "configured", tenantId: ctx.tenantId, source });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}

/**
 * Points a tenant at another Drive folder / Sheet tab.
 *
 * PUT, not POST: the whole source is replaced and sending it twice leaves the
 * same state. The actor's e-mail is taken from the SESSION, never from the body
 * — a caller must not be able to write someone else's name into the audit trail.
 *
 * This route decides nothing: which URL forms are valid, and what a change does
 * to already-synced rows, belong to the usecase. The screen is responsible for
 * warning the operator that the next sync will delete what no longer belongs to
 * the new source.
 */
export async function PUT(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // Authorise BEFORE reading the body: tier S, so the membership is the fresh
    // row and an editor gets 403 without the payload ever being parsed.
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE_PUT}`,
      tier: "S",
      minRole: "admin",
    });
    const body = await readJsonBody(request, UpdateBodySchema, { route: ROUTE_PUT });

    const source = await container.usecases.updateCatalogSource({
      tenantId: ctx.tenantId,
      driveFolder: body.driveFolder,
      spreadsheet: body.spreadsheet,
      sheetName: body.sheetName,
      actorEmail: session.email,
    });

    return Response.json({ state: "configured", tenantId: ctx.tenantId, source });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_PUT } });
  }
}
