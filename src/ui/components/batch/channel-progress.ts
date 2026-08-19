import { formatDurationMs, type BatchChannelProgress } from "@/ui/schemas/post-batch.schema";

/**
 * Pure view rules of the per-channel progress block (E7.5, design §5.9).
 *
 * They live outside the component so the two things that MUST NOT regress can be
 * tested without a DOM: what the progress bar claims, and what the timing line
 * claims. Both are places where a lie is easy to write and hard to notice.
 *
 * The two laws they encode:
 *  - §3.2 a determinate bar exists ONLY where a real count does (the media
 *    upload). Every other step is indeterminate — never a made-up percentage.
 *  - §3.2 a countdown exists ONLY against `waitUntil`, a deadline the system
 *    computed. Everything else gets "đã chạy X", which is measured, not guessed.
 */

export type ProgressBarView =
  | {
      readonly kind: "determinate";
      readonly valueNow: number;
      readonly valueMax: number;
      readonly percent: number;
      readonly valueText: string;
    }
  | { readonly kind: "indeterminate"; readonly valueText: string };

/**
 * A determinate bar needs a countable PAIR. The domain only ever sets the counts
 * on the media upload, so "has counts" is the same test as "is the upload step"
 * — and the screen does not have to know a single stage name to get it right.
 */
export function progressBarView(progress: BatchChannelProgress): ProgressBarView {
  const total = intOrNull(progress?.totalCount);
  const done = intOrNull(progress?.doneCount);
  const label = typeof progress?.label === "string" ? progress.label : "";

  if (total === null || total <= 0 || done === null) {
    return { kind: "indeterminate", valueText: label || "Đang xử lý" };
  }

  const valueNow = Math.min(Math.max(done, 0), total);
  const percent = Math.round((valueNow / total) * 100);
  const item = typeof progress.currentItem === "string" ? progress.currentItem.trim() : "";
  return {
    kind: "determinate",
    valueNow,
    valueMax: total,
    percent,
    valueText: `Đã tải ${valueNow}/${total} ảnh (${percent}%)${item ? ` — ${item}` : ""}`,
  };
}

export type ProgressTimingView =
  /** Counting down to a real deadline (spacing gate, schedule handoff). */
  | { readonly kind: "countdown"; readonly text: string }
  /** The deadline passed and the next step has not started yet. */
  | { readonly kind: "due"; readonly text: string }
  /** No deadline exists — how long the step has been running, measured. */
  | { readonly kind: "elapsed"; readonly text: string };

/**
 * `nowMs` comes from the browser clock (`useNowMs`), which is 0 during server
 * render and before the first tick. That case returns null on purpose: markup
 * carrying a time the browser would immediately disagree with is a hydration
 * mismatch, and an operator loses nothing by seeing the line one tick later.
 */
export function progressTimingView(
  progress: BatchChannelProgress,
  nowMs: number,
): ProgressTimingView | null {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return null;

  const waitUntilMs = msOrNull(progress?.waitUntil);
  if (waitUntilMs !== null) {
    const remaining = waitUntilMs - nowMs;
    if (remaining > 0) return { kind: "countdown", text: `Còn ${formatDurationMs(remaining)}` };
    return { kind: "due", text: "Đã tới hạn — đang chờ hệ thống xử lý" };
  }

  const startedMs = msOrNull(progress?.stageStartedAt);
  if (startedMs === null) return null;
  const elapsed = nowMs - startedMs;
  // A negative elapsed means the two clocks disagree; saying nothing beats
  // saying "đã chạy -3 giây".
  if (elapsed < 0) return null;
  return { kind: "elapsed", text: `Đã chạy ${formatDurationMs(elapsed)}` };
}

export type StepState = "done" | "current" | "upcoming";

/**
 * State of every label on the stepper. A `stepIndex` outside the list (an older
 * screen against a newer server) leaves every step "upcoming" rather than
 * marking a wrong one current.
 */
export function stepStates(stepCount: number, stepIndex: number): readonly StepState[] {
  const count = Number.isInteger(stepCount) && stepCount > 0 ? stepCount : 0;
  const current = Number.isInteger(stepIndex) ? stepIndex : -1;
  return Array.from({ length: count }, (_unused, position) => {
    if (position === current) return "current";
    return position < current ? "done" : "upcoming";
  });
}

/** Spoken state of a step — colour is never the only carrier (a11y). */
export const STEP_STATE_LABELS: Record<StepState, string> = {
  done: "đã xong",
  current: "đang làm",
  upcoming: "chưa tới",
};

function intOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.floor(value);
}

function msOrNull(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
