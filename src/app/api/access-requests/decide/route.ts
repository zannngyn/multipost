import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * M2.4 — RETIRED. Approval stopped being how people enter: sign-in provisions
 * an account (NoMembership), companies are entered through invite links
 * (M2.2), and roles are managed on /api/members (M2.3). This endpoint answers
 * 410 for every caller so an old UI fails loudly instead of silently deciding
 * nothing.
 *
 * THE GAP THIS LEAVES, on purpose: "block a bad actor" used to live here
 * (decide→blocked suspended the account platform-wide). Until M3.1 ships the
 * platform suspend switch, banning someone means setting
 * `account.status='suspended'` by hand — the sign-in gate and the session
 * still enforce it everywhere.
 *
 * GET /api/access-requests stays: the registry is read-only history.
 */

const ROUTE = "POST /api/access-requests/decide";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    logger = getContainer().logger;
    throw new AppError("RETIRED", {
      message: "The approval queue retired at M2.4 — members join through invite links",
      userMessage: "Luồng duyệt đã nghỉ hưu — thành viên vào công ty bằng link mời.",
      context: { route: ROUTE, retired_at: "M2.4" },
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
