import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E2 — the spreadsheets of the connected Google account.
 *
 * WITHOUT `parentId` this searches the whole Drive, most recently modified
 * first: an operator looking for "bảng hàng thiết kế" almost always wants the
 * one they touched last, not an alphabetical crawl of every folder.
 */

const ROUTE = "GET /api/catalog/google/spreadsheets";
const MAX_PAGE_TOKEN = 4096;
const MAX_QUERY = 128;

const QuerySchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
  /** Optional on purpose: absent = search the whole Drive. */
  parentId: z.string().trim().min(1).max(256).optional(),
  pageToken: z.string().trim().min(1).max(MAX_PAGE_TOKEN).optional(),
  q: z.string().trim().max(MAX_QUERY, "Từ khoá tìm kiếm quá dài.").optional(),
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
      parentId: url.searchParams.get("parentId") ?? undefined,
      pageToken: url.searchParams.get("pageToken") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    });

    // --- Edge case first: reject bad input before touching Drive ------------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for the spreadsheet picker",
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

    const result = await container.usecases.browseGoogleDrive.listSpreadsheets({
      tenantId: legacyTenantIdFromRequest(parsed.data.tenantId),
      parentId: parsed.data.parentId ?? null,
      pageToken: parsed.data.pageToken ?? null,
      q: parsed.data.q ?? null,
    });

    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
