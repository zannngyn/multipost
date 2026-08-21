"use client";

import {
  Banner,
  Button,
  Divider,
  HStack,
  Heading,
  List,
  ListItem,
  MetadataList,
  MetadataListItem,
  Stack,
  StackItem,
  StatusDot,
  Text,
} from "@astryxdesign/core";
import { useEffect, useId, useState } from "react";

import { formatCount, formatDateTime, formatDuration } from "@/ui/components/sync/sync-format";
import { shortenId } from "@/ui/schemas/catalog.schema";
import type { StatusTone } from "@/ui/schemas/post-batch.schema";
import {
  SYNC_STATUS_HINTS,
  SYNC_STATUS_LABELS,
  SYNC_STATUS_TONES,
  type RecentSyncRun,
  type SyncRun,
  type SyncRunStatus,
} from "@/ui/schemas/sync.schema";

/**
 * Right rail: the facts about the latest run — what state it ended in, when,
 * how long, and the id support will ask for — followed by the runs before it.
 *
 * `partial` deliberately does not look like `succeeded`: the run finished, but
 * files were skipped and somebody has to look at them. The colour comes from
 * `SYNC_STATUS_TONES` so the banner in the main column cannot disagree.
 *
 * The two headings are plain headings now. They used to be styled as mono
 * uppercase eyebrows, which is a label costume on top of a real heading — the
 * words carry the section on their own.
 */

type CopyState = "idle" | "copied" | "failed";

/**
 * Status -> dot, same severity ladder as `SYNC_STATUS_TONES`. Five stacked
 * pills in a 360px rail read as five alerts, so the history list carries a dot
 * and the status WORD instead.
 */
const DOT_VARIANT: Record<StatusTone, "success" | "warning" | "error" | "accent" | "neutral"> = {
  neutral: "neutral",
  info: "accent",
  success: "success",
  warning: "warning",
  danger: "error",
};

function dotFor(status: SyncRunStatus) {
  return DOT_VARIANT[SYNC_STATUS_TONES[status]];
}

export function SyncRunRail({ run }: { run: SyncRun }) {
  const duration = formatDuration(run.startedAt, run.finishedAt);
  const deletedProducts = run.counts?.productsDeleted ?? 0;
  const deletedMedia = run.counts?.mediaDeleted ?? 0;
  const statusLabel = SYNC_STATUS_LABELS[run.status];

  return (
    <Stack direction="vertical" gap={4}>
      <Stack direction="vertical" gap={2}>
        <Heading level={2}>Lần chạy gần nhất</Heading>
        <HStack gap={2} align="center">
          <StatusDot
            variant={dotFor(run.status)}
            label={statusLabel}
            isPulsing={run.status === "running"}
          />
          <Text weight="medium">{statusLabel}</Text>
        </HStack>
        <Text type="supporting">{SYNC_STATUS_HINTS[run.status]}</Text>
      </Stack>

      <MetadataList label={{ position: "start", width: 112 }}>
        <MetadataListItem label="Bắt đầu">
          <Text type="code" size="2xs" hasTabularNumbers>
            {formatDateTime(run.startedAt)}
          </Text>
        </MetadataListItem>
        <MetadataListItem label="Kết thúc">
          <Text type="code" size="2xs" hasTabularNumbers>
            {run.finishedAt ? formatDateTime(run.finishedAt) : "— (chưa xong)"}
          </Text>
        </MetadataListItem>
        <MetadataListItem label="Thời gian chạy">
          <Text type="code" size="2xs" hasTabularNumbers>
            {duration ?? "— (chưa xong)"}
          </Text>
        </MetadataListItem>
        <MetadataListItem label="Mã lần chạy">
          <Stack direction="vertical" gap={0.5}>
            <Text type="code" size="2xs" maxLines={1} wordBreak="break-all">
              {shortenId(run.syncRunId, 8)}
            </Text>
            <CopyRunId syncRunId={run.syncRunId} tenantId={run.tenantId} />
          </Stack>
        </MetadataListItem>
      </MetadataList>

      {run.errorCode || run.errorMessage ? (
        <Banner
          role="alert"
          status="error"
          title="Lý do dừng"
          description={`${run.errorMessage ?? "Không rõ"}${run.errorCode ? ` (${run.errorCode})` : ""}`}
        />
      ) : null}

      {/* Past tense on purpose: these are the deletions the run ALREADY made.
          The API has no forecast for the next run, and labelling them as one
          would be an invented number. */}
      {deletedProducts + deletedMedia > 0 ? (
        <Banner
          status="warning"
          title="Lần chạy vừa rồi đã xoá"
          description={`${formatCount(deletedProducts)} sản phẩm và ${formatCount(deletedMedia)} file không còn thuộc nguồn hiện tại đã bị xoá khỏi hệ thống.`}
        />
      ) : null}

      <Divider />

      <RecentRunsList runs={run.recentRuns} currentRunId={run.syncRunId} />
    </Stack>
  );
}

