"use client";

import { LinkProvider, Theme } from "@astryxdesign/core";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { AppLink } from "@/ui/components/shell/AppLink";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useActiveTenant, useMe } from "@/ui/hooks/useMe";
import {
  useCompleteOnboarding,
  useOnboardingProfile,
  useSaveOnboardingStep,
} from "@/ui/hooks/useOnboardingProfile";
import { useSetupProgress } from "@/ui/hooks/useSetupProgress";
import { buildStepViews } from "@/ui/components/onboarding/setup-steps";
import { ASTRYX_LOCALE, ASTRYX_VI } from "@/ui/i18n/astryx-vi";
import type {
  FocusChannel,
  OnboardingProfilePatch,
  SellerKind,
  ToolKind,
} from "@/ui/schemas/onboarding-profile.schema";
import { ApiError } from "@/ui/services/api-error";
import { myspTheme } from "@/ui/theme/mysp";

import { CelebrateScreen } from "./CelebrateScreen";
import { OnboardingFrame, type FlowDirection } from "./OnboardingFrame";
import { StepChannels } from "./StepChannels";
import { StepCount } from "./StepCount";
import { StepSeller } from "./StepSeller";
import { StepTools } from "./StepTools";
import { WelcomeScreen } from "./WelcomeScreen";
import {
  answeredScreens,
  EMPTY_ANSWERS,
  isAlreadyStored,
  stepPatch,
  type SurveyAnswers,
} from "./onboarding-answers";
import { decideCelebrate } from "./celebrate-stage";
import {
  nextScreen,
  previousScreen,
  resolveScreen,
  screenStep,
  type OnboardingScreen,
  type OnboardingStage,
} from "./onboarding-steps";
import { useCelebrateHandoff } from "./useCelebrateHandoff";
import { usePassedSlides } from "./usePassedSlides";

/**
 * HOW MANY NEXT STEPS THE CELEBRATION LISTS. Three is a list; six is a chore,
 * and the dock in the app carries the full six anyway.
 */
const CELEBRATE_NEXT_STEP_LIMIT = 3;

/**
 * The reading order of the flow, WITH the celebration on the end.
 *
 * `screenStep` stays a function of the four questions — it is what the position
 * dots read, and a fifth position would mean a fifth dot. This is the other
 * thing an order is needed for: which way the screen change travels.
 */
function stageOrder(stage: OnboardingStage): number {
  return stage === "celebrate" ? 5 : screenStep(stage);
}

/**
 * The survey flow itself.
 *
 * It holds no idea of "which step am I on". The URL carries an intent, the
 * ANSWERS ON THE SERVER carry the truth, `resolveScreen` reconciles them —
 * which is why closing the tab mid-survey and coming back reopens the pending
 * question with the earlier answers intact (spec §7.6, §8).
 *
 * EVERY STEP SAVES WHEN IT IS LEFT, not at the end. Three consequences worth
 * naming, because each one is a bug if it is got wrong:
 *   - "Bỏ qua" writes `null`. It is a DECISION, not silence, and `null` is not
 *     `[]` — see `onboarding-answers.ts`;
 *   - a failed save does NOT advance the flow. The choice stays on screen and
 *     the notice offers "Thử lại". Silently moving on would lose an answer the
 *     operator watched themselves give;
 *   - a step whose answer already matches the stored one costs no request.
 *
 * WHAT LIVES IN LOCAL STATE AND WHY: only the answers touched in THIS session
 * ("draft"), overlaid on what the server holds. It is not a copy of the profile
 * — copying it would need an effect to seed, and the seed would race the fetch.
 * A key present in the draft wins; a key absent falls through to the row.
 */

/** One press of "Tiếp tục" or "Bỏ qua", kept whole so "Thử lại" can repeat it. */
interface StepAttempt {
  readonly screen: OnboardingScreen;
  /** `null` on the greeting: it asks nothing, so it writes nothing. */
  readonly patch: OnboardingProfilePatch | null;
}

