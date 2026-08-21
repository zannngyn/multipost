"use client";

import { Banner, Button, Text, VStack } from "@astryxdesign/core";

import type { WorkerHealthNotice, WorkerHealthTone } from "./present-worker-health";

/**
 * The banner that breaks the silence on /jobs: it says nothing at all while the
 * publish machine is healthy, and three different things when it is not.
 *
 * Presentational — it neither fetches nor decides. `presentWorkerHealth` owns
 * the decision (and is tested on its own), which is what keeps "khi nào KHÔNG
 * hiện banner" provable.
 *
 * It sits in the normal flow above the filter bar: it must be the first thing
 * read, without covering the log or replacing any of the screen's four states.
 * Never dismissable — nothing here goes away by being hidden.
 */

/** Severity of the reading -> the design system's four banner statuses. */
const TONE_STATUS: Record<WorkerHealthTone, "error" | "warning" | "info"> = {
  // Posts are stuck right now.
  critical: "error",
  // Something is wrong but nothing is lost yet.
  warning: "warning",
  // We could not take the reading; the log itself is unaffected.
  muted: "info",
};

export function WorkerHealthBanner({
  notice,
  onRecheck,
  isChecking = false,
  className,
}: {
  /** null = healthy, or nothing known yet. Renders nothing. */
  notice: WorkerHealthNotice | null;
  onRecheck?: () => void;
  isChecking?: boolean;
  className?: string;
}) {
  if (!notice) return null;

  return (
    <Banner
      className={className}
      data-notice-kind={notice.kind}
      status={TONE_STATUS[notice.tone]}
      // Only the "posts are stuck" case interrupts a screen reader mid-task;
      // the softer ones are announced politely (web-feedback-states rule 4).
      role={notice.tone === "critical" ? "alert" : "status"}
      aria-live={notice.tone === "critical" ? "assertive" : "polite"}
      title={notice.title}
      description={
        <VStack gap={1}>
          {/* Consequence first, then the way out — never a title on its own. */}
          <Text>{notice.description}</Text>
          <Text weight="medium">{notice.action}</Text>
        </VStack>
      }
      endContent={
        onRecheck ? (
          <Button
            variant="secondary"
            size="sm"
            label={isChecking ? "Đang kiểm tra…" : "Kiểm tra lại"}
            isLoading={isChecking}
            isDisabled={isChecking}
            onClick={onRecheck}
          />
        ) : undefined
      }
    />
  );
}
