import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import {
  TargetSchema,
  readTarget,
  withVariableIssues,
} from "@/app/api/prompts/_lib/prompt-route";
import { getContainer } from "@/composition/container";

/**
 * E10.7 — the versioned prompt catalog: list the versions, create a new one.
 * Thin by contract (docs/07 §3.3): validate -> usecase -> map errors.
 *
 * Authorisation (doc 10 §4.3):
 *   - GET  tier R, minimum role **editor** — the list carries the full
 *     `systemPrompt`/`body` of every version (Q8.3 keeps prompt text off a
 *     viewer's screen);
 *   - POST tier S, minimum role **admin** — a version created with
 *     `activate: true` changes every caption the tenant generates afterwards,
 *     so it is ranked with `.../activate`, not below it (Q8.2).
 *
 * Rows are IMMUTABLE by design: there is no PUT/PATCH here, and adding one
 * would break the audit trail (`ai_generation` rows point at a version and its
 * exact text). "Sửa prompt" = POST a new version.
 *
 * The variable whitelist (business rule 2) is enforced INSIDE the usecase, in
 * Vietnamese, naming the offending variables; this route only copies those names
 * into the `issues` field so the form can show them next to the body.
 */

const ROUTE_GET = "GET /api/prompts";
const ROUTE_POST = "POST /api/prompts";

/** Mirrors the limits of `manage-prompt-templates` createSchema. */
const MAX_NAME_LENGTH = 120;
const MAX_CHANGELOG_LENGTH = 2000;
/** A prompt longer than this is a paste accident, not a template. */
const MAX_BODY_LENGTH = 20_000;

const CreateSchema = TargetSchema.extend({
  name: z
    .string({ error: "Phiên bản prompt phải có tên." })
    .trim()
    .min(1, "Phiên bản prompt phải có tên.")
    .max(MAX_NAME_LENGTH, `Tên phiên bản tối đa ${MAX_NAME_LENGTH} ký tự.`),
  systemPrompt: z
    .string({ error: "Thiếu system prompt." })
    .trim()
    .min(1, "Thiếu system prompt.")
    .max(MAX_BODY_LENGTH, "System prompt quá dài."),
  body: z
    .string({ error: "Thiếu nội dung prompt." })
    .trim()
    .min(1, "Thiếu nội dung prompt.")
    .max(MAX_BODY_LENGTH, "Nội dung prompt quá dài."),
  changelog: z
    .string({ error: "Ghi rõ lý do tạo phiên bản này." })
    .trim()
    .min(1, "Ghi rõ lý do tạo phiên bản này.")
    .max(MAX_CHANGELOG_LENGTH, `Ghi chú thay đổi tối đa ${MAX_CHANGELOG_LENGTH} ký tự.`),
  activate: z.boolean().default(false),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first: who is asking, and for which company ---------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE_GET}`,
      tier: "R",
      minRole: "editor",
    });

    const target = readTarget(request, ROUTE_GET);
    const result = await container.usecases.promptTemplates.listVersions({
      tenantId: ctx.tenantId,
      ...target,
    });

    // `tenantId` stays in the response (UI schema requires it) — but it is now
    // the AUTHORISED tenant, not an echo of what the client asked for.
    return Response.json({ tenantId: ctx.tenantId, ...target, ...result });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_GET } });
  }
}

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first: tenant + role decided before the body is read ------
    // The author comes from the SESSION, never from the body: a version is an
    // audit record, and a client must not be able to sign someone else's name.
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE_POST}`,
      tier: "S",
      minRole: "admin",
    });

    const body = await readJsonBody(request, CreateSchema, { route: ROUTE_POST });

    const result = await container.usecases.promptTemplates.createVersion({
      tenantId: ctx.tenantId,
      task: body.task,
      platform: body.platform,
      name: body.name,
      systemPrompt: body.systemPrompt,
      body: body.body,
      changelog: body.changelog,
      activate: body.activate,
      createdBy: session.email,
    });

    container.logger.info("Prompt template version created from the operator UI", {
      route: ROUTE_POST,
      tenant_id: ctx.tenantId,
      task: body.task,
      platform: body.platform,
      prompt_version: result.template.version,
      activated: body.activate,
      warnings: result.warnings.length,
      actor_email: session.email,
      actor_role: ctx.role,
    });

    return Response.json(result, { status: 201 });
  } catch (error) {
    return mapAppErrorToHttp(withVariableIssues(error), {
      logger,
      context: { route: ROUTE_POST },
    });
  }
}
