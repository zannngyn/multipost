import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E11.1 — "Chạy lại" one job. Only `failed` and `blocked` may be re-queued;
 * anything else comes back as 409 INVALID_JOB_TRANSITION with the reason, so a
 * published post can never be posted twice from this screen.
 *
 * The retry does NOT skip any rule: the worker re-checks stock before the Graph
 * call (business rule 3), so a job blocked for "hết hàng" that is retried while
 * the sheet still says 0 goes straight back to `blocked`.
 *
 * Who re-ran it is read from the SESSION, never from the body, and handed to the
 * usecase as `actorEmail` so the audit row names the operator: the usecase
 * resolves it to an `app_user.id` through the wired user repository.
 *
 * An e-mail that maps to no account (the dev bypass `dev@localhost`, or an
 * allowed domain signing in before the account row exists) is NOT an error: the
 * usecase logs a warning and writes the audit row with no actor. Refusing to
 * re-queue a post because we cannot name the operator would trade a real
 * problem (the post is not live) for a bookkeeping one.
 *
 * M1.3b — editor / tier S (doc 10 §4.2). The body is now empty: the only field
 * it ever carried was `tenantId`, and the tenant comes from the membership. A
 * client still POSTing that body is fine — it is simply never read.
 */

const ROUTE = "POST /api/posts/jobs/[postJobId]/retry";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ postJobId: string }> },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first: editor / tier S (doc 10 §4.2). A retry publishes for
    // real, so the membership is re-read from the database ------------------
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "editor",
    });

    const { postJobId } = await context.params;
    // --- Edge case first: a typo in the URL is a 400, not a DB cast error ---
    const parsedId = uuidField("Mã bài đăng không hợp lệ.").safeParse(postJobId);
    if (!parsedId.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid post job id in the retry URL",
        userMessage: "Mã bài đăng không hợp lệ.",
        context: {
          route: ROUTE,
          issues: [{ path: "postJobId", message: "Mã bài đăng không hợp lệ." }],
        },
      });
    }

    const result = await container.usecases.retryPostJob({
      tenantId: ctx.tenantId,
      postJobId: parsedId.data,
      // The actor comes from the real session, never from a hopeful client.
      actorEmail: session.email,
    });

    container.logger.info("Post job re-queued from the operator UI", {
      route: ROUTE,
      tenant_id: ctx.tenantId,
      job_id: result.postJobId,
      batch_id: result.batchId,
      channel: result.channelId,
      product_code: result.productCode,
      previous_status: result.previousStatus,
      actor_email: session.email,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
