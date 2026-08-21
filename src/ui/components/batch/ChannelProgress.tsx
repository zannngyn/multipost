"use client";

import { ProgressBar, Section, Stack, Text } from "@astryxdesign/core";

import {
  progressBarView,
  progressTimingView,
} from "@/ui/components/batch/channel-progress";
import { ProgressStepper } from "@/ui/components/batch/ProgressStepper";
import { useNowMs } from "@/ui/hooks/useNowMs";
import type { BatchChannelProgress } from "@/ui/schemas/post-batch.schema";

/**
 * "Bài này đang ở bước nào, đi được bao nhiêu, còn bao lâu" for ONE channel row
 * (design §5.9). Rendered only when the server sent a progress block — which it
 * only does while the job is `queued` or `publishing` (law 3.1 lives there, so
 * this component never has to remember it).
 *
 * A muted Section rather than a dashed box: it is a live sub-region of the row,
 * and a second border style inside a bordered table is noise the row does not
 * need.
 *
 * `"use client"` sits on this leaf because of the clock: the elapsed/remaining
 * line ticks in the browser from `stageStartedAt`/`waitUntil`, so a 1.5s poll
 * does not decide how fresh a second counter looks. Nothing else here needs it.
 */
export function ChannelProgress({
  progress,
  steps,
  channelId,
  /** The row's status sentence; the detail line is dropped when it repeats it. */
  statusMessage,
}: {
  progress: BatchChannelProgress;
  steps: readonly string[];
  channelId: string;
  statusMessage: string;
}) {
  // 1s: this is the only per-second update on the screen, and it re-renders one
  // paragraph. A hidden tab throttles it, and the value is read from an absolute
  // instant, so throttling changes the refresh rate, never the number.
  const nowMs = useNowMs(1_000);
  const bar = progressBarView(progress);
  const timing = progressTimingView(progress, nowMs);
  /**
   * The one line under the bar. A determinate step already words itself with
   * its counts ("Đã tải 3/12 ảnh"), which beats the generic stage label; an
   * indeterminate one falls back to that label, and drops it when the row's own
   * status sentence already says the same thing.
   */
  const detail =
    bar.kind === "determinate"
      ? bar.valueText
      : progress.label !== statusMessage
        ? progress.label
        : null;

  return (
    <Section variant="muted" padding={2}>
      <Stack direction="vertical" gap={2}>
        <ProgressStepper
          steps={steps}
          currentIndex={progress.stepIndex}
          label={`Các bước đăng bài của kênh ${channelId}`}
        />

        {bar.kind === "determinate" ? (
          <ProgressBar
            label={`Tiến độ bước đang chạy của kênh ${channelId}`}
            isLabelHidden
            value={bar.valueNow}
            max={bar.valueMax}
          />
        ) : (
          <ProgressBar
            label={`Tiến độ bước đang chạy của kênh ${channelId}`}
            isLabelHidden
            isIndeterminate
          />
        )}

        {detail || timing ? (
          <Text type="supporting" size="2xs" hasTabularNumbers>
            {detail}
            {detail && timing ? " · " : null}
            {/* No estimate is ever printed here: either a countdown to a
                deadline the system computed, or how long the step has actually
                been running. */}
            {timing ? timing.text : null}
          </Text>
        ) : null}
      </Stack>
    </Section>
  );
}
