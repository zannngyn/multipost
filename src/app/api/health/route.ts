import { mapAppErrorToHttp } from "@/app/api/_lib/http-errors";

/** Liveness probe. Intentionally touches no DB/queue — readiness comes later (E1.x). */
export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    return Response.json({ status: "ok" as const });
  } catch (error) {
    return mapAppErrorToHttp(error, { context: { route: "GET /api/health" } });
  }
}
