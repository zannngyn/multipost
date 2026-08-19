"use client";

import { useId, useState } from "react";

import { cn } from "@/shared/utils";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { formatCount, percentOf, segmentWidth } from "@/ui/components/sync/sync-format";
import {
  fromIssueGroups,
  groupSyncIssues,
  totalOfGroups,
  type IssueGroup,
} from "@/ui/components/sync/sync-issue-groups";
import type { SyncIssue, SyncIssueGroup, SyncIssueSeverity } from "@/ui/schemas/sync.schema";

/**
 * "Cần xử lý" — the block that answers "vì sao tấm ảnh này không có trong bài?"
 * without opening a log (business rule 5).
 *
 * Grouped by `errorCode`, because a run produces thousands of rows and a handful
 * of reasons: a flat list is unreadable, and the operator fixes a REASON, not a
 * row.
 *
 * Two paths, and the difference is visible on screen:
 * - `issueGroups` present — the server counted every issue before capping the
 *   list, so the numbers here are the real ones and no warning is needed.
 * - `issueGroups === null` (a run stored before that existed) — the only rows
 *   available are the capped `issues[]`, so every number is computed on THAT
 *   list and the header says so before any number is read.
 */

const SEVERITY_DOT: Record<SyncIssueSeverity, string> = {
  neutral: "bg-muted-foreground/50",
  warning: "bg-warning",
  error: "bg-destructive",
};

const SEVERITY_BAR: Record<SyncIssueSeverity, string> = {
  neutral: "bg-muted-foreground/40",
  warning: "bg-warning",
  error: "bg-destructive",
};

/** Never colour alone: the dot is decorative, this word is what is announced. */
const SEVERITY_LABEL: Record<SyncIssueSeverity, string> = {
  neutral: "Thông tin",
  warning: "Cảnh báo",
  error: "Nghiêm trọng",
};

