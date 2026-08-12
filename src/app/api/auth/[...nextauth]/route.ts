import { handlers } from "@/app/_auth/auth";

/**
 * Auth.js endpoints (/api/auth/signin, /callback, /session, /signout...).
 * Public by design — `middleware.ts` lets this prefix through, otherwise the
 * sign-in flow would be blocked by the very guard it is meant to satisfy.
 */
export const dynamic = "force-dynamic";

export const { GET, POST } = handlers;
