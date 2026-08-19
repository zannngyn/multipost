import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E2 — the tab names of one spreadsheet, so the operator picks "Mẫu 2026" from
 * a list instead of typing it (a typo here makes every sync read an empty tab).
 */

const ROUTE = "GET /api/catalog/google/spreadsheets/tabs";

const QuerySchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
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

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      tenantId: url.searchParams.get("tenantId") ?? undefined,
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
      tenantId: parsed.data.tenantId,
      spreadsheetId: parsed.data.spreadsheetId,
    });

    return Response.json({ tabs }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