export function SyncIssuesTable({
  issues,
  issueGroups,
  total,
  truncated,
}: {
  /** The stored (possibly capped) list — the rows the examples come from. */
  issues: readonly SyncIssue[];
  /** Exact per-code counts, or null for a run stored before they existed. */
  issueGroups: readonly SyncIssueGroup[] | null;
  /** Uncapped number detected by the run (`counts.issuesTotal`). */
  total: number;
  truncated: boolean;
}) {
  const headingId = `${useId()}-issues`;
  const hasExactGroups = issueGroups !== null;
  const groups = hasExactGroups ? fromIssueGroups(issueGroups) : groupSyncIssues(issues);
  // Denominator of the share bar. With exact groups it is the run's own total;
  // without them it is the number of rows on screen, because mixing the two
  // produces percentages that do not add up to the bar they sit in.
  const shown = hasExactGroups ? total : issues.length;
  // Exact counts that do not add up to the run's own total mean one of the two
  // numbers is wrong. Saying so is the only honest option (business rule 5).
  const groupSum = totalOfGroups(groups);
  const countsDisagree = hasExactGroups && groups.length > 0 && groupSum !== total;

  return (
    <section aria-labelledby={headingId} className="@container space-y-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-base font-semibold">
          Cần xử lý
        </h2>
        <p className="text-muted-foreground text-sm">
          Lần chạy này ghi nhận {formatCount(total)} vấn đề.
        </p>
      </div>

      {/* Only the old path needs the warning: with exact groups the numbers
          below already cover every issue, and the cap affects examples only. */}
      {truncated && !hasExactGroups ? (
        <p
          role="status"
          className="border-warning/40 bg-warning/10 text-warning-foreground rounded-xl border px-3.5 py-2.5 text-sm"
        >
          Hệ thống chỉ lưu {formatCount(shown)} vấn đề đầu tiên, tổng thật là {formatCount(total)}.
          Số theo từng lý do bên dưới{" "}
          <span className="font-medium">chỉ tính trên {formatCount(shown)} vấn đề đó</span> — không
          phải toàn bộ. Xử lý xong rồi chạy đồng bộ lại để xem phần còn lại.
        </p>
      ) : null}

      {countsDisagree ? (
        <p
          role="status"
          className="border-warning/40 bg-warning/10 text-warning-foreground rounded-xl border px-3.5 py-2.5 text-sm"
        >
          Cộng số theo từng lý do được {formatCount(groupSum)}, khác với tổng {formatCount(total)}{" "}
          mà lần chạy ghi nhận. Lấy con số theo từng lý do làm chuẩn và báo quản trị viên kiểm tra
          lần chạy này.
        </p>
      ) : null}

      {groups.length === 0 ? (
        total > 0 ? (
          <p
            role="status"
            className="border-warning/40 bg-warning/10 text-warning-foreground rounded-xl border px-3.5 py-2.5 text-sm"
          >
            Lần chạy này ghi nhận {formatCount(total)} vấn đề nhưng không lưu được ví dụ nào. Chạy
            đồng bộ lại để lấy danh sách chi tiết.
          </p>
        ) : (
          <EmptyState
            kind="done"
            title="Không có gì cần xử lý"
            description="Không file hay dòng nào bị bỏ qua trong lần chạy này. Toàn bộ dữ liệu đọc được đã vào hệ thống."
          />
        )
      ) : (
        <div
          role="region"
          // Its own name, not the section's: two landmarks called "Cần xử lý"
          // give a screen-reader user no way to tell them apart.
          aria-label="Bảng vấn đề — cuộn ngang để xem hết cột"
          tabIndex={0}
          className="border-border overflow-x-auto rounded-xl border"
        >
          {/* `table-fixed` + fixed column widths: with `auto` every run would
              lay the columns out differently and the eye has to re-aim. */}
          <table className="w-full min-w-3xl table-fixed border-collapse text-sm">
            <caption className="sr-only">
              Các vấn đề của lần đồng bộ gần nhất, gom theo mã lỗi, kèm việc cần làm và ví dụ.
            </caption>
            {/* "Việc cần làm" is the only column holding a SENTENCE, so it is
                the one that takes the slack; the other four hold one token each
                and are sized to their longest real content. Widths below come
                from `getBoundingClientRect` on the rendered classes, NOT from a
                per-character estimate — an estimate is what truncated the error
                codes the first time.
                  Lý do     w-44 = 176px — needs 161px: `FILE_NAME_INVALID` /
                            `SHEET_ROW_INVALID` / `PRODUCT_NOT_FOUND` measure
                            123px at `font-mono text-xs`, plus dot 6 + gap 8 +
                            padding 24. The extra 15px is deliberate headroom.
                            An error code is the operator's lookup key, so the
                            five codes the sync usecase emits must never be cut;
                            `truncate` + `title` stays as the fallback for the
                            arbitrary `appError.code` of a crashed run
                            (sync-catalog.ts) whose length nothing bounds.
                  Tỉ trọng  w-24 =  96px — bar + " 61%"
                  Số        w-16 =  64px — the count is no longer capped at 200
                            (it is now the run's exact number), but it is still
                            bounded by the folder: 5.500 real files = 5 glyphs
                            with the thousands dot, ~40px at font-mono
                  nút       w-24 =  96px — "Xem ví dụ", no wrap
                Fixed total 432px, leaving ~342px for the instruction at a
                774px table (viewport 1440). Handing these columns more is what
                squeezed that sentence down to five lines. */}
            <colgroup>
              <col className="w-44" />
              <col />
              <col className="w-24" />
              <col className="w-16" />
              <col className="w-24" />
            </colgroup>
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                <th scope="col" className="px-3 py-2 text-xs font-semibold">
                  Lý do
                </th>
                <th scope="col" className="px-3 py-2 text-xs font-semibold">
                  Việc cần làm
                </th>
                <th scope="col" className="px-3 py-2 text-xs font-semibold">
                  Tỉ trọng
                </th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-semibold">
                  Số
                </th>
                <th scope="col" className="px-3 py-2 text-xs font-semibold">
                  <span className="sr-only">Ví dụ</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <IssueGroupRows key={group.errorCode} group={group} shown={shown} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function IssueGroupRows({ group, shown }: { group: IssueGroup; shown: number }) {
  const reactId = useId();
  const panelId = `${reactId}-examples`;
  const [isOpen, setIsOpen] = useState(false);
  const share = percentOf(group.count, shown);

  return (
    <>
      <tr className="border-border border-t align-top">
        <th scope="row" className="px-3 py-2.5 text-left font-normal">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn("size-1.5 shrink-0 rounded-full", SEVERITY_DOT[group.severity])}
            />
            <span className="sr-only">{SEVERITY_LABEL[group.severity]}. </span>
            <span className="truncate font-mono text-xs" title={group.errorCode}>
              {group.errorCode}
            </span>
          </span>
        </th>

        <td className="px-3 py-2.5">{group.action}</td>

        <td className="px-3 py-2.5">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="bg-muted flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full"
            >
              <span
                className={cn("h-full", SEVERITY_BAR[group.severity])}
                // Runtime share of a group; not expressible as a static class.
                style={{ width: segmentWidth(group.count, shown) }}
              />
            </span>
            <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
              {share ?? "—"}
            </span>
          </span>
        </td>

        <td className="px-3 py-2.5 text-right font-mono tabular-nums">
          {formatCount(group.count)}
        </td>

        <td className="px-3 py-2.5 text-right">
          <button
            type="button"
            onClick={() => setIsOpen((open) => !open)}
            aria-expanded={isOpen}
            // Only while the panel exists: pointing at a missing id is worse
            // than saying nothing.
            aria-controls={isOpen ? panelId : undefined}
            className="text-primary focus-visible:ring-ring/50 rounded-sm whitespace-nowrap underline underline-offset-4 focus-visible:ring-3 focus-visible:outline-none"
          >
            {isOpen ? "Ẩn ví dụ" : "Xem ví dụ"}
            <span className="sr-only"> của {group.errorCode}</span>
          </button>
        </td>
      </tr>

      {isOpen ? (
        <tr id={panelId} className="border-border bg-muted/30 border-t">
          <td colSpan={5} className="px-3 pt-2 pb-3">
            <div className="space-y-1.5">
              <p className="text-muted-foreground text-xs">
                {group.examples.length} ví dụ đầu · {formatCount(group.count)} vấn đề cùng mã ·{" "}
                <span className="font-mono">{group.reasons.join(", ")}</span>
              </p>
              <ul className="space-y-1">
                {group.examples.map((example, index) => (
                  <li
                    key={`${example.ref}-${example.reason}-${index}`}
                    className="flex flex-col gap-x-3 gap-y-0.5 @2xl:flex-row"
                  >
                    <span className="font-mono text-xs break-all @2xl:w-72 @2xl:shrink-0">
                      {example.ref}
                    </span>
                    <span className="text-muted-foreground min-w-0 text-xs">{example.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
