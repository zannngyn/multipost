"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { formatCount, formatDateTime, formatDuration } from "@/ui/components/sync/sync-format";
import { shortenId } from "@/ui/schemas/catalog.schema";
import {
  SYNC_STATUS_HINTS,
  SYNC_STATUS_LABELS,
  SYNC_STATUS_TONES,
  type SyncRun,
} from "@/ui/schemas/sync.schema";

/**
 * Right rail: the facts about the latest run — what state it ended in, when,
 * how long, and the id support will ask for.
 *
 * `partial` deliberately does not look like `succeeded`: the run finished, but
 * files were skipped and somebody has to look at them. The colour comes from
 * `SYNC_STATUS_TONES` so the banner in the main column cannot disagree.
 */

type CopyState = "idle" | "copied" | "failed";

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
    </div>
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
