import { formatCount } from "@/ui/components/sync/sync-format";
import type { RecentSyncRun } from "@/ui/schemas/sync.schema";

/**
 * What one row of the run history is SCANNED by.
 *
 * Five runs that all ended "Xong nhưng có vấn đề" are one repeated sentence;
 * their issue counts are not. So the count is the only thing in the row at
 * reading size, in its own right-aligned mono column — and this file owns the
 * decision of what goes in that column, JSX-free so every branch is testable.
 *
 * The "no number" cases are FOUR different facts and must never render the same
 * way: a run still in flight has not produced a count yet; a run that ended
 * without an end time lost its numbers with it; a finished run with
 * `issuesTotal === null` produced a count nobody recorded; and a non-finite
 * `issuesTotal` is a count that was recorded and cannot be read. `note` says
 * which in words — the 10px label alone is not a sentence, colour and size are
 * not information (The Named Status Rule), and the dash is `aria-hidden`, so
 * `note` is the ONLY thing a screen reader gets.
 */

/** The number column when there is no number to put in it. */
export const NO_TALLY = "—";

export type RunTally = {
  /** Printed in the number column; `NO_TALLY` when there is nothing to count. */
  value: string;
  /** Woven label under the number — the unit, not the explanation. */
  label: string;
  /** Nothing worth scanning: a placeholder, or a genuinely clean run. */
  isQuiet: boolean;
  /** The explanation, when the number alone would be misread. */
  note: string | null;
};

export function runTally(run: RecentSyncRun): RunTally {
  // In flight. "0 vấn đề" here would read as a clean run, which is the most
  // misleading number on this screen.
  if (run.status === "running") {
    return {
      value: NO_TALLY,
      label: "chưa xong",
      isQuiet: true,
      note: "Chưa kết thúc — chưa có số liệu.",
    };
  }

  // No end time on a run that is NOT running. This used to be folded into the
  // branch above, which printed "chưa xong" two lines under a status reading
  // "Thất bại" and a line reading "Dừng vì DRIVE_TIMEOUT" — the row argued with
  // itself. One voice: the run is over, its numbers did not survive it.
  if (run.finishedAt === null) {
    return {
      value: NO_TALLY,
      label: "không rõ",
      isQuiet: true,
      note:
        run.status === "failed"
          ? "Dừng giữa chừng — không có số liệu."
          : "Không ghi được lúc kết thúc — không có số liệu.",
    };
  }

  // Finished, but the count was never written. Absent is not zero, and this is
  // a fault in the recording, not a property of the run.
  if (run.issuesTotal === null) {
    return {
      value: NO_TALLY,
      label: "không rõ",
      isQuiet: true,
      note: "Không ghi được số vấn đề của lần chạy này.",
    };
  }

  // A count that arrived and is not a count. Different fact again: something
  // WAS written, it just cannot be read. It has to speak, because the dash in
  // the number column is `aria-hidden` — without a note this row said "vấn đề"
  // to a screen reader and nothing else, which reads as a clean run.
  if (!Number.isFinite(run.issuesTotal)) {
    return {
      value: NO_TALLY,
      label: "không rõ",
      isQuiet: true,
      note: "Không đọc được số vấn đề của lần chạy này.",
    };
  }

  return {
    value: formatCount(run.issuesTotal),
    label: "vấn đề",
    // A real zero is good news and does not need to shout next to a 7.433.
    isQuiet: run.issuesTotal === 0,
    note: null,
  };
}
