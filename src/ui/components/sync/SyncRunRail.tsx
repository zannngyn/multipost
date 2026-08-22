"use client";

import { useEffect, useId, useState } from "react";

import { cn } from "@/shared/utils";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { formatCount, formatDateTime, formatDuration } from "@/ui/components/sync/sync-format";
import { shortenId } from "@/ui/schemas/catalog.schema";
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
 */

type CopyState = "idle" | "copied" | "failed";

/**
 * Dot colour per status. Same severity ladder as `SYNC_STATUS_TONES`, expressed
 * as the 6px dot the history list uses instead of a full badge — five badges
 * stacked in a 360px rail read as five alerts.
 */
const STATUS_DOT: Record<SyncRunStatus, string> = {
  running: "bg-primary motion-safe:animate-pulse",
  succeeded: "bg-success",
  partial: "bg-warning",
  failed: "bg-destructive",
};

/** The number column when there is no number to put in it. */
const NO_TALLY = "—";

/**
 * What each history row is scanned BY. Five runs that all ended "Xong nhưng có
 * vấn đề" are one repeated sentence; their issue counts are not, so the count
 * is the only thing in the row at reading size and it keeps its own
 * right-aligned mono column (The Mono Ledger Rule). No new colour is spent on
 * the hierarchy — status keeps carrying the colour, alone.
 */
type RunTally = {
  value: string;
  label: string;
  /** Nothing worth scanning here — a placeholder, or a genuinely clean run. */
  isQuiet: boolean;
};

function runTally(run: RecentSyncRun): RunTally {
  // In flight: there is no result yet, and "0 vấn đề" would read as a clean run.
  if (run.status === "running" || run.finishedAt === null) {
    return { value: NO_TALLY, label: "chưa xong", isQuiet: true };
  }
  // Finished, but the count was never written. Absent is not zero.
  if (run.issuesTotal === null) {
    return { value: NO_TALLY, label: "không rõ", isQuiet: true };
  }
  return {
    value: formatCount(run.issuesTotal),
    label: "vấn đề",
    isQuiet: run.issuesTotal === 0,
  };
}

