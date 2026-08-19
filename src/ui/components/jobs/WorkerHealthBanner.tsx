"use client";

import { Button } from "@/ui/components/ui/button";
import { cn } from "@/shared/utils";

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
 */

const TONE_STYLES: Record<WorkerHealthTone, string> = {
  // Posts are stuck right now.
  critical: "border-destructive/40 bg-destructive/10 text-destructive",
  // Something is wrong but nothing is lost yet.
  warning: "border-warning/40 bg-warning/10 text-warning-foreground",
  // We could not take the reading; the log itself is unaffected.
  muted: "border-border bg-muted/40 text-muted-foreground",
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
    <div
      data-notice-kind={notice.kind}
      // Only the "posts are stuck" case interrupts a screen reader mid-task;
      // the softer ones are announced politely (web-feedback-states rule 4).
      role={notice.tone === "critical" ? "alert" : "status"}
      aria-live={notice.tone === "critical" ? "assertive" : "polite"}
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm",
        TONE_STYLES[notice.tone],
        className,
      )}
    >
      <div className="min-w-0 max-w-prose space-y-1">
        <p className="font-semibold">{notice.title}</p>
        <p>{notice.description}</p>
        <p className="font-medium">{notice.action}</p>
      </div>

      {onRecheck ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRecheck}
          disabled={isChecking}
          className="shrink-0"
        >
          {isChecking ? "Đang kiểm tra…" : "Kiểm tra lại"}
        </Button>
      ) : null}
    </div>
  );
}
