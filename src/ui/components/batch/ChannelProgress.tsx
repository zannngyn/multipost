"use client";

import {
  progressBarView,
  progressTimingView,
} from "@/ui/components/batch/channel-progress";
import { ProgressStepper } from "@/ui/components/batch/ProgressStepper";
import { Progress } from "@/ui/components/ui/progress";
import { useNowMs } from "@/ui/hooks/useNowMs";
import type { BatchChannelProgress } from "@/ui/schemas/post-batch.schema";

/**
 * "Bài này đang ở bước nào, đi được bao nhiêu, còn bao lâu" for ONE channel row
 * (design §5.9). Rendered only when the server sent a progress block — which it
 * only does while the job is `queued` or `publishing` (law 3.1 lives there, so
 * this component never has to remember it).
 *
 * `"use client"` sits on this leaf because of the clock: the elapsed/remaining
 * line ticks in the browser from `stageStartedAt`/`waitUntil`, so a 1.5s poll
 * does not decide how fresh a second counter looks. Nothing else here needs it.
 */
export function ChannelProgress({
  progress,
  steps,
  channelLabel,
  /** The row's status sentence; the detail line is dropped when it repeats it. */
  statusMessage,
}: {
  progress: BatchChannelProgress;
  steps: readonly string[];
  /** What the progress bars call this channel — the Page name when known. */
  channelLabel: string;
  statusMessage: string;
}) {
  // 1s: this is the only per-second update on the screen, and it re-renders one
  // paragraph. A hidden tab throttles it, and the value is read from an absolute
  // instant, so throttling changes the refresh rate, never the number.
  const nowMs = useNowMs(1_000);
  const bar = progressBarView(progress);
  const timing = progressTimingView(progress, nowMs);
  const showLabel = progress.label !== statusMessage;

  return (
    <div className="border-border/70 mt-2 space-y-1.5 rounded-lg border border-dashed px-2.5 py-2">
      <ProgressStepper
        steps={steps}
        currentIndex={progress.stepIndex}
        label={`Các bước đăng bài của kênh ${channelLabel}`}
      />

      <Progress
        value={bar.kind === "determinate" ? bar.valueNow : null}
        max={bar.kind === "determinate" ? bar.valueMax : undefined}
        label={`Tiến độ bước đang chạy của kênh ${channelLabel}`}
        valueText={bar.valueText}
      />

      <p className="text-muted-foreground text-xs">
        {showLabel ? progress.label : null}
        {showLabel && timing ? " · " : null}
        {/* No estimate is ever printed here: either a countdown to a deadline the
            system computed, or how long the step has actually been running. */}
        {timing ? <span className="tabular-nums">{timing.text}</span> : null}
      </p>
    </div>
  );
}
