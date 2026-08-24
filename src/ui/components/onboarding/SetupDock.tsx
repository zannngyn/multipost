"use client";

import { Check, ChevronRight, Lock, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { cn } from "@/shared/utils";
import { useSetupDockState } from "@/ui/hooks/useSetupDockState";
import { useSetupProgress } from "@/ui/hooks/useSetupProgress";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { isSetupFinished, type SetupProgress } from "@/ui/schemas/setup-progress.schema";

import { buildStepViews, SETUP_STEP_PRESENTATION } from "./setup-steps";

/**
 * "Còn mấy bước nữa?" — the standing pointer in the bottom-right corner.
 *
 * It rides in the app shell rather than on one screen, because the thing it is
 * for happens ACROSS screens: an operator sent to /sync to connect Drive has no
 * way back to the list they were working through, and the next step lives on a
 * different screen again. So the list follows them.
 *
 * It answers for itself whether it should exist at all — no screen has to know
 * about it. It renders nothing when the query is disabled (editor/viewer, or no
 * company yet), while it is loading, when it failed, and once every step is
 * done. Four silences, all deliberate: a dock that shows an error about
 * onboarding to somebody who is already working is noise, and the honest
 * fallback is the screens themselves, which report their own failures.
 *
 * MOTION (docs: overview screen's contract — one event at a time, settled
 * things stand still): the panel arrives once from the bottom; the bar glides
 * to a new value; a step that JUST finished flashes green once and stops. The
 * only looping thing is the ring around the current step, which is the one
 * place the operator is being asked to look. All of it `motion-safe:`.
 */

/** How long a newly-finished row stays lit. Long enough to catch the eye, once. */
const FLASH_MS = 1_600;

export function SetupDock() {
  const { tenantKey } = useActiveTenant();
  const query = useSetupProgress();
  const { state, setState } = useSetupDockState(tenantKey);

  const progress = query.data;

  // --- Four silences, edge cases first --------------------------------------
  // `isPending` covers the disabled query too (a query that never runs stays
  // pending forever), which is exactly right: nothing to say, so say nothing.
  if (query.isPending || query.isError || !progress) return null;
  if (isSetupFinished(progress)) return null;

  return state === "collapsed" ? (
    <DockPill progress={progress} onExpand={() => setState("expanded")} />
  ) : (
    <DockPanel progress={progress} onCollapse={() => setState("collapsed")} />
  );
}

/**
 * Shared frame: same corner, same stacking, same safe-area inset.
 *
 * `isInline` drops the fixed positioning so the dev preview can show the dock
 * in the flow of a gallery page instead of pinned over it — the same escape
 * hatch Astryx's own Dialog offers, for the same reason.
 */
function DockAnchor({ children, isInline }: { children: React.ReactNode; isInline?: boolean }) {
  if (isInline) {
    return (
      <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-300 inline-block">
        {children}
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 flex justify-end pb-[env(safe-area-inset-bottom)] print:hidden">
      <div className="pointer-events-auto motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-300">
        {children}
      </div>
    </div>
  );
}

/**
 * The dock counts the rows it SHOWS — all six, the goal included.
 *
 * `progress.requiredCount` is five (the goal is not a setup step) and the
 * checklist on the overview is right to use it: it says "x/5 bước bắt buộc"
 * beside a progress bar that is about being configured. But the dock displays
 * six rows and prints a fraction over them, so counting the remainder against
 * five made it say "01 / 06" and "Còn 4 bước nữa" in the same breath — two
 * numbers, two denominators, one visible contradiction.
 */
function tallyOf(progress: SetupProgress): {
  done: number;
  total: number;
  remaining: number;
  percent: number;
} {
  const total = progress.steps.length;
  const done = progress.steps.filter((step) => step.isDone).length;
  return {
    done,
    total,
    remaining: Math.max(0, total - done),
    // `total || 1`: a payload with no steps must not divide by zero. The schema
    // makes it unlikely; a NaN width in the DOM is not worth the risk.
    percent: Math.min(100, Math.round((done / (total || 1)) * 100)),
  };
}

/** Estimate per step, keyed by id — the dock's right-hand slot. */
const MINUTES_BY_STEP = new Map(
  SETUP_STEP_PRESENTATION.map((step) => [step.id, step.minutes] as const),
);

// --- Collapsed ---------------------------------------------------------------

/**
 * Exported for the dev preview page: a pure function of `progress`, so the
 * gallery can show every shape without a session, a company or a live query.
 */
export function DockPill({
  progress,
  onExpand,
  isInline,
}: {
  progress: SetupProgress;
  onExpand: () => void;
  isInline?: boolean;
}) {
  const { done, remaining, percent } = tallyOf(progress);

  return (
    <DockAnchor isInline={isInline}>
      <button
        type="button"
        onClick={onExpand}
        className={cn(
          "group bg-foreground text-background flex items-center gap-2.5 rounded-full py-2 pr-4 pl-2 shadow-lg",
          "focus-visible:ring-warning/60 outline-none focus-visible:ring-3",
          "motion-safe:transition-transform motion-safe:duration-200 motion-safe:hover:-translate-y-0.5",
        )}
      >
        {/* A ring is the whole progress bar at this size — the number inside is
            what it means, so the shape never has to be decoded on its own. */}
        <span
          className="relative grid size-7 shrink-0 place-items-center rounded-full"
          style={{
            background: `conic-gradient(var(--warning) ${percent}%, color-mix(in oklch, var(--background) 25%, transparent) 0)`,
          }}
        >
          <span className="bg-foreground text-background grid size-5 place-items-center rounded-full font-mono text-[10px] font-semibold">
            {done}
          </span>
        </span>
        <span className="text-xs font-medium whitespace-nowrap">
          {remaining > 0 ? `Còn ${remaining} bước thiết lập` : "Đăng bài đầu tiên"}
        </span>
      </button>
    </DockAnchor>
  );
}

// --- Expanded ----------------------------------------------------------------

/** Exported for the dev preview page — see `DockPill`. */
export function DockPanel({
  progress,
  onCollapse,
  isInline,
}: {
  progress: SetupProgress;
  onCollapse: () => void;
  isInline?: boolean;
}) {
  const steps = buildStepViews(progress);
  const { done, total, remaining, percent } = tallyOf(progress);

  /**
   * Which rows JUST turned done. Derived by comparing against the previous
   * render's set — the React-endorsed "adjust state during render" pattern
   * rather than an effect, so the flash is decided in the same paint that
   * shows the new value instead of one frame later.
   */
  const doneKey = steps
    .filter((step) => step.state === "done")
    .map((step) => step.id)
    .join(",");
  const [seenDoneKey, setSeenDoneKey] = useState(doneKey);
  const [flashing, setFlashing] = useState<readonly string[]>([]);

  if (seenDoneKey !== doneKey) {
    const before = new Set(seenDoneKey ? seenDoneKey.split(",") : []);
    setSeenDoneKey(doneKey);
    setFlashing(doneKey ? doneKey.split(",").filter((id) => !before.has(id)) : []);
  }

  useEffect(() => {
    if (flashing.length === 0) return;
    // Settled things stand still: the light goes out on its own.
    const timer = setTimeout(() => setFlashing([]), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashing]);

  /** The step the operator is being pointed at — the only pulsing thing here. */
  const currentId = steps.find((step) => step.state === "current")?.id ?? null;

  return (
    <DockAnchor isInline={isInline}>
      <section
        aria-label="Tiến trình thiết lập công ty"
        className="bg-foreground text-background w-[min(21rem,calc(100vw-2rem))] overflow-hidden rounded-xl shadow-xl"
      >
        {/* Head: what this is, where it has got to, and the way out */}
        <header className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
          <div className="min-w-0">
            <p className="text-background/55 font-mono text-[10px] tracking-[0.18em] uppercase">
              Thiết lập
            </p>
            {/*
              `text-background` stated, not inherited. Astryx's `Theme` scopes
              `--color-text-primary` (= `--foreground`) onto text elements
              inside the app shell — the same warm near-black this panel uses as
              its BACKGROUND — so this heading was invisible in the real app
              while looking fine on the dev preview page, which renders outside
              that scope. Nothing on a dark surface here may inherit its colour.
            */}
            <h2 className="text-background mt-1 truncate text-sm font-semibold">
              {remaining > 0 ? `Còn ${remaining} bước nữa` : "Đăng bài đầu tiên"}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-background/55 font-mono text-[11px] tabular-nums">
              {String(done).padStart(2, "0")} / {String(total).padStart(2, "0")}
            </span>
            <button
              type="button"
              onClick={onCollapse}
              // Collapse, not dismiss: the list is the only place the remaining
              // steps are gathered, so it must always be one click away again.
              aria-label="Thu gọn bảng thiết lập"
              className="text-background/60 hover:bg-background/10 hover:text-background focus-visible:ring-warning/60 grid size-6 place-items-center rounded outline-none focus-visible:ring-2"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* The bar: glides, never jumps — a count that changed settling in */}
        <div className="px-4 pb-3">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            aria-valuetext={`${done} trên ${total} bước đã xong`}
            className="bg-background/15 h-1 w-full overflow-hidden rounded-full"
          >
            <div
              className="bg-warning h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        {/* The six rows */}
        <ul className="px-1.5 pb-1">
          {steps.map((step) => {
            const isDone = step.state === "done";
            const isCurrent = step.id === currentId;
            const isLocked = step.state === "locked";
            const isFlashing = flashing.includes(step.id);

            return (
              <li key={step.id}>
                <Link
                  href={step.href}
                  aria-describedby={isLocked ? `${step.id}-reason` : undefined}
                  className={cn(
                    "group flex items-center gap-3 rounded-lg px-2.5 py-2 outline-none",
                    "focus-visible:ring-warning/60 focus-visible:ring-2",
                    "motion-safe:transition-colors motion-safe:duration-150",
                    "hover:bg-background/10",
                    isFlashing && "motion-safe:animate-pulse bg-success/25",
                  )}
                >
                  {/* Marker: filled + tick when done, ringed when it is your turn */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-full border",
                      isDone && "bg-warning border-warning text-foreground",
                      isCurrent && "border-warning text-warning",
                      !isDone && !isCurrent && "border-background/30 text-background/30",
                    )}
                  >
                    {isDone ? (
                      <Check className="size-3" strokeWidth={3} />
                    ) : isCurrent ? (
                      <span className="bg-warning size-1.5 rounded-full motion-safe:animate-pulse" />
                    ) : null}
                  </span>

                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[13px]",
                      isDone && "text-background/55",
                      isCurrent && "text-background font-medium",
                      !isDone && !isCurrent && "text-background/70",
                    )}
                  >
                    {step.title}
                  </span>

                  {/*
                    Named Status Rule, sized for the corner. `step.detail` is the
                    FULL lock sentence — printing it in this slot pushed the
                    title out of a 21rem card and spilled the text past the
                    edge. So the visible slot takes a tick, an estimate, or a
                    padlock, and the sentence itself is announced instead: it is
                    written out in full on the checklist behind "Mở đầy đủ",
                    which has the room for it.
                  */}
                  {isLocked ? (
                    <span id={`${step.id}-reason`} className="sr-only">
                      {step.action?.disabledReason}
                    </span>
                  ) : null}

                  <span
                    className={cn(
                      "shrink-0 font-mono text-[11px] tabular-nums",
                      isDone ? "text-warning" : "text-background/40",
                    )}
                  >
                    {isDone ? (
                      "✓"
                    ) : isLocked ? (
                      <Lock className="size-3" aria-hidden="true" />
                    ) : (
                      `${MINUTES_BY_STEP.get(step.id) ?? 1} ph`
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>

        <footer className="border-background/10 flex items-center justify-between gap-3 border-t px-4 py-2.5">
          <p className="text-background/45 text-[11px]">Bấm một dòng để mở bước đó.</p>
          <Link
            href="/#thiet-lap"
            className="text-warning hover:text-warning/80 focus-visible:ring-warning/60 flex shrink-0 items-center gap-0.5 rounded text-[11px] font-medium outline-none focus-visible:ring-2"
          >
            Mở đầy đủ
            <ChevronRight className="size-3" aria-hidden="true" />
          </Link>
        </footer>
      </section>
    </DockAnchor>
  );
}
