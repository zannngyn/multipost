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
import { lastRunHealth } from "@/ui/components/sync/sync-source-collapse";
import { Button } from "@/ui/components/ui/button";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { useNowMs } from "@/ui/hooks/useNowMs";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import {
  isSyncRunLive,
  isSyncStillRunningError,
  useRunCatalogSync,
  useSyncStatus,
} from "@/ui/hooks/useCatalogSync";
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
  /** Support mode: reading a customer's catalogue is fine, rewriting it is not. */
  const readOnlyReason = useReadOnlyReason();
  const status = useSyncStatus();
  const run = useRunCatalogSync();

  const isFirstLoad = status.isPending && status.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);
  const latestRun = status.data?.state === "has_run" ? status.data.run : null;
  /**
   * "Did the last sync actually work" — the only evidence that lets the source
   * card fold itself away. Read from the status query already on screen, so a
   * Service Account tenant (permanently `not_connected`, permanently fine) is
   * not confused with a setup that is quietly broken.
   */
  const runHealth = lastRunHealth(status.data, status.isError);
  /**
   * The server's own answer to "is a sync happening right now". Everything the
   * screen says about a run in flight hangs off THIS, never off the mutation:
   * the request that started the run gives up at 120s while the handler keeps
   * writing rows. `isSyncRunLive` also refuses to believe a `running` row that
   * is older than any real sync could be, so a crashed run cannot lock this
   * screen up for good.
   *
   * The clock comes from `useNowMs` rather than a bare `Date.now()`: reading
   * the clock during render is impure (react-hooks/purity), and the age verdict
   * has to be able to CHANGE without a refetch — that is what re-enables the
   * button after a run died. A minute of granularity is plenty against the
   * thirty-minute hard-max age. `useNowMs` answers 0 before its first tick,
   * which reads as "still live" — the safe side: it keeps the button shut.
   */
  const nowMs = useNowMs(60_000);
  const isRunningOnServer = isSyncRunLive(latestRun, nowMs);
  /**
   * A timeout only means "still running" while the server says so. Once the run
   * settles, the poller brings the new status and this notice disappears on its
   * own. A timeout next to a run that is NOT running is a claim the client
   * cannot back up — the normal error notice is the honest answer there.
   */
  const isSyncStillRunning = run.isError && isSyncStillRunningError(run.error) && isRunningOnServer;

  return (
    <div className="@container bg-background h-full min-h-0">
      {/* Narrow: the whole thing is one scroll. Wide: two independent regions,
          so the rail does not scroll away from the numbers it describes.
          `relative` on every scroller: this screen owns its own scroll boxes,
          and an absolutely positioned `sr-only` node inside an unpositioned one
          anchors OUTSIDE it — see the note in AppFrame for what that does to the
          document height. */}
      {/* The header below is `sticky top-0`, so anything scrolled to — a focused
          control, a hash target — otherwise lands UNDER the band and is cut in
          half. `scroll-pt-14` on both scrollers pays for exactly the band's
          height, which is why that height is LOCKED at `h-14` (border-box: the
          1px border is inside the 56px) and the row may not wrap: a band that
          grows silently makes the padding wrong again. The page description used
          to live in here and pushed it to ~108px, swallowing the heading of
          every block an operator scrolled to (funnel stage "03" at a 900px
          viewport); it now scrolls with the content it introduces. */}
      <div className="relative flex h-full min-h-0 scroll-pt-14 flex-col overflow-y-auto @5xl:flex-row @5xl:overflow-hidden">
        <div className="relative flex min-w-0 flex-1 scroll-pt-14 flex-col @5xl:min-h-0 @5xl:overflow-y-auto @5xl:[scrollbar-gutter:stable]">
          <header className="bg-background border-border sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between gap-4 border-b px-6">
            <h1 className="min-w-0 truncate text-2xl leading-tight font-semibold tracking-tight">
              Đồng bộ dữ liệu
            </h1>

            <div className="flex shrink-0 items-center gap-3">
              {status.isFetching && !isFirstLoad ? (
                <p className="text-muted-foreground text-sm whitespace-nowrap">Đang làm mới…</p>
              ) : null}
              <RunSyncButton
                onConfirm={() => {
                  setSourceChanged(false);
                  run.mutate();
                }}
                isRunning={run.isPending}
                // A second run on top of a run that is still writing is the one
                // thing this button must not allow — and after a client timeout
                // the mutation is no longer pending, so `run.isPending` alone
                // would let it through.
                disabled={!isResolved || readOnlyReason !== null || isRunningOnServer}
                disabledReason={
                  readOnlyReason ??
                  (isRunningOnServer
                    ? "Một lần đồng bộ đang chạy trên máy chủ — chờ chạy xong rồi mới chạy lại được."
                    : undefined)
                }
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

          <div className="flex min-w-0 flex-col gap-4 px-6 py-4">
            {/* Body-quiet, and in the scrolling column: it is read once on the
                first visit, so it does not get to sit on screen forever. */}
            <p className="text-muted-foreground max-w-prose text-[13px]">
              Đọc ảnh/video từ Drive và sản phẩm từ Sheet, rồi ghi vào hệ thống. Mọi file bị bỏ qua
              đều được ghi nhận bên dưới.
            </p>

            {run.isPending ? <SyncRunningCard /> : null}

            {/* A client timeout is NOT a failed sync: the request gave up at
                120s while the handler keeps walking Drive. Showing it in red
                with a "Thử lại" button would both lie and offer to start a
                second run over the first — the rail below already follows the
                real `sync_run` status, and it polls until that run settles.
                Gated on that status, so this sentence is only ever said while
                the server is still saying it. */}
            {isSyncStillRunning ? (
              <div
                role="status"
                className={cn(
                  "flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-sm",
                  NOTICE_TONE.info,
                )}
              >
                <p className="min-w-0">
                  Lần đồng bộ này chạy lâu hơn thời gian chờ của trình duyệt —{" "}
                  <span className="font-medium">đồng bộ vẫn đang chạy trên máy chủ</span>. Trang tự
                  cập nhật khi có kết quả, đừng bấm chạy lại.
                </p>
                <Button type="button" variant="outline" onClick={() => void status.refetch()}>
                  Tải lại trạng thái
                </Button>
              </div>
            ) : run.isError ? (
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
            {/* The source card folds itself away once the pipeline proves the
                setup works — the verdict comes from the status query this
                screen already runs, so no second request is made for it. */}
            <CatalogSourceCard
              lastRunHealth={runHealth}
              onSourceChanged={() => setSourceChanged(true)}
            />

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
          className="border-border bg-card relative shrink-0 border-t px-5 py-5 @5xl:w-90 @5xl:min-h-0 @5xl:overflow-y-auto @5xl:border-t-0 @5xl:border-l"
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
