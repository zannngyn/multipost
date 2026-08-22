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
 * The two "no number" cases are NOT the same fact and must never render the
 * same way: a run still in flight has not produced a count yet, while a
 * finished run with `issuesTotal === null` produced one that the system failed
 * to record. `note` says which in words — the 10px label alone is not a
 * sentence, and colour/size are not information (The Named Status Rule).
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
  // In flight. `running` and "no finishedAt" are the same fact seen from two
  // columns — a crashed run can carry either. "0 vấn đề" here would read as a
  // clean run, which is the most misleading number on this screen.
  if (run.status === "running" || run.finishedAt === null) {
    return {
      value: NO_TALLY,
      label: "chưa xong",
      isQuiet: true,
      note: "Chưa kết thúc — chưa có số liệu.",
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

  return {
    value: formatCount(run.issuesTotal),
    label: "vấn đề",
    // A real zero is good news and does not need to shout next to a 7.433.
    isQuiet: run.issuesTotal === 0,
    note: null,
  };
}