/**
 * The recent runs, newest first. Two things this list must never blur:
 * - a run still in flight has no end and no issue count, so it says so instead
 *   of showing "0 vấn đề", which reads like a clean run;
 * - a failed run shows the code it stopped on, because "0 vấn đề" on a run that
 *   never got to look at anything is the most misleading number on this screen.
 *
 * A tenant whose only run is the one described above gets a sentence, not an
 * empty box.
 */
function RecentRunsList({
  runs,
  currentRunId,
}: {
  runs: readonly RecentSyncRun[];
  currentRunId: string;
}) {
  const headingId = `${useId()}-recent`;
  // The run detailed above is already on screen in full; repeating it as a row
  // would make the list look one entry longer than the history really is.
  const previous = runs.filter((item) => item.syncRunId !== currentRunId);

  return (
    <Stack as="section" direction="vertical" gap={2} aria-labelledby={headingId}>
      <Heading level={3} id={headingId}>
        Các lần chạy trước
      </Heading>

      {previous.length === 0 ? (
        <Text type="supporting">
          Chưa có lần chạy nào khác để so sánh — đây là lần đồng bộ đầu tiên của đơn vị này.
        </Text>
      ) : (
        <List density="compact" hasDividers>
          {previous.map((item) => (
            <RecentRunRow key={item.syncRunId} run={item} />
          ))}
        </List>
      )}
    </Stack>
  );
}

function RecentRunRow({ run }: { run: RecentSyncRun }) {
  // `running` and "no finishedAt" are the same fact seen from two columns; a
  // crashed run can carry either, and both mean "there is no result here".
  const isUnfinished = run.status === "running" || run.finishedAt === null;
  const duration = formatDuration(run.startedAt, run.finishedAt);

  const detail = isUnfinished
    ? "Chưa kết thúc — chưa có số liệu."
    : `${duration ?? "—"}${
        run.issuesTotal === null
          ? " · không ghi được số vấn đề"
          : ` · ${formatCount(run.issuesTotal)} vấn đề`
      }`;

  return (
    <ListItem
      // Colour is never the only carrier — the status word is the row label.
      label={SYNC_STATUS_LABELS[run.status]}
      startContent={
        <StatusDot
          variant={dotFor(run.status)}
          label={SYNC_STATUS_LABELS[run.status]}
          isPulsing={run.status === "running"}
        />
      }
      description={
        <Text type="supporting" size="2xs" hasTabularNumbers>
          {detail}
          {/* Outside the branch above: a run that died mid-way is BOTH
              unfinished and failed, and the reason is the only useful thing
              left on it. */}
          {run.errorCode ? ` · dừng vì ${run.errorCode}` : null}
        </Text>
      }
      endContent={
        <Text type="code" size="2xs" color="secondary" hasTabularNumbers>
          {formatDateTime(run.startedAt)}
        </Text>
      }
    />
  );
}

/**
 * Copy the run id. The clipboard is a permission-gated API: it is absent on
 * insecure origins and can be blocked by permissions policy, so both the
 * missing-API branch and the rejection branch report failure — and the failure
 * message tells the operator what to do instead (select the id by hand).
 */
function CopyRunId({ syncRunId, tenantId }: { syncRunId: string; tenantId: string }) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 4_000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      console.error("[sync] clipboard unavailable", {
        tenant_id: tenantId,
        sync_run_id: syncRunId,
        error_code: "CLIPBOARD_UNAVAILABLE",
      });
      setState("failed");
      return;
    }

    try {
      await navigator.clipboard.writeText(syncRunId);
      setState("copied");
    } catch (error) {
      // Never swallow: without this the button would look like it worked.
      console.error("[sync] copy run id failed", {
        tenant_id: tenantId,
        sync_run_id: syncRunId,
        error_code: "CLIPBOARD_DENIED",
        err: error,
      });
      setState("failed");
    }
  }

  return (
    <Stack direction="vertical" gap={1}>
      <HStack gap={2} align="center">
        <Button
          variant="ghost"
          size="sm"
          label="Sao chép mã lần chạy"
          onClick={() => void copy()}
        >
          Sao chép
        </Button>
        <StackItem size="fill">
          <Text role="status" type="supporting" size="2xs">
            {state === "copied" ? "Đã chép." : null}
          </Text>
        </StackItem>
      </HStack>

      {state === "failed" ? (
        // A dead end is not acceptable: give back the full id to copy by hand.
        <Banner
          role="alert"
          status="error"
          title="Trình duyệt chặn thao tác chép"
          description={`Bôi đen mã đầy đủ để chép tay: ${syncRunId}`}
        />
      ) : null}
    </Stack>
  );
}
