import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * Read model behind the "Sản phẩm" screen: which codes are publishable and
 * which are blocked, with the reason. Thin by contract (docs/07 §3.3).
 *
 * Business rule 2 (whitelist): the usecase returns stock/`blockedReason` as
 * INTERNAL operator fields. They are rendered in the product table — which is
 * an internal screen — and never travel into a caption; nothing here adds a
 * price column, and the compose flow keeps its own whitelist.
 *
 * An unknown `status`/`limit` is rejected rather than silently defaulted: a
 * filter that quietly turns into "everything" makes an operator believe a
 * blocked code is publishable (business rule 5 — nothing fails silently).
 *
 * Auth: enforced by `middleware.ts` for every non-public /api path.
 */

const ROUTE = "GET /api/catalog/products";

/** Mirrors the usecase contract: at most 100 rows per page, 50 by default. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const QuerySchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
  status: z.enum(["ok", "blocked"], { error: "Bộ lọc trạng thái không hợp lệ." }).optional(),
  /** Free text over code/name. Empty string = no search, not "match nothing". */
  q: z.string().trim().max(128, "Từ khoá tìm kiếm quá dài.").optional(),
  cursor: z.string().trim().min(1, "Con trỏ phân trang không hợp lệ.").optional(),
  limit: z.coerce
    .number({ error: "Số dòng mỗi trang phải là số." })
    .int("Số dòng mỗi trang phải là số nguyên.")
    .min(1, "Số dòng mỗi trang phải lớn hơn 0.")
    .max(MAX_LIMIT, `Mỗi trang tối đa ${MAX_LIMIT} dòng.`)
    .optional(),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const url = new URL(request.url);
    const raw = {
      tenantId: url.searchParams.get("tenantId") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    };
    const parsed = QuerySchema.safeParse(raw);

    // --- Edge case first: reject bad input before touching the DB -----------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for catalog products",
        userMessage: "Tham số lọc không hợp lệ. Vui lòng kiểm tra lại.",
        context: {
          route: ROUTE,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "query",
            message: issue.message,
          })),
        },
      });
    }

    const q = parsed.data.q ?? "";
    const result = await container.usecases.listCatalogProducts({
      tenantId: parsed.data.tenantId,
      filter: {
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(q.length > 0 ? { q } : {}),
        ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        limit: parsed.data.limit ?? DEFAULT_LIMIT,
      },
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
