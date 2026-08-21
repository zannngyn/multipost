"use client";

import {
  Banner,
  Collapsible,
  CollapsibleGroup,
  EmptyState,
  HStack,
  Heading,
  ProgressBar,
  Stack,
  StackItem,
  StatusDot,
  Text,
} from "@astryxdesign/core";
import { useId } from "react";

import { formatCount, percentOf } from "@/ui/components/sync/sync-format";
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
 * Rows, not a table: four of the five columns hold one token each, the fifth
 * holds a sentence, and every row can open into a nested example list. That is
 * heterogeneous content, which is the case Astryx says to keep out of `Table`.
 * `CollapsibleGroup hasDividers` gives edge-to-edge rows with the disclosure
 * semantics (aria-expanded / aria-controls) built in, and the trigger keeps the
 * columns aligned with fixed widths.
 *
 * Two paths, and the difference is visible on screen:
 * - `issueGroups` present — the server counted every issue before capping the
 *   list, so the numbers here are the real ones and no warning is needed.
 * - `issueGroups === null` (a run stored before that existed) — the only rows
 *   available are the capped `issues[]`, so every number is computed on THAT
 *   list and the header says so before any number is read.
 */

/**
 * Severity -> the semantic variant the dot and the share bar both take. One map,
 * so a group's dot can never disagree with its own bar.
 */
const SEVERITY_VARIANT: Record<SyncIssueSeverity, "neutral" | "warning" | "error"> = {
  neutral: "neutral",
  warning: "warning",
  error: "error",
};

/** Never colour alone: the dot is decorative, this word is what is announced. */
const SEVERITY_LABEL: Record<SyncIssueSeverity, string> = {
  neutral: "Thông tin",
  warning: "Cảnh báo",
  error: "Nghiêm trọng",
};

/** Column budget for the trigger row, matched by the header above it. */
const COL_CODE = 176;
const COL_SHARE = 128;
const COL_COUNT = 72;

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
    <Stack as="section" direction="vertical" gap={3} aria-labelledby={headingId}>
      <Stack direction="vertical" gap={0.5}>
        <Heading level={2} id={headingId}>
          Cần xử lý
        </Heading>
        <Text type="supporting">Lần chạy này ghi nhận {formatCount(total)} vấn đề.</Text>
      </Stack>

      {/* Only the old path needs the warning: with exact groups the numbers
          below already cover every issue, and the cap affects examples only. */}
      {truncated && !hasExactGroups ? (
        <Banner
          role="status"
          status="warning"
          title={`Số bên dưới chỉ tính trên ${formatCount(shown)} vấn đề đầu tiên`}
          description={`Hệ thống chỉ lưu ${formatCount(shown)} vấn đề đầu tiên, tổng thật là ${formatCount(total)}. Xử lý xong rồi chạy đồng bộ lại để xem phần còn lại.`}
        />
      ) : null}

      {countsDisagree ? (
        <Banner
          role="status"
          status="warning"
          title="Số theo từng lý do không khớp tổng của lần chạy"
          description={`Cộng số theo từng lý do được ${formatCount(groupSum)}, khác với tổng ${formatCount(total)} mà lần chạy ghi nhận. Lấy con số theo từng lý do làm chuẩn và báo quản trị viên kiểm tra lần chạy này.`}
        />
      ) : null}

      {groups.length === 0 ? (
        total > 0 ? (
          <Banner
            role="status"
            status="warning"
            title="Không lưu được ví dụ nào"
            description={`Lần chạy này ghi nhận ${formatCount(total)} vấn đề nhưng không lưu được ví dụ nào. Chạy đồng bộ lại để lấy danh sách chi tiết.`}
          />
        ) : (
          <EmptyState
            headingLevel={3}
            title="Không có gì cần xử lý"
            description="Không file hay dòng nào bị bỏ qua trong lần chạy này. Toàn bộ dữ liệu đọc được đã vào hệ thống."
          />
        )
      ) : (
        <Stack direction="vertical" gap={0}>
          {/* Header row: same widths as every trigger below it, so the columns
              line up without a table's layout algorithm. */}
          <HStack gap={3} paddingInline={3} paddingBlock={2} align="center">
            <Stack direction="vertical" width={COL_CODE}>
              <Text type="label" color="secondary">
                Lý do
              </Text>
            </Stack>
            <StackItem size="fill">
              <Text type="label" color="secondary">
                Việc cần làm
              </Text>
            </StackItem>
            <Stack direction="vertical" width={COL_SHARE}>
              <Text type="label" color="secondary">
                Tỉ trọng
              </Text>
            </Stack>
            <Stack direction="vertical" width={COL_COUNT}>
              {/* `display="block"`: text-align does nothing on an inline span. */}
              <Text type="label" color="secondary" display="block" justify="end">
                Số
              </Text>
            </Stack>
          </HStack>

          <CollapsibleGroup type="multiple" hasDividers density="compact">
            {groups.map((group) => (
              <IssueGroupRow key={group.errorCode} group={group} shown={shown} />
            ))}
          </CollapsibleGroup>
        </Stack>
      )}
    </Stack>
  );
}

function IssueGroupRow({ group, shown }: { group: IssueGroup; shown: number }) {
  const share = percentOf(group.count, shown);

  return (
    <Collapsible
      value={group.errorCode}
      defaultIsOpen={false}
      trigger={
        <HStack gap={3} align="center" wrap="wrap">
          <Stack direction="vertical" width={COL_CODE}>
            <HStack gap={2} align="center">
              <StatusDot
                variant={SEVERITY_VARIANT[group.severity]}
                label={SEVERITY_LABEL[group.severity]}
              />
              <Text type="code" size="2xs" maxLines={1} wordBreak="break-all">
                {group.errorCode}
              </Text>
            </HStack>
          </Stack>

          <StackItem size="fill">
            <Text>{group.action}</Text>
          </StackItem>

          <Stack direction="vertical" width={COL_SHARE}>
            <HStack gap={2} align="center">
              <StackItem size="fill">
                <ProgressBar
                  label={`Tỉ trọng của ${group.errorCode}`}
                  isLabelHidden
                  variant={SEVERITY_VARIANT[group.severity]}
                  value={group.count}
                  max={Math.max(shown, 1)}
                />
              </StackItem>
              <Text type="code" size="2xs" color="secondary" hasTabularNumbers>
                {share ?? "—"}
              </Text>
            </HStack>
          </Stack>

          <Stack direction="vertical" width={COL_COUNT}>
            <Text type="code" hasTabularNumbers display="block" justify="end">
              {formatCount(group.count)}
            </Text>
          </Stack>
        </HStack>
      }
    >
      <Stack direction="vertical" gap={1.5} paddingBlock={2}>
        <Text type="supporting">
          {group.examples.length} ví dụ đầu · {formatCount(group.count)} vấn đề cùng mã ·{" "}
          <Text type="code" size="2xs">
            {group.reasons.join(", ")}
          </Text>
        </Text>

        <Stack direction="vertical" gap={1}>
          {group.examples.map((example, index) => (
            <HStack
              key={`${example.ref}-${example.reason}-${index}`}
              gap={3}
              align="start"
              wrap="wrap"
            >
              <Stack direction="vertical" width={288}>
                <Text type="code" size="2xs" wordBreak="break-all">
                  {example.ref}
                </Text>
              </Stack>
              <StackItem size="fill">
                <Text type="supporting" size="2xs">
                  {example.detail}
                </Text>
              </StackItem>
            </HStack>
          ))}
        </Stack>
      </Stack>
    </Collapsible>
  );
}