export function SyncRunRail({ run }: { run: SyncRun }) {
  const duration = formatDuration(run.startedAt, run.finishedAt);
  const deletedProducts = run.counts?.productsDeleted ?? 0;
  const deletedMedia = run.counts?.mediaDeleted ?? 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Eyebrow styling on a real heading: the rail needs a landmark title
              in the outline, and <Eyebrow> is a <p> by design. */}
          <h2 className="text-foreground-subtle font-mono text-xs tracking-widest uppercase">
            Lần chạy gần nhất
          </h2>
          <Badge tone={SYNC_STATUS_TONES[run.status]}>{SYNC_STATUS_LABELS[run.status]}</Badge>
        </div>
        <p className="text-muted-foreground text-sm">{SYNC_STATUS_HINTS[run.status]}</p>
      </div>

      <dl className="space-y-1.5 text-sm">
        <RailRow label="Bắt đầu" value={formatDateTime(run.startedAt)} />
        <RailRow
          label="Kết thúc"
          value={run.finishedAt ? formatDateTime(run.finishedAt) : "— (chưa xong)"}
        />
        <RailRow label="Thời gian chạy" value={duration ?? "— (chưa xong)"} />
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground w-28 shrink-0 text-xs">Mã lần chạy</dt>
          <dd className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="text-muted-foreground truncate font-mono text-xs" title={run.syncRunId}>
              {shortenId(run.syncRunId, 8)}
            </span>
            <CopyRunId syncRunId={run.syncRunId} tenantId={run.tenantId} />
          </dd>
        </div>
      </dl>

      {run.errorCode || run.errorMessage ? (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive rounded-xl border px-3 py-2 text-sm"
        >
          <span className="font-medium">Lý do dừng:</span> {run.errorMessage ?? "Không rõ"}
          {run.errorCode ? <span className="font-mono text-xs"> ({run.errorCode})</span> : null}
        </p>
      ) : null}

      {/* Past tense on purpose: these are the deletions the run ALREADY made.
          The API has no forecast for the next run, and labelling them as one
          would be an invented number. */}
      {deletedProducts + deletedMedia > 0 ? (
        <div className="border-warning/40 space-y-1.5 rounded-xl border p-3">
          <p className="text-warning-foreground text-sm font-semibold">
            Lần chạy vừa rồi đã xoá
          </p>
          <p className="text-muted-foreground text-sm">
            Sản phẩm và ảnh không còn thuộc nguồn hiện tại đã bị xoá khỏi hệ thống.
          </p>
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-mono tabular-nums">{formatCount(deletedProducts)}</span>
            <span>sản phẩm</span>
            <span className="font-mono tabular-nums">{formatCount(deletedMedia)}</span>
            <span>file</span>
          </p>
        </div>
      ) : null}

      <RecentRunsList runs={run.recentRuns} currentRunId={run.syncRunId} />
    </div>
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
    <section aria-labelledby={headingId} className="border-border space-y-2 border-t pt-4">
      <h3
        id={headingId}
        className="text-foreground-subtle font-mono text-xs tracking-widest uppercase"
      >
        Các lần chạy trước
      </h3>

      {previous.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Chưa có lần chạy nào khác để so sánh — đây là lần đồng bộ đầu tiên của đơn vị này.
        </p>
      ) : (
        // Rows in one bordered surface, not five bordered boxes: scanned data is
        // a list, and five identical cards read as five separate alerts.
        <ul className="border-border divide-border divide-y rounded-md border">
          {previous.map((item) => (
            <RecentRunRow key={item.syncRunId} run={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentRunRow({ run }: { run: RecentSyncRun }) {
  const tally = runTally(run);
  const duration = formatDuration(run.startedAt, run.finishedAt);

  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex items-center gap-2 text-xs">
          <span
            aria-hidden="true"
            className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[run.status])}
          />
          {/* Colour is never the only carrier — the status is written out too. */}
          <span className="truncate font-medium">{SYNC_STATUS_LABELS[run.status]}</span>
        </p>

        {/* When it ran, and for how long. Demoted on purpose: five dates in a
            column are five near-identical strings and tell nobody anything. */}
        <p className="text-muted-foreground font-mono text-[11px] tabular-nums">
          {formatDateTime(run.startedAt)}
          {duration ? ` · ${duration}` : ""}
        </p>

        {/* A run that died mid-way is BOTH unfinished and failed, and the reason
            is the only useful thing left on it — so it is never folded into the
            tally branch above. */}
        {run.errorCode ? (
          <p className="text-muted-foreground text-[11px]">
            Dừng vì <span className="font-mono">{run.errorCode}</span>
          </p>
        ) : null}
      </div>

      <p className="w-18 shrink-0 text-right">
        <span
          // The placeholder has no number behind it; the label below says what
          // is missing, so the dash is decoration for a screen reader.
          aria-hidden={tally.value === NO_TALLY}
          className={cn(
            "block font-mono text-base leading-5 font-semibold tabular-nums",
            tally.isQuiet && "text-muted-foreground",
          )}
        >
          {tally.value}
        </span>
        <span className="text-foreground-subtle block font-mono text-[10px] tracking-widest uppercase">
          {tally.label}
        </span>
      </p>
    </li>
  );
}

function RailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-muted-foreground w-28 shrink-0 text-xs">{label}</dt>
      <dd className="min-w-0 flex-1 font-mono text-xs tabular-nums">{value}</dd>
    </div>
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
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <Button type="button" variant="link" size="xs" onClick={() => void copy()}>
        Sao chép
        <span className="sr-only"> mã lần chạy</span>
      </Button>
      <span role="status" className="min-w-0 basis-full text-xs">
        {state === "copied" ? <span className="text-muted-foreground">Đã chép.</span> : null}
        {state === "failed" ? (
          // A dead end is not acceptable: give back the full id to copy by hand.
          <span className="text-destructive">
            Trình duyệt chặn thao tác chép. Bôi đen mã đầy đủ:{" "}
            <span className="font-mono break-all select-all">{syncRunId}</span>
          </span>
        ) : null}
      </span>
    </span>
  );
}
