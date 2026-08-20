import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E2 — the tab names of one spreadsheet, so the operator picks "Mẫu 2026" from
 * a list instead of typing it (a typo here makes every sync read an empty tab).
 *
 * Auth (M1.3b, doc 10 §4.1): admin, tier S — same credential, same pairing with
 * `PUT /api/catalog/source` as the other two picker endpoints. `spreadsheetId`
 * stays a client parameter: it is a Google id, not an id of ours, and the token
 * it is read with is the only thing that bounds it.
 */

const ROUTE = "GET /api/catalog/google/spreadsheets/tabs";

const QuerySchema = z.object({
  spreadsheetId: z
    .string({ error: "Thiếu mã bảng Google Sheet." })
    .trim()
    .min(1, "Thiếu mã bảng Google Sheet.")
    .max(256, "Mã bảng Google Sheet quá dài."),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first: authorise before touching the tenant credential ---
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "admin",
    });

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      spreadsheetId: url.searchParams.get("spreadsheetId") ?? undefined,
    });

    // --- Edge case first: reject bad input before touching Sheets -----------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for the spreadsheet tab list",
        userMessage: "Tham số không hợp lệ. Vui lòng thử lại.",
        context: {
          route: ROUTE,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "(root)",
            message: issue.message,
          })),
        },
      });
    }

    const tabs = await container.usecases.browseGoogleDrive.listSheetTabs({
      tenantId: ctx.tenantId,
      spreadsheetId: parsed.data.spreadsheetId,
    });

    return Response.json({ tabs }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
