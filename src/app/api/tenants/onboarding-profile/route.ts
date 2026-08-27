import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { OnboardingProfilePatchSchema } from "@/ui/schemas/onboarding-profile.schema";

/**
 * E10 — the onboarding survey (spec §6/§8), all three verbs on one resource:
 *   GET    read the answers so a half-finished flow reopens where it stopped;
 *   PATCH  save ONE step, the moment "Tiếp tục" is pressed;
 *   POST   finish the survey (stamp `completed_at`). Idempotent.
 *
 * Thin by contract (docs/07 §3.3): authorise, validate, delegate, map errors.
 * Which codes are legal and how a list is normalised is the usecase's, not
 * this file's.
 *
 * WHY THE BODY SCHEMA COMES FROM `@/ui/schemas`: the app layer may only import
 * `@/core/domain/errors` (docs/07 §5, enforced by ESLint + dependency-cruiser),
 * so it cannot reach the four constant lists in the usecase. Importing the
 * mirror the UI already builds its requests from means there are two copies of
 * the vocabulary in the repo, not three — and `route.test.ts` imports both and
 * asserts they are equal.
 *
 * `minRole: "admin"` (doc 10 §4), same stance as `GET /api/tenants/setup-progress`:
 * the survey describes the COMPANY (how it sells, what it posts with), it is
 * answered once by whoever set the company up, and an editor has no business
 * writing it — nor reading it, since the flow it drives is never shown to them.
 * Tier "S": it is answered once per tenant, so a fresh membership read costs
 * nothing worth caching around.
 *
 * PATCH sends an ABSENT key to mean "leave it alone" and `null` to mean "Bỏ
 * qua". An empty `{}` is refused by the schema rather than treated as a no-op:
 * the repo throws on it too, and a silent success here would show up later as
 * an answer that was never stored.
 */

const ROUTE = "/api/tenants/onboarding-profile";

export const dynamic = "force-dynamic";

/** JSON has no date type; the UI schema reads `completedAt` as an ISO string. */
function toWire(profile: {
  sellerKind: string | null;
  currentTools: readonly string[] | null;
  channelCount: string | null;
  focusChannels: readonly string[] | null;
  completedAt: Date | null;
}) {
  return {
    sellerKind: profile.sellerKind,
    currentTools: profile.currentTools,
    channelCount: profile.channelCount,
    focusChannels: profile.focusChannels,
    completedAt: profile.completedAt ? profile.completedAt.toISOString() : null,
  };
}

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { ctx } = await requireTenantContext(request, {
      surface: `api:GET ${ROUTE}`,
      tier: "S",
      minRole: "admin",
    });

    const profile = await container.usecases.getOnboardingProfile({ tenantId: ctx.tenantId });
    return Response.json(toWire(profile));
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: `GET ${ROUTE}` } });
  }
}

export async function PATCH(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // Authorise BEFORE reading the body: an editor gets 403 without the payload
    // ever being parsed.
    const { ctx } = await requireTenantContext(request, {
      surface: `api:PATCH ${ROUTE}`,
      tier: "S",
      minRole: "admin",
    });
    const patch = await readJsonBody(request, OnboardingProfilePatchSchema, {
      route: `PATCH ${ROUTE}`,
    });

    const saved = await container.usecases.saveOnboardingProfile({ tenantId: ctx.tenantId, patch });
    return Response.json(toWire(saved));
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: `PATCH ${ROUTE}` } });
  }
}

/**
 * Finish the survey. No body: there is nothing to say beyond "the operator
 * reached the end", and the answers were already saved step by step.
 *
 * It is POST on the collection rather than `POST .../complete` so the resource
 * stays one route file — the plan's file list names exactly one. Calling it
 * twice is safe: the usecase keeps the first `completed_at`.
 */
export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { ctx } = await requireTenantContext(request, {
      surface: `api:POST ${ROUTE}`,
      tier: "S",
      minRole: "admin",
    });

    const finished = await container.usecases.completeOnboarding({ tenantId: ctx.tenantId });
    return Response.json(toWire(finished));
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: `POST ${ROUTE}` } });
  }
}
