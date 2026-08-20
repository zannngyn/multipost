"use client";

import { useState } from "react";

import { cn } from "@/shared/utils";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { CatalogSourceCard } from "@/ui/components/sync/CatalogSourceCard";
import { RunSyncButton } from "@/ui/components/sync/RunSyncButton";
import { SyncFunnel } from "@/ui/components/sync/SyncFunnel";
import { SyncIssuesTable } from "@/ui/components/sync/SyncIssuesTable";
import { SyncRunRail } from "@/ui/components/sync/SyncRunRail";
import { SyncRunningCard } from "@/ui/components/sync/SyncRunningCard";
import { SyncRailSkeleton, SyncStatusSkeleton } from "@/ui/components/sync/SyncStatusSkeleton";
import { Button } from "@/ui/components/ui/button";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { useRunCatalogSync, useSyncStatus } from "@/ui/hooks/useCatalogSync";
import type { BadgeTone } from "@/ui/components/ui/badge";
import {
  SYNC_STATUS_LABELS,
  SYNC_STATUS_TONES,
  type SyncRun,
} from "@/ui/schemas/sync.schema";

/**
 * Tone -> the tinted-notice surface. This is the paragraph equivalent of what
 * `Badge` does for a pill; the status -> tone decision itself is NOT repeated
 * here, it comes from `SYNC_STATUS_TONES`.
 */
const NOTICE_TONE: Record<BadgeTone, string> = {
  neutral: "border-border bg-muted/40 text-foreground",
  info: "border-border bg-muted/40 text-foreground",
  success: "border-success/30 bg-success/10 text-success-foreground",
  warning: "border-warning/40 bg-warning/10 text-warning-foreground",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
};

/**
 * "Đồng bộ dữ liệu" screen: component -> hook -> service -> internal HTTP API
 * (docs/07 §4.1). No Drive/Sheet call is made from the browser.
 *
 * Layout is "fixed shell, one scrolling region" (core-layout-shell): a sticky
 * page header, a scrolling main column, and a rail with the facts about the
 * latest run. The rail moves BELOW the main column when the content area gets
 * narrow — the switch is a container query, not a viewport breakpoint, because
 * the side nav already eats 256px and a 1280px window leaves far less room than
 * a screen breakpoint would assume.
 *
 * The states this screen must tell apart (core-feedback-states):
 *   idle     — no tenant chosen yet
 *   loading  — skeletons shaped like the real blocks, delayed 300ms
 *   data     — funnel + grouped issues + rail
 *   empty    — `never_synced` (first run) is NOT the same message as "đã chạy,
 *              không có vấn đề"; the third empty is "chạy xong nhưng chưa có số
 *              liệu"
 *   error    — 4xx (sửa mã đơn vị / thiếu cấu hình, không thử lại được) vs 5xx
 *              (thử lại được), told apart by `presentApiError`
 *   stale    — background refetch keeps the content on screen
 *   pending  — the run panel reports work without blanking anything
 */
export function SyncScreen() {
  /** Set right after a source change — the next sync is no longer optional. */
  const [sourceChanged, setSourceChanged] = useState(false);

  /**
   * The company is no longer typed in (M1.4): it comes from the session. Until
   * `/api/me` answers, `isResolved` is false and every query below stays idle —
   * that, not an empty text box, is this screen's idle state now.
   */
  const { isResolved } = useActiveTenant();
  const status = useSyncStatus();
  const run = useRunCatalogSync();

  const isFirstLoad = status.isPending && status.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);
  const latestRun = status.data?.state === "has_run" ? status.data.run : null;

  return (
    <div className="@container bg-background h-full min-h-0">
      {/* Narrow: the whole thing is one scroll. Wide: two independent regions,
          so the rail does not scroll away from the numbers it describes. */}
      <div className="flex h-full min-h-0 flex-col overflow-y-auto @5xl:flex-row @5xl:overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col @5xl:min-h-0 @5xl:overflow-y-auto @5xl:[scrollbar-gutter:stable]">
          <header className="bg-background border-border sticky top-0 z-10 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b px-6 py-4">
            <div className="min-w-0 space-y-1">
              <h1 className="text-2xl leading-tight font-semibold tracking-tight">
                Đồng bộ dữ liệu
              </h1>
              <p className="text-muted-foreground max-w-prose text-sm">
                Đọc ảnh/video từ Drive và sản phẩm từ Sheet, rồi ghi vào hệ thống. Mọi file bị bỏ
                qua đều được ghi nhận bên dưới.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {status.isFetching && !isFirstLoad ? (
                <p className="text-muted-foreground text-sm">Đang làm mới…</p>
              ) : null}
              <RunSyncButton
                onConfirm={() => {
                  setSourceChanged(false);
                  run.mutate();
                }}
                isRunning={run.isPending}
                disabled={!isResolved}
              />
            </div>
          </header>

          {/* Progress and results are announced without stealing focus. */}
          <p className="sr-only" role="status" aria-live="polite">
            {run.isPending
              ? "Đang chạy đồng bộ, vui lòng đợi"
              : run.isSuccess
                ? "Đồng bộ đã chạy xong"
                : isFirstLoad
                  ? "Đang tải trạng thái đồng bộ"
                  : ""}
          </p>

          <div className="flex min-w-0 flex-col gap-5 px-6 py-5">
            {run.isPending ? <SyncRunningCard /> : null}

            {run.isError ? (
              <ApiErrorNotice
                error={run.error}
                onRetry={() => run.mutate()}
                extraAction={
                  <Button type="button" variant="outline" onClick={() => void status.refetch()}>
                    Tải lại trạng thái
                  </Button>
                }
              />
            ) : null}

            {/* The banner takes its colour from the SAME table as the rail
                badge: "Xong nhưng có vấn đề" inside a green box is read as a
                success long before anyone reaches the sentence. */}
            {run.isSuccess ? (
              <p
                role="status"
                className={cn(
                  "rounded-xl border px-3.5 py-2.5 text-sm",
                  NOTICE_TONE[SYNC_STATUS_TONES[run.data.status]],
                )}
              >
                Đồng bộ xong — trạng thái “{SYNC_STATUS_LABELS[run.data.status]}”. Số liệu bên dưới
                đã được cập nhật.
                {run.data.schemaDrift.length > 0
                  ? ` Cảnh báo: thiếu hoặc đổi tên cột trên Sheet: ${run.data.schemaDrift.join(", ")}.`
                  : ""}
              </p>
            ) : null}

            {/* Which folder / which tab — first, because every number below only
                means something once the operator knows where it came from. */}
            <CatalogSourceCard onSourceChanged={() => setSourceChanged(true)} />

            {sourceChanged ? (
              <p
                role="status"
                className="border-warning/40 bg-warning/10 text-warning-foreground rounded-xl border px-3.5 py-2.5 text-sm"
              >
                Đã đổi nguồn dữ liệu. Số liệu bên dưới vẫn là của nguồn cũ cho tới khi bạn bấm{" "}
                <span className="font-medium">Chạy đồng bộ</span> — lần chạy đó cũng sẽ xoá sản
                phẩm/ảnh không còn thuộc nguồn mới.
              </p>
            ) : null}

            <SyncStatusResult
              isResolved={isResolved}
              isFirstLoad={isFirstLoad}
              showSkeleton={showSkeleton}
              status={status}
            />
          </div>
        </div>

        <aside
          aria-label="Chi tiết lần chạy"
          className="border-border bg-card shrink-0 border-t px-5 py-5 @5xl:w-90 @5xl:min-h-0 @5xl:overflow-y-auto @5xl:border-t-0 @5xl:border-l"
        >
          <SyncRailContent
            isResolved={isResolved}
            isFirstLoad={isFirstLoad}
            showSkeleton={showSkeleton}
            hasError={status.isError}
            run={latestRun}
          />
        </aside>
      </div>
    </div>
  );
}

