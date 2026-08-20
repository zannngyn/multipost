import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

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
 * Auth: enforced by `middleware.ts` for every non-public /api path.
 */

const ROUTE = "GET /api/catalog/source";
const ROUTE_PUT = "PUT /api/catalog/source";

const QuerySchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
});

/**
 * A pasted browser URL and a bare id are both accepted — the USECASE parses
 * them (one parser, shared with any other caller). This schema only enforces
 * what is true of both: present, not blank, not absurdly long.
 */
const MAX_SOURCE_REF = 512;

const UpdateBodySchema = z.object({
  tenantId: z
    .string({ error: "Thiếu mã đơn vị (tenant)." })
    .trim()
    .min(1, "Thiếu mã đơn vị (tenant)."),
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

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      tenantId: url.searchParams.get("tenantId") ?? undefined,
    });

    // --- Edge case first: reject bad input before touching the DB -----------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for catalog source",
        userMessage: "Tham số không hợp lệ. Vui lòng kiểm tra lại mã đơn vị (tenant).",
        context: {
          route: ROUTE,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "tenantId",
            message: issue.message,
          })),
        },
      });
    }

    const source = await container.usecases.getCatalogSource({ tenantId: legacyTenantIdFromRequest(parsed.data.tenantId) });

    if (!source) {
      return Response.json({ state: "not_configured", tenantId: parsed.data.tenantId });
    }

    return Response.json({ state: "configured", tenantId: parsed.data.tenantId, source });
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

    const body = await readJsonBody(request, UpdateBodySchema, { route: ROUTE_PUT });
    const session = await getOperatorSession(`api:${ROUTE_PUT}`);

    const source = await container.usecases.updateCatalogSource({
      tenantId: legacyTenantIdFromRequest(body.tenantId),
      driveFolder: body.driveFolder,
      spreadsheet: body.spreadsheet,
      sheetName: body.sheetName,
      actorEmail: session?.email ?? null,
    });

    return Response.json({ state: "configured", tenantId: body.tenantId, source });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_PUT } });
  }
}
