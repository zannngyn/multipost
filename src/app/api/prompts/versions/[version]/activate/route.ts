import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { TargetSchema, withVariableIssues } from "@/app/api/prompts/_lib/prompt-route";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E10.7 — make an older version the active one again (a rollback).
 *
 * Authorisation: tier **S**, minimum role **admin** (doc 10 §4.3) — one call
 * changes every caption the tenant produces from now on, so an admin whose
 * membership was just revoked must lose it immediately, not within a TTL.
 *
 * A version number that does not exist answers 404 `PROMPT_VERSION_NOT_FOUND`
 * (doc 10 B3); the 500 `PROMPT_NOT_FOUND` is kept for the different failure of
 * a missing BUILT-IN template, which is a deployment bug, not a bad request.
 *
 * Exactly one version can be active per (tenant, task, platform); the swap is
 * ONE transaction inside the repository, never a "deactivate then activate"
 * pair, so no generation can ever run between the two halves.
 *
 * The usecase re-validates the stored body before activating: a version drafted
 * while the whitelist was looser must not become active now. That refusal comes
 * back as 400 naming the variables.
 */

const ROUTE = "POST /api/prompts/versions/[version]/activate";

const BodySchema = TargetSchema;

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ version: string }> },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first: tenant + role, then the URL, then the body ---------
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "admin",
    });

    const { version: rawVersion } = await context.params;
    // A typo in the URL is a 400, not a NaN query.
    const parsedVersion = z.coerce.number().int().positive().safeParse(rawVersion);
    if (!parsedVersion.success) {
      throw new AppError("INVALID_INPUT", {
        message: `Invalid prompt version in the activate URL: ${String(rawVersion)}`,
        userMessage: "Số phiên bản prompt không hợp lệ.",
        context: {
          route: ROUTE,
          issues: [{ path: "version", message: "Số phiên bản prompt không hợp lệ." }],
        },
      });
    }

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });

    const template = await container.usecases.promptTemplates.activateVersion({
      tenantId: ctx.tenantId,
      task: body.task,
      platform: body.platform,
      version: parsedVersion.data,
    });

    container.logger.info("Prompt template version activated from the operator UI", {
      route: ROUTE,
      tenant_id: ctx.tenantId,
      task: body.task,
      platform: body.platform,
      prompt_template_id: template.id,
      prompt_version: template.version,
      actor_email: session.email,
      actor_role: ctx.role,
    });

    return Response.json(template);
  } catch (error) {
    return mapAppErrorToHttp(withVariableIssues(error), { logger, context: { route: ROUTE } });
  }
}
