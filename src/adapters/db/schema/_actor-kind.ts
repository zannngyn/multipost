import { pgEnum } from "drizzle-orm/pg-core";

/**
 * WHO caused a recorded action (doc 10 §5). Shared by `audit_log` and
 * `ai_generation`, hence its own module: `ai_generation` has no business
 * importing the audit table just to reach an enum.
 *
 * The list is CLOSED — adding a member is a change to the permission contract:
 *   user             an operator with a session, `actor_user_id` names them
 *   system           the worker: no session, no membership (publish-post, reapers)
 *   platform_support MYSP staff inside a tenant through a support session
 *   external         a third party acting on our data (Meta's fetcher)
 *
 * It exists because today a reaper's row and a row whose actor could not be
 * resolved look identical: both are `actor_user_id IS NULL`.
 */
export const actorKindEnum = pgEnum("actor_kind", [
  "user",
  "system",
  "platform_support",
  "external",
]);
