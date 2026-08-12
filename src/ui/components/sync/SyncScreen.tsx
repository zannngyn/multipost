"use client";

import { useId, useRef, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { RunSyncButton } from "@/ui/components/sync/RunSyncButton";
import { SyncCountsGrid } from "@/ui/components/sync/SyncCountsGrid";
import { SyncIssuesTable } from "@/ui/components/sync/SyncIssuesTable";
import { SyncRunSummary } from "@/ui/components/sync/SyncRunSummary";
import { SyncStatusSkeleton } from "@/ui/components/sync/SyncStatusSkeleton";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useRunCatalogSync, useSyncStatus } from "@/ui/hooks/useCatalogSync";
import { SyncFormSchema } from "@/ui/schemas/sync.schema";
import { DEMO_TENANT_ID } from "@/ui/schemas/tenant-health.schema";

/**
 * "Đồng bộ dữ liệu" screen: component -> hook -> service -> internal HTTP API
 * (docs/07 §4.1). No Drive/Sheet call is made from the browser.
 *
 * The four mandatory states (core-feedback-states), plus the two web ones that
 * matter here:
 *   loading  — skeleton shaped like the real panel, delayed 300ms
 *   data     — status header + counts + issue table
 *   empty    — `never_synced`: a first-run empty state with the run button as CTA
 *   error    — 4xx (sửa mã đơn vị / thiếu cấu hình, không có nút thử lại) vs
 *              5xx (thử lại được), told apart by `presentApiError`
 *   stale    — background refetch keeps the content on screen, thin indicator
 *   pending  — the run button reports progress without blanking the panel
 */
export function SyncScreen() {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);

  const [tenantIdInput, setTenantIdInput] = useState(DEMO_TENANT_ID);
  const [formError, setFormError] = useState<string | null>(null);
  const [activeTenantId, setActiveTenantId] = useState<string | null>(DEMO_TENANT_ID);

  const status = useSyncStatus(activeTenantId);
  const run = useRunCatalogSync(activeTenantId);

  const isFirstLoad = status.isPending && status.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Validate at the boundary, before any request leaves the browser.
    const parsed = SyncFormSchema.safeParse({ tenantId: tenantIdInput });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Mã đơn vị không hợp lệ.");
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }

    setFormError(null);
    run.reset();
    setActiveTenantId(parsed.data.tenantId);
  }

  return (
    <section className="space-y-6" aria-labelledby="sync-heading">
      <header className="space-y-1">
        <h1 id="sync-heading" className="text-2xl font-semibold tracking-tight">
          Đồng bộ dữ liệu
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Đọc lại thư mục ảnh trên Google Drive và bảng sản phẩm trên Google Sheet, rồi ghi vào hệ
          thống. Mọi file bị bỏ qua đều được ghi nhận bên dưới.
        </p>
      </header>

      <form onSubmit={handleSubmit} noValidate className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-80 space-y-1.5">
          <label htmlFor={inputId} className="text-sm font-medium">
            Mã đơn vị (tenant)
          </label>
          <Input
            id={inputId}
            ref={inputRef}
            name="tenantId"
            value={tenantIdInput}
            onChange={(event) => setTenantIdInput(event.target.value)}
            aria-invalid={formError !== null}
            aria-describedby={formError ? `${errorId} ${hintId}` : hintId}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <p id={hintId} className="text-muted-foreground text-xs">
            Dạng UUID. Đơn vị mẫu đã được điền sẵn.
          </p>
          {formError ? (
            <p id={errorId} role="alert" className="text-destructive text-xs">
              {formError}
            </p>
          ) : null}
        </div>

        <Button type="submit" variant="outline" size="lg">
          Xem đơn vị này
        </Button>
      </form>

      <div className="flex flex-wrap items-start gap-3">
        <RunSyncButton
          onConfirm={() => run.mutate()}
          isRunning={run.isPending}
          disabled={activeTenantId === null}
        />
        {status.isFetching && !isFirstLoad ? (
          <p className="text-muted-foreground self-center text-sm">Đang làm mới trạng thái…</p>
        ) : null}
      </div>

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

      {run.isPending ? (
        <p className="border-border bg-muted/40 rounded-lg border px-3 py-2 text-sm">
          Đang đọc Drive và Sheet… Việc này có thể mất vài phút với thư mục lớn. Kết quả sẽ hiện
          ngay bên dưới khi xong.
        </p>
      ) : null}

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

      {run.isSuccess ? (
        <p className="border-success/30 bg-success/10 text-success-foreground rounded-lg border px-3 py-2 text-sm">
          Đồng bộ xong — trạng thái “{run.data.status}”. Kết quả chi tiết đã được cập nhật bên
          dưới.
          {run.data.schemaDrift.length > 0
            ? ` Cảnh báo: thiếu/đổi tên cột trên Sheet: ${run.data.schemaDrift.join(", ")}.`
            : ""}
        </p>
      ) : null}

      <SyncStatusResult
        activeTenantId={activeTenantId}
        isFirstLoad={isFirstLoad}
        showSkeleton={showSkeleton}
        status={status}
      />
    </section>
  );
}

function SyncStatusResult({
  activeTenantId,
  isFirstLoad,
  showSkeleton,
  status,
}: {
  activeTenantId: string | null;
  isFirstLoad: boolean;
  showSkeleton: boolean;
  status: ReturnType<typeof useSyncStatus>;
}) {
  // --- Idle: no tenant selected yet ----------------------------------------
  if (activeTenantId === null) {
    return (
      <EmptyState
        kind="idle"
        title="Chưa chọn đơn vị"
        description="Nhập mã đơn vị rồi bấm “Xem đơn vị này” để xem lần đồng bộ gần nhất."
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

  return (
    <div className="space-y-6">
      <SyncRunSummary run={run} />

      {run.counts ? (
        <>
          <SyncCountsGrid counts={run.counts} />
          <SyncIssuesTable
            issues={run.issues}
            total={run.counts.issuesTotal}
            truncated={run.counts.issuesTruncated}
          />
        </>
      ) : (
        <EmptyState
          kind="done"
          title="Lần chạy này chưa có số liệu"
          description="Số liệu chỉ được ghi khi lần đồng bộ kết thúc. Nếu trạng thái vẫn là “Đang chạy”, hãy đợi rồi tải lại trang."
        />
      )}
    </div>
  );
}
