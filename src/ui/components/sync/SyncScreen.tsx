"use client";

import {
  Banner,
  Button,
  Divider,
  EmptyState,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  LayoutPanel,
  Stack,
  Text,
  VisuallyHidden,
  useMediaQuery,
} from "@astryxdesign/core";
import { useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { CatalogSourceCard } from "@/ui/components/sync/CatalogSourceCard";
import { RunSyncButton } from "@/ui/components/sync/RunSyncButton";
import { SyncFunnel } from "@/ui/components/sync/SyncFunnel";
import { SyncIssuesTable } from "@/ui/components/sync/SyncIssuesTable";
import { SyncRunRail } from "@/ui/components/sync/SyncRunRail";
import { SyncRunningCard } from "@/ui/components/sync/SyncRunningCard";
import { SyncRailSkeleton, SyncStatusSkeleton } from "@/ui/components/sync/SyncStatusSkeleton";
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
import type { StatusTone } from "@/ui/schemas/post-batch.schema";
import {
  SYNC_STATUS_LABELS,
  SYNC_STATUS_TONES,
  type SyncRun,
} from "@/ui/schemas/sync.schema";

/**
 * Run status tone -> Banner status. The status -> tone decision itself is NOT
 * repeated here: it comes from `SYNC_STATUS_TONES`, so the banner in the main
 * column and the dot in the rail cannot disagree.
 */
const BANNER_STATUS: Record<StatusTone, "info" | "success" | "warning" | "error"> = {
  neutral: "info",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
};

/**
 * "Đồng bộ dữ liệu" screen: component -> hook -> service -> internal HTTP API
 * (docs/07 §4.1). No Drive/Sheet call is made from the browser.
 *
 * Frame (`astryx docs layout`, console archetype): `Layout` owns the shell — a
 * header with the one action this screen exists for, a scrolling content column,
 * and a 360px end panel with the facts about the latest run. The hand-rolled
 * container-query two-column layout it replaces did the same job with its own
 * scroll model; the design system's frame is one less thing to keep in sync.
 *
 * Responsive contract:
 *   > 1024px  content | rail 360
 *   <= 1024px the rail moves to the BOTTOM of the content column (it is not
 *             dropped: the run id and the deletion count are the two facts an
 *             operator reads before pressing "Chạy đồng bộ" again)
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

  // Below this width the rail would squeeze the funnel, so it moves under it.
  const isNarrow = useMediaQuery("(max-width: 1024px)");

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

  const rail = (
    <SyncRailContent
      isResolved={isResolved}
      isFirstLoad={isFirstLoad}
      showSkeleton={showSkeleton}
      hasError={status.isError}
      run={latestRun}
    />
  );

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={1}>
              <Heading level={1}>Đồng bộ dữ liệu</Heading>
              <Text type="supporting">
                Đọc ảnh/video từ Drive và sản phẩm từ Sheet, rồi ghi vào hệ thống. Mọi file bị bỏ
                qua đều được ghi nhận bên dưới.
              </Text>
            </Stack>

            <HStack gap={3} align="center" wrap="wrap">
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
              {status.isFetching && !isFirstLoad ? (
                <Text type="supporting" role="status" aria-live="polite">
                  Đang làm mới…
                </Text>
              ) : null}
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" gap={5} paddingInline={4} paddingBlock={4}>
            {/* Progress and results are announced without stealing focus. */}
            <VisuallyHidden as="div" role="status" aria-live="polite">
              {run.isPending
                ? "Đang chạy đồng bộ, vui lòng đợi"
                : run.isSuccess
                  ? "Đồng bộ đã chạy xong"
                  : isFirstLoad
                    ? "Đang tải trạng thái đồng bộ"
                    : ""}
            </VisuallyHidden>

            {run.isPending ? <SyncRunningCard /> : null}

            {/* A client timeout is NOT a failed sync: the request gave up at
                120s while the handler keeps walking Drive. Showing it in red
                with a "Thử lại" button would both lie and offer to start a
                second run over the first — the rail already follows the real
                `sync_run` status, and it polls until that run settles. Gated on
                that status, so this sentence is only ever said while the server
                is still saying it. */}
            {isSyncStillRunning ? (
              <Banner
                role="status"
                status="info"
                title="Đồng bộ vẫn đang chạy trên máy chủ"
                description="Lần đồng bộ này chạy lâu hơn thời gian chờ của trình duyệt. Trang tự cập nhật khi có kết quả, đừng bấm chạy lại."
                endContent={
                  <Button
                    variant="secondary"
                    size="sm"
                    label="Tải lại trạng thái"
                    onClick={() => void status.refetch()}
                  />
                }
              />
            ) : run.isError ? (
              <ApiErrorNotice
                error={run.error}
                onRetry={() => run.mutate()}
                extraAction={
                  <Button
                    variant="secondary"
                    label="Tải lại trạng thái"
                    onClick={() => void status.refetch()}
                  />
                }
              />
            ) : null}

            {/* The banner takes its colour from the SAME table as the rail dot:
                "Xong nhưng có vấn đề" inside a green box is read as a success
                long before anyone reaches the sentence. */}
            {run.isSuccess ? (
              <Banner
                role="status"
                status={BANNER_STATUS[SYNC_STATUS_TONES[run.data.status]]}
                title={`Đồng bộ xong — trạng thái “${SYNC_STATUS_LABELS[run.data.status]}”`}
                description={`Số liệu bên dưới đã được cập nhật.${
                  run.data.schemaDrift.length > 0
                    ? ` Cảnh báo: thiếu hoặc đổi tên cột trên Sheet: ${run.data.schemaDrift.join(", ")}.`
                    : ""
                }`}
              />
            ) : null}

            {/* Which folder / which tab — first, because every number below only
                means something once the operator knows where it came from. */}
            <CatalogSourceCard onSourceChanged={() => setSourceChanged(true)} />

            {sourceChanged ? (
              <Banner
                role="status"
                status="warning"
                title="Đã đổi nguồn dữ liệu"
                description="Số liệu bên dưới vẫn là của nguồn cũ cho tới khi bạn bấm “Chạy đồng bộ” — lần chạy đó cũng sẽ xoá sản phẩm/ảnh không còn thuộc nguồn mới."
              />
            ) : null}

            <SyncStatusResult
              isResolved={isResolved}
              isFirstLoad={isFirstLoad}
              showSkeleton={showSkeleton}
              status={status}
            />

            {/* Responsive contract: below 1024px the panel would squeeze the
                funnel, so the same rail runs at the bottom of this column
                instead of disappearing. */}
            {isNarrow ? (
              <Stack as="section" direction="vertical" gap={4} aria-label="Chi tiết lần chạy">
                <Divider />
                {rail}
              </Stack>
            ) : null}
          </Stack>
        </LayoutContent>
      }
      end={
        isNarrow ? undefined : (
          <LayoutPanel width={360} hasDivider isScrollable label="Chi tiết lần chạy">
            <Stack direction="vertical" padding={4}>
              {rail}
            </Stack>
          </LayoutPanel>
        )
      }
    />
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
      <Text type="supporting">Đang xác định công ty của bạn để đọc lần chạy gần nhất.</Text>
    );
  }

  if (isFirstLoad) return showSkeleton ? <SyncRailSkeleton /> : null;

  // The full error (with its retry) lives in the main column; repeating it here
  // would give the operator two buttons for one problem.
  if (hasError) {
    return (
      <Text type="supporting">
        Chưa đọc được trạng thái lần chạy. Xem thông báo lỗi ở cột nội dung.
      </Text>
    );
  }

  if (!run) {
    return (
      <Text type="supporting">
        Đơn vị này chưa từng đồng bộ, nên chưa có lần chạy nào để xem chi tiết.
      </Text>
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
        headingLevel={2}
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
        headingLevel={2}
        title="Đơn vị này chưa từng đồng bộ"
        description="Chưa có dữ liệu sản phẩm hay ảnh nào trong hệ thống. Bấm “Chạy đồng bộ” ở trên để đọc Drive và Sheet lần đầu. Cần khai báo thư mục Drive và bảng Sheet cho đơn vị trước khi chạy."
      />
    );
  }

  // --- Data ----------------------------------------------------------------
  const run = status.data.run;

  if (!run.counts) {
    return (
      <EmptyState
        headingLevel={2}
        title="Lần chạy này chưa có số liệu"
        description="Số liệu chỉ được ghi khi lần đồng bộ kết thúc. Nếu trạng thái vẫn là “Đang chạy”, hãy đợi rồi tải lại trang."
      />
    );
  }

  return (
    <Stack direction="vertical" gap={5}>
      <SyncFunnel counts={run.counts} finishedAt={run.finishedAt} />
      <SyncIssuesTable
        issues={run.issues}
        issueGroups={run.issueGroups}
        total={run.counts.issuesTotal}
        truncated={run.counts.issuesTruncated}
      />
    </Stack>
  );
}
