import {
  syncIssueGuide,
  type SyncIssue,
  type SyncIssueGroup,
  type SyncIssueSeverity,
} from "@/ui/schemas/sync.schema";

/**
 * Grouping behind the "Cần xử lý" table. Pure and JSX-free so the rules it
 * carries can be tested directly.
 *
 * Two sources, one shape:
 * - `fromIssueGroups` — the server grouped BEFORE capping, so `count` is exact
 *   even when the run detected 7.403 problems and stored 200.
 * - `groupSyncIssues` — the fallback for runs stored before the server did that.
 *   THE RULE THERE: every number counts rows of the array it was handed, and
 *   that array is capped at 200 while `counts.issuesTotal` is exact. The caller
 *   must never mix a count from that path with `issuesTotal`; the table says so
 *   above the numbers when the cap was hit.
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

/** Biggest group first — its fix removes the most rows. Ties break on the code. */
function byImpact(a: IssueGroup, b: IssueGroup): number {
  return b.count - a.count || a.errorCode.localeCompare(b.errorCode);
}

/**
 * Server-side groups -> table rows. `count` is passed through untouched: it is
 * the whole point of the server doing the grouping. `reasons` can only be read
 * off the examples, so it describes THOSE rows, not the whole group.
 */
export function fromIssueGroups(groups: readonly SyncIssueGroup[]): IssueGroup[] {
  const rows: IssueGroup[] = [];

  for (const group of groups) {
    // A group with no rows is not a group; rendering it would put a 0% bar and
    // an instruction on screen for a problem nobody has.
    if (!Number.isFinite(group.count) || group.count <= 0) continue;

    const guide = syncIssueGuide(group.errorCode);
    const examples = group.examples.slice(0, MAX_EXAMPLES);
    rows.push({
      errorCode: group.errorCode,
      severity: guide.severity,
      action: guide.action,
      count: group.count,
      reasons: [...new Set(examples.map((example) => example.reason))],
      examples,
    });
  }

  return rows.sort(byImpact);
}

/** Sum of the group counts — compared against `issuesTotal` by the table. */
export function totalOfGroups(groups: readonly IssueGroup[]): number {
  return groups.reduce((sum, group) => sum + group.count, 0);
}

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

  return [...byCode.values()].sort(byImpact);
}
