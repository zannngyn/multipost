import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E2 — one page of the in-app folder picker, plus the breadcrumb from "Drive
 * của tôi" down to the folder being shown.
 *
 * Runs on the TENANT's Google connection: a tenant that never connected gets
 * 409 GOOGLE_NOT_CONNECTED, which the screen turns into the connect button.
 * Thin by contract (docs/07 §3.3): validate -> usecase -> map errors.
 */

const ROUTE = "GET /api/catalog/google/folders";
const MAX_PAGE_TOKEN = 4096;
const MAX_QUERY = 128;

const QuerySchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
  /** `root` = "Drive của tôi"; the usecase defaults to it when absent. */
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
        message: "Invalid query string for the Drive folder picker",
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

    const result = await container.usecases.browseGoogleDrive.listFolders({
      tenantId: parsed.data.tenantId,
      parentId: parsed.data.parentId ?? null,
      pageToken: parsed.data.pageToken ?? null,
      q: parsed.data.q ?? null,
    });

    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
