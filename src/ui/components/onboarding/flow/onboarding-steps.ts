import { stepFlag, type SetupProgress, type SetupStepId } from "@/ui/schemas/setup-progress.schema";

/**
 * Where the operator is in the slideshow — a PURE function of the six server
 * flags, never of React state.
 *
 * That is not a style preference. Slide 02 and slide 03 both send the browser
 * away to an OAuth provider; any position held in a component is gone by the
 * time it comes back. The URL carries an INTENT (`?step=`), the server carries
 * the TRUTH, and this file is where the two are reconciled.
 */

export const ONBOARDING_SLIDE_IDS = [
  "company",
  "data",
  "facebook",
  "group",
  "invite",
  "congrats",
] as const;

export type OnboardingSlideId = (typeof ONBOARDING_SLIDE_IDS)[number];

export const SLIDE_TITLES: Record<OnboardingSlideId, string> = {
  company: "Tạo công ty",
  data: "Kết nối dữ liệu",
  facebook: "Kết nối Facebook",
  group: "Tạo nhóm kênh",
  invite: "Mời nhân viên",
  congrats: "Xong rồi",
};

/**
 * Which server flag settles which slide.
 *
 * `data` maps to `source`, not `google`: connecting Drive without pointing at a
 * spreadsheet leaves the tenant with nothing to read, so the slide is only done
 * when the source is chosen.
 *
 * `invite` and `congrats` map to nothing — no flag can ever settle them, which
 * is exactly why `passed` below exists.
 */
const SLIDE_FLAG: Record<OnboardingSlideId, SetupStepId | null> = {
  company: "tenant",
  data: "source",
  facebook: "facebook",
  group: "group",
  invite: null,
  congrats: null,
};

export function isOnboardingSlideId(value: unknown): value is OnboardingSlideId {
  return typeof value === "string" && (ONBOARDING_SLIDE_IDS as readonly string[]).includes(value);
}

export function slideOrdinal(id: OnboardingSlideId): number {
  return ONBOARDING_SLIDE_IDS.indexOf(id) + 1;
}

export interface ResolveSlideInput {
  /** Null until the company exists — the six flags are tenant-scoped. */
  readonly progress: SetupProgress | null;
  /** `?step=` off the URL. An INTENT: it is clamped, never trusted. */
  readonly requested: string | null;
  /**
   * Slides the operator has already walked past, whether by finishing them or
   * by pressing "Để sau". Not "skipped": the invite slide has no server flag,
   * so tracking only refusals would leave the flow stuck on it forever.
   */
  readonly passed: readonly OnboardingSlideId[];
}

function isSettled(
  id: OnboardingSlideId,
  progress: SetupProgress,
  passed: readonly OnboardingSlideId[],
): boolean {
  if (passed.includes(id)) return true;
  const flag = SLIDE_FLAG[id];
  return flag !== null && stepFlag(progress, flag);
}

export function resolveSlide({ progress, requested, passed }: ResolveSlideInput): OnboardingSlideId {
  // --- Edge cases first ----------------------------------------------------
  // No company: every other slide talks to a tenant-scoped API that answers 409.
  if (!progress) return "company";

  const firstOpen =
    ONBOARDING_SLIDE_IDS.find((id) => !isSettled(id, progress, passed)) ?? "congrats";

  if (!isOnboardingSlideId(requested)) return firstOpen;

  // Going BACK is allowed — reviewing a finished slide costs nothing. Going
  // FORWARD past unfinished work is not: the slide would render controls whose
  // prerequisites do not exist yet.
  const isBehind =
    ONBOARDING_SLIDE_IDS.indexOf(requested) <= ONBOARDING_SLIDE_IDS.indexOf(firstOpen);

  return isBehind ? requested : firstOpen;
}

export function nextSlide(current: OnboardingSlideId): OnboardingSlideId {
  const index = ONBOARDING_SLIDE_IDS.indexOf(current);
  return ONBOARDING_SLIDE_IDS[Math.min(index + 1, ONBOARDING_SLIDE_IDS.length - 1)]!;
}

export function previousSlide(current: OnboardingSlideId): OnboardingSlideId | null {
  const index = ONBOARDING_SLIDE_IDS.indexOf(current);
  return index <= 0 ? null : ONBOARDING_SLIDE_IDS[index - 1]!;
}