/** The rail keeps its width in every state — an empty column must not resize. */
function SyncRailContent({
  isResolved,
  isFirstLoad,
  showSkeleton,
  hasError,
  run,
}: {
  isResolved: boolean;
  isFirstLoad: boolean;
  showSkeleton: boolean;
  hasError: boolean;
  run: SyncRun | null;
}) {
  // Still working out which company this session belongs to.
  if (!isResolved) {
    return (
      <p className="text-muted-foreground text-sm">
        Đang xác định công ty của bạn để đọc lần chạy gần nhất.
      </p>
    );
  }

  if (isFirstLoad) return showSkeleton ? <SyncRailSkeleton /> : null;

  // The full error (with its retry) lives in the main column; repeating it here
  // would give the operator two buttons for one problem.
  if (hasError) {
    return (
      <p className="text-muted-foreground text-sm">
        Chưa đọc được trạng thái lần chạy. Xem thông báo lỗi ở cột bên trái.
      </p>
    );
  }

  if (!run) {
    return (
      <p className="text-muted-foreground text-sm">
        Đơn vị này chưa từng đồng bộ, nên chưa có lần chạy nào để xem chi tiết.
      </p>
    );
  }

  return <SyncRunRail run={run} />;
}

function SyncStatusResult({
  isResolved,
  isFirstLoad,
  showSkeleton,
  status,
}: {
  isResolved: boolean;
  isFirstLoad: boolean;
  showSkeleton: boolean;
  status: ReturnType<typeof useSyncStatus>;
}) {
  // --- Idle: the session's company is not known yet -------------------------
  if (!isResolved) {
    return (
      <EmptyState
        kind="idle"
        title="Đang xác định công ty của bạn"
        description="Số liệu đồng bộ thuộc về một công ty cụ thể, nên màn này chờ biết bạn đang làm việc ở công ty nào."
      />
    );
  }

  // --- Loading (delayed so a fast answer does not flash) -------------------
  if (isFirstLoad) return showSkeleton ? <SyncStatusSkeleton /> : null;

  // --- Error ---------------------------------------------------------------
  if (status.isError) {
    return <ApiErrorNotice error={status.error} onRetry={() => void status.refetch()} />;
  }

  if (!status.data) return null;

  // --- Empty: this tenant has never synced ---------------------------------
  if (status.data.state === "never_synced") {
    return (
      <EmptyState
        kind="first-run"
        title="Đơn vị này chưa từng đồng bộ"
        description={
          <>
            Chưa có dữ liệu sản phẩm hay ảnh nào trong hệ thống. Bấm{" "}
            <span className="font-medium">Chạy đồng bộ</span> ở trên để đọc Drive và Sheet lần đầu.
            Cần khai báo thư mục Drive và bảng Sheet cho đơn vị trước khi chạy.
          </>
        }
      />
    );
  }

  // --- Data ----------------------------------------------------------------
  const run = status.data.run;

  if (!run.counts) {
    return (
      <EmptyState
        kind="done"
        title="Lần chạy này chưa có số liệu"
        description="Số liệu chỉ được ghi khi lần đồng bộ kết thúc. Nếu trạng thái vẫn là “Đang chạy”, hãy đợi rồi tải lại trang."
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <SyncFunnel counts={run.counts} finishedAt={run.finishedAt} />
      <SyncIssuesTable
        issues={run.issues}
        issueGroups={run.issueGroups}
        total={run.counts.issuesTotal}
        truncated={run.counts.issuesTruncated}
      />
    </div>
  );
}
