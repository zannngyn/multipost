import { syncIssueGuide, type SyncIssue, type SyncIssueSeverity } from "@/ui/schemas/sync.schema";

/**
 * Grouping behind the "Cần xử lý" table. Pure and JSX-free so the rule it
 * carries can be tested directly.
 *
 * THE RULE: every number produced here counts rows of the array it was handed —
 * and that array is capped server-side at 200 while `counts.issuesTotal` is
 * exact. The caller must therefore never mix a count from here with
 * `issuesTotal`; the table says so above the numbers when the cap was hit.
 */

export const MAX_EXAMPLES = 3;

export type IssueGroup = {
  errorCode: string;
  severity: SyncIssueSeverity;
  action: string;
  count: number;
  /** Distinct machine reasons inside the group, as written by the usecase. */
  reasons: string[];
  examples: SyncIssue[];
};

export function groupSyncIssues(issues: readonly SyncIssue[]): IssueGroup[] {
  const byCode = new Map<string, IssueGroup>();

  for (const issue of issues) {
    const existing = byCode.get(issue.errorCode);
    if (!existing) {
      const guide = syncIssueGuide(issue.errorCode);
      byCode.set(issue.errorCode, {
        errorCode: issue.errorCode,
        severity: guide.severity,
        action: guide.action,
        count: 1,
        reasons: [issue.reason],
        examples: [issue],
      });
      continue;
    }

    existing.count += 1;
    if (!existing.reasons.includes(issue.reason)) existing.reasons.push(issue.reason);
    if (existing.examples.length < MAX_EXAMPLES) existing.examples.push(issue);
  }

  // Biggest group first: that is the one whose fix removes the most rows. Ties
  // break on the code so the order does not shuffle between two renders.
  return [...byCode.values()].sort(
    (a, b) => b.count - a.count || a.errorCode.localeCompare(b.errorCode),
  );
}
