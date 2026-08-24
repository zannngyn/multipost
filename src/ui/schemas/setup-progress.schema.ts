import { z } from "zod";

/**
 * Contract of `GET /api/tenants/setup-progress` — the six first-run flags.
 *
 * NOTE: `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so
 * this MIRRORS `core/usecases/get-setup-progress.ts`. Any change to the step
 * set there must be reflected here, and the route test is what would catch the
 * two drifting apart.
 */

export const SETUP_STEP_IDS = [
  "tenant",
  "google",
  "source",
  "facebook",
  "group",
  "firstPost",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/**
 * `requiredCount` is `min(1)`, not `min(0)`: the progress bar divides by it,
 * and a zero arriving from a broken deploy would render `Infinity%` rather
 * than an error the operator can report.
 */
export const SetupProgressSchema = z.object({
  tenantId: z.string().min(1),
  steps: z.array(z.object({ id: z.enum(SETUP_STEP_IDS), isDone: z.boolean() })),
  doneCount: z.number().int().min(0),
  requiredCount: z.number().int().min(1),
  isReady: z.boolean(),
});

export type SetupProgress = z.infer<typeof SetupProgressSchema>;

/** One step by id. A step the payload omits reads as NOT done, never as true. */
export function stepFlag(progress: SetupProgress, id: SetupStepId): boolean {
  return progress.steps.find((step) => step.id === id)?.isDone ?? false;
}

/**
 * Every step, the goal included — the dock disappears on this and nothing else.
 *
 * `doneCount === requiredCount` is deliberately NOT enough: that means "wired
 * up", while the dock keeps pointing at "Đăng bài đầu tiên" until a post has
 * actually gone out. A tenant that is configured but has never published is
 * exactly the one that still needs the pointer.
 */
export function isSetupFinished(progress: SetupProgress): boolean {
  return SETUP_STEP_IDS.every((id) => stepFlag(progress, id));
}