export function OnboardingFlow({
  // The welcome screen is the only one that shows it, and `src/ui` may not
  // import `src/app`, so the Server Action arrives as a prop.
  signOutAction,
}: {
  signOutAction?: () => Promise<void>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const me = useMe();
  const { isResolved, role, tenantId, tenantKey } = useActiveTenant();
  const { passed, markPassed } = usePassedSlides();

  const profileQuery = useOnboardingProfile();
  const saveStep = useSaveOnboardingStep();
  const finish = useCompleteOnboarding();
  const profile = profileQuery.data;

  /**
   * The answers touched in this session. `Partial`, and the difference between
   * "key absent" and "key present holding null" is load-bearing: absent means
   * "the stored answer still stands", null means "Bỏ qua just cleared it".
   */
  const [draft, setDraft] = useState<Partial<SurveyAnswers>>({});
  /** The write that failed, kept so the retry repeats exactly it. */
  const [failedAttempt, setFailedAttempt] = useState<StepAttempt | null>(null);

  // --- Edge case: this flow is not for every role --------------------------
  // The survey describes the tenant, so only an owner or an admin answers it —
  // and all three verbs behind it answer 403 to anyone else. The check happens
  // before the position is derived, not after.
  const isAllowedRole = role === "owner" || role === "admin";
  useEffect(() => {
    if (isResolved && !isAllowedRole) router.replace("/overview");
  }, [isResolved, isAllowedRole, router]);

  /**
   * WAS THE SURVEY ALREADY CLOSED WHEN THIS SCREEN OPENED?
   *
   * The whole difference between congratulating somebody and bouncing them
   * straight into the app, and it is deliberately TWO SNAPSHOTS OF ONE FIELD
   * rather than a flag somebody has to remember to raise.
   *
   * The obvious shape was a latch set inside `runAttempt` — and it has a trap
   * in it sharp enough to be worth the paragraph. `finish.mutateAsync()` runs
   * its `onSuccess` INSIDE the await, and that handler writes `completedAt`
   * into the React Query cache, which renders. A latch raised on the line after
   * the await is therefore raised one render too late: by then the flow has
   * already decided there was nothing to celebrate and navigated away. It
   * throws nothing, it fails intermittently, and no node-env test can reach it.
   *
   * Comparing `completed_at` on arrival with `completed_at` now has no such
   * window: both come from the same query, and nothing has to happen in the
   * right order for the comparison to be true.
   *
   * ADJUSTED DURING RENDER, which is React's supported shape for "state derived
   * from a prop that changed" and is what `direction` below and `StepActions`
   * already use. An effect would commit one render with the value still unread.
   */
  const [completedAtOnArrival, setCompletedAtOnArrival] = useState<
    string | null | undefined
  >(undefined);
  if (completedAtOnArrival === undefined && profile !== undefined) {
    setCompletedAtOnArrival(profile.completedAt);
  }

  const completedAt = profile?.completedAt ?? null;

  const decision = decideCelebrate({
    completedAt,
    completedAtOnArrival,
    hasHandedOff: false,
  });

  const handoff = useCelebrateHandoff({
    isCelebrating: decision === "celebrate",
    tenantKey,
  });

  /**
   * The same question again, now that the handoff can answer for itself.
   *
   * TWO CALLS RATHER THAN A REORDER, because the two things genuinely depend on
   * each other: the handoff's timers only run while the celebration is up, and
   * the celebration ends when the handoff says it has begun. The first call is
   * the celebration BEFORE anything has handed off — which is exactly the
   * window those timers live in — and the second is the final answer. The
   * function is pure, so asking it twice costs nothing and reads honestly.
   */
  const stageDecision = decideCelebrate({
    completedAt,
    completedAtOnArrival,
    hasHandedOff: handoff.hasHandedOff,
  });

  /**
   * Out. `completed_at` is the single thing that decides the flow is over (spec
   * §8), so a tenant that skipped all four questions is as finished as one that
   * answered them — but WHEN it leaves now has one more input, and that is what
   * `decideCelebrate` holds.
   *
   * THIS IS STILL THE FLOW'S ONLY WAY OUT. The celebration does not navigate;
   * it raises `hasHandedOff` and this effect does what it has always done. Two
   * places calling `router.replace` would be two navigations landing on top of
   * each other, and the second one is the kind that leaves the history stack
   * with a dead entry in it.
   *
   * Latched, because leaving happens once: the replace is already in flight
   * while this component keeps rendering.
   */
  const hasLeft = useRef(false);
  useEffect(() => {
    if (stageDecision !== "leave" || hasLeft.current) return;
    hasLeft.current = true;
    router.replace("/overview");
  }, [stageDecision, router]);

  /**
   * The draft over the row. `!== undefined` and not `??`: `null` is a real
   * answer here ("Bỏ qua"), and `??` would let the stored value come back.
   */
  const answers: SurveyAnswers = {
    sellerKind:
      draft.sellerKind !== undefined
        ? draft.sellerKind
        : (profile?.sellerKind ?? null),
    currentTools:
      draft.currentTools !== undefined
        ? draft.currentTools
        : (profile?.currentTools ?? null),
    channelCount:
      draft.channelCount !== undefined
        ? draft.channelCount
        : (profile?.channelCount ?? null),
    focusChannels:
      draft.focusChannels !== undefined
        ? draft.focusChannels
        : (profile?.focusChannels ?? null),
  };

  /**
   * Where the flow reopens. TWO sources, and neither is enough alone:
   *   - the stored row, which survives a closed tab but cannot record a skip
   *     (a skipped question stores `null`, same as one never reached);
   *   - the session note, which records the skip but dies with the tab.
   */
  const answered: Partial<Record<OnboardingScreen, boolean>> =
    answeredScreens(profile);
  for (const id of passed) answered[id] = true;

  // Trimmed to null: a whitespace-only display name is not a name, and would
  // render "Chào  👋" with a hole in it.
  const trimmedName = me.data?.account?.displayName?.trim() ?? "";
  const displayName = trimmedName.length > 0 ? trimmedName : null;

  const current = resolveScreen({
    requested: searchParams.get("step"),
    answered,
    hasStarted: passed.includes("welcome"),
  });

  /**
   * WHICH WAY THE FLOW JUST MOVED, for the frame to slide the screens by
   * (animation spec section 6: forward comes in from the right, back from the
   * left).
   *
   * DERIVED FROM THE POSITIONS, NOT FROM `goBack`. Setting a flag inside
   * `goBack` would be the obvious way and it would be wrong for the case that
   * actually happens: the browser's own Back button changes `?step=` without
   * going anywhere near this component's handlers, so the flow would slide
   * FORWARDS while going backwards. Comparing where the screen was with where
   * it is answers for every cause — the arrow, the browser, a typed URL.
   *
   * Adjusted during render rather than in an effect, which is the supported
   * shape for "state derived from a prop that changed": an effect would commit
   * the new screen with the OLD direction first, and the slide would be wrong
   * for one frame every time.
   */
  /**
   * WHAT IS ON SCREEN — the four questions plus the celebration.
   *
   * `current` is where the SURVEY is, and `resolveScreen` owns that: a pure
   * function of the URL and of which questions carry an answer. The celebration
   * is not in that function's world at all — it is not reachable by URL, it
   * cannot be resolved back to from `?step=`, and it exists only because a
   * mutation succeeded a moment ago. So it is layered on top here rather than
   * smuggled into the resolver.
   */
  const stage: OnboardingStage =
    decision === "celebrate" ? "celebrate" : current;

  const [previousRenderedStage, setPreviousRenderedStage] =
    useState<OnboardingStage>(stage);
  const [direction, setDirection] = useState<FlowDirection>(1);
  if (previousRenderedStage !== stage) {
    setPreviousRenderedStage(stage);
    // `stageOrder` is 0 on the greeting, 1..4 on the questions and 5 on the
    // celebration, i.e. the reading order of the whole flow. The last step
    // forward is `channels` → `celebrate`, and it has to travel like every
    // other step forward or the end of the flow reads as a glitch.
    setDirection(
      stageOrder(stage) >= stageOrder(previousRenderedStage) ? 1 : -1,
    );
  }

  const goTo = useCallback(
    (target: OnboardingScreen) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("step", target);
      // Drop the one-shot OAuth outcome so a refresh does not re-announce it.
      params.delete("google");
      params.delete("connect");
      params.delete("reason");
      /**
       * PUSH, NOT REPLACE. `web-wizard` section 1: "Chuyển bước dùng push (back
       * quay lui một bước), không dùng replace". With `replace` the browser's
       * Back button left the flow altogether instead of stepping back one
       * question — a wizard whose Back button escapes the wizard.
       */
      router.push(`/onboarding?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  /**
   * Leave a step: write its answer, note it as passed, then move.
   *
   * The order matters. Nothing advances until the write lands, because a step
   * that moved on before its answer was stored is exactly the failure this task
   * exists to remove — and on the last step "advance" means `completed_at`,
   * which must never be stamped over an answer that did not save.
   */
  const runAttempt = useCallback(
    async (attempt: StepAttempt) => {
      try {
        // A step whose answer is already the stored one costs no request: back
        // and forward through an answered flow would otherwise be four
        // round trips and four spinners saving nothing.
        if (
          attempt.patch !== null &&
          !isAlreadyStored(attempt.patch, profile)
        ) {
          await saveStep.mutateAsync(attempt.patch);
        }

        markPassed(attempt.screen);
        setFailedAttempt(null);

        const target = nextScreen(attempt.screen);
        if (target === "done") {
          /*
            THE LAST STEP. Finishing writes `completed_at` into the cache, and
            that write is ALL it takes: `completedAtOnArrival` was captured when
            this screen opened, so the moment the two disagree the flow is on
            the celebration. Nothing here has to raise a flag at the right
            moment — see the note on `completedAtOnArrival` for the version that
            did, and for why it could not be made reliable.
          */
          await finish.mutateAsync();
          return;
        }
        goTo(target);
      } catch (error) {
        /**
         * NOT swallowed, and the flow does NOT advance. The attempt is kept so
         * "Thử lại" repeats exactly this write, the mutation keeps the error
         * for the notice, and the operator's choice stays on screen.
         */
        console.error("[onboarding] could not save the survey step", {
          error_code: ApiError.is(error) ? error.code : "UNKNOWN",
          status: ApiError.is(error) ? error.status : undefined,
          tenant_id: tenantId,
          step: attempt.screen,
          fields: attempt.patch ? Object.keys(attempt.patch) : [],
          error: error instanceof Error ? error.message : String(error),
        });
        setFailedAttempt(attempt);
      }
    },
    [finish, goTo, markPassed, profile, saveStep, tenantId],
  );

  /*
    Destructured before the callbacks below depend on them: `answers` is a new
    object every render, so a callback that listed it would be rebuilt every
    render too. The four VALUES are what actually decide anything.
  */
  const { sellerKind, currentTools, channelCount, focusChannels } = answers;

  const advance = useCallback(() => {
    void runAttempt({
      screen: current,
      patch: stepPatch(current, {
        sellerKind,
        currentTools,
        channelCount,
        focusChannels,
      }),
    });
  }, [
    channelCount,
    current,
    currentTools,
    focusChannels,
    runAttempt,
    sellerKind,
  ]);

  /**
   * "Bỏ qua" is a decision, not an absence (spec §7.2): it CLEARS the answer
   * for the step being left and moves on. Clearing matters twice over — a card
   * ticked and then skipped must not be stored as if it had been confirmed, and
   * must not be ticked again when the back arrow returns here.
   *
   * `stepPatch(current, EMPTY_ANSWERS)` is `{<field>: null}` — one key, never
   * the empty object the route refuses with 400.
   */
  const skip = useCallback(() => {
    const cleared = stepPatch(current, EMPTY_ANSWERS);
    if (cleared !== null) setDraft((previous) => ({ ...previous, ...cleared }));
    void runAttempt({ screen: current, patch: cleared });
  }, [current, runAttempt]);

  const setSellerKind = useCallback((value: SellerKind) => {
    setDraft((previous) => ({ ...previous, sellerKind: value }));
  }, []);

  const setChannelCount = useCallback(
    (value: SurveyAnswers["channelCount"]) => {
      setDraft((previous) => ({ ...previous, channelCount: value }));
    },
    [],
  );

  const toggleTool = useCallback(
    (value: ToolKind, isChecked: boolean) => {
      const chosen = currentTools ?? [];
      // Guard against a double-add: `onToggle` fires per change, but a repeated
      // "checked" would otherwise send the same code twice in the PATCH body.
      const next = isChecked
        ? chosen.includes(value)
          ? chosen
          : [...chosen, value]
        : chosen.filter((tool) => tool !== value);
      setDraft((previous) => ({ ...previous, currentTools: next }));
    },
    [currentTools],
  );

  /** Same shape as `toggleTool`, and same reason for the duplicate guard. */
  const toggleChannel = useCallback(
    (value: FocusChannel, isChecked: boolean) => {
      const chosen = focusChannels ?? [];
      const next = isChecked
        ? chosen.includes(value)
          ? chosen
          : [...chosen, value]
        : chosen.filter((channel) => channel !== value);
      setDraft((previous) => ({ ...previous, focusChannels: next }));
    },
    [focusChannels],
  );

  const goBack = useCallback(() => {
    const target = previousScreen(current);
    if (target) goTo(target);
  }, [current, goTo]);

  /**
   * Four states, as every screen owes (core-feedback-states). "Empty" is not
   * one of them here: a tenant who answered nothing IS the survey's normal
   * case, and it renders the first question rather than an empty message.
   */
  const isReadingProfile =
    isAllowedRole && profile === undefined && !profileQuery.isError;
  const isWaiting = !isResolved || isReadingProfile;
  // Under 300ms nothing is shown at all — a flashed line reads as a glitch.
  const showWaiting = useDelayedFlag(isWaiting);

  const isSaving = saveStep.isPending || finish.isPending;
  const attemptError = saveStep.error ?? finish.error;

  /**
   * THE THREE THINGS TO DO NEXT, for the celebration to point at.
   *
   * Read through `useSetupProgress` — the same query `SetupDock` reads in the
   * app — so the list the operator sees here and the list the dock shows them
   * a second later are the same list, from the same source, in the same words.
   * That continuity is what makes the handoff feel like one movement rather
   * than two screens.
   *
   * NO STATE OF ITS OWN, AND NO ERROR BRANCH. An empty array is a perfectly
   * good answer: the query may not have come back, or may have failed, and the
   * celebration is still true without it. `CelebrateScreen` draws nothing for
   * an empty list, and the way into the app never depends on it.
   */
  const setupProgress = useSetupProgress();
  const nextSteps =
    setupProgress.data === undefined
      ? []
      : buildStepViews(setupProgress.data)
          .filter((step) => step.state !== "done")
          .slice(0, CELEBRATE_NEXT_STEP_LIMIT);

  /**
   * One screen at a time. Each of them brings its OWN <h1> — that is what
   * `OnboardingFrame` moves focus to when the step changes — and each takes its
   * answer and its handlers as props, so none of them touches the router.
   */
  function renderScreen() {
    // The celebration is not one of `resolveScreen`'s answers, so it is asked
    // about first rather than folded into the switch below.
    if (stage === "celebrate") {
      return (
        <CelebrateScreen
          name={displayName}
          nextSteps={nextSteps}
          secondsLeft={handoff.secondsLeft}
          isLeaving={handoff.isLeaving}
          onEnter={handoff.enterApp}
          onInteract={handoff.cancelCountdown}
        />
      );
    }

    switch (current) {
      case "welcome":
        return (
          <WelcomeScreen
            // `/api/me` has `account.displayName`, nullable, and no email at
            // all — see PENDING(welcome-name) inside `WelcomeScreen`. A blank
            // name is the same as no name: it must not render "Chào  👋".
            name={displayName}
            onStart={advance}
          />
        );
      case "seller":
        return (
          <StepSeller
            value={sellerKind}
            onChange={setSellerKind}
            onContinue={advance}
            onSkip={skip}
            isSaving={isSaving}
          />
        );
      case "tools":
        return (
          <StepTools
            values={currentTools ?? []}
            onToggle={toggleTool}
            onContinue={advance}
            onSkip={skip}
            isSaving={isSaving}
          />
        );
      case "count":
        return (
          <StepCount
            value={channelCount}
            onChange={setChannelCount}
            onContinue={advance}
            onSkip={skip}
            isSaving={isSaving}
          />
        );
      case "channels":
        return (
          <StepChannels
            values={focusChannels ?? []}
            onToggle={toggleChannel}
            onContinue={advance}
            onSkip={skip}
            isSaving={isSaving}
          />
        );
    }
  }

  function renderStage(): ReactNode {
    // --- Loading: the session, then the answers ----------------------------
    if (isWaiting) {
      return (
        <div className="grid min-h-dvh place-items-center px-6">
          {showWaiting ? (
            <p role="status" className="text-muted-foreground text-sm">
              Đang mở phần giới thiệu…
            </p>
          ) : null}
        </div>
      );
    }

    // The redirect out is already in flight (wrong role, or already finished).
    if (!isAllowedRole || stageDecision === "leave") return null;

    // --- Error: without the answers we cannot know which question is open ---
    // Restarting from the greeting would re-ask questions this tenant may have
    // answered weeks ago, so the flow says so instead of guessing.
    if (profile === undefined) {
      return (
        <div className="grid min-h-dvh place-items-center px-6">
          <div className="w-full max-w-[34rem]">
            <ApiErrorNotice
              error={profileQuery.error}
              onRetry={() => void profileQuery.refetch()}
              source="Khảo sát ban đầu"
            />
          </div>
        </div>
      );
    }

    // --- Data --------------------------------------------------------------
    return (
      <OnboardingFrame
        stage={stage}
        direction={direction}
        /*
          NO WAY BACK from either end of the flow. The greeting has nothing
          behind it; the celebration has a `completed_at` behind it, and
          re-opening an answered question after the survey has closed is a dead
          end — `decideCelebrate` would send them straight back out again.
        */
        onBack={
          stage === "welcome" || stage === "celebrate" ? undefined : goBack
        }
      >
        {renderScreen()}
        {/*
          THE FAILED SAVE, under the step that failed. Not a toast: it must stay
          until it is dealt with, and the answer it belongs to is right above it
          (core-feedback-states — a block-level failure is answered inline, with
          a way out). `ApiErrorNotice` withholds the retry for a 4xx, where
          repeating the same request cannot help; the operator changes the
          answer or presses "Bỏ qua" instead.
        */}
        {failedAttempt !== null && attemptError !== null ? (
          <div className="mt-8 w-full max-w-[34rem]">
            <ApiErrorNotice
              error={attemptError}
              onRetry={() => void runAttempt(failedAttempt)}
              source="Lưu câu trả lời"
            />
          </div>
        ) : null}
      </OnboardingFrame>
    );
  }

  const isFlowVisible =
    !isWaiting &&
    isAllowedRole &&
    decision !== "leave" &&
    profile !== undefined;

  /**
   * THE SAME THREE PROVIDERS `AppFrame` wraps the app in, for the same reason
   * `SignInScreen` repeats them: this route group sits OUTSIDE `(app)`, so
   * nothing above it mounts them.
   *
   * Without `<Theme>` every Astryx component rendered here — `ColorSchemeToggle`
   * in the header, the option cards, the error notice — falls back to Astryx's
   * own palette: its blue `--color-accent` instead of Indigo Dye, and the
   * neutral theme's cold near-black instead of Warm Ink. That exact drift was
   * measured on /signin before its wrapper was added.
   *
   * NOTE (spec section 10): `<Theme>` is also what scopes `--color-text-primary`
   * onto the text below it, which is why every string in this flow declares its
   * own colour instead of inheriting one.
   */
  return (
    <LinkProvider component={AppLink}>
      <InternationalizationProvider
        locale={ASTRYX_LOCALE}
        messages={{ [ASTRYX_LOCALE]: ASTRYX_VI }}
      >
        <Theme theme={myspTheme}>
          {renderStage()}
          {/* The flow's own way out, kept for accounts that signed in with the
              wrong Google account: this route has no top bar to sign out from. */}
          {signOutAction && isFlowVisible && stage === "welcome" ? (
            <form
              action={signOutAction}
              className="fixed inset-x-0 bottom-6 z-20 text-center"
            >
              <button
                type="submit"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-6 items-center rounded text-xs underline underline-offset-4 outline-none focus-visible:ring-2"
              >
                Đăng xuất
              </button>
            </form>
          ) : null}
        </Theme>
      </InternationalizationProvider>
    </LinkProvider>
  );
}

/*
 * The stand-in screen and its table of headings lived here until task 8. Both
 * are gone on purpose: every question now owns its own wording, next to the
 * options that wording belongs with, and a second copy of a question is a
 * second thing to reword.
 */
