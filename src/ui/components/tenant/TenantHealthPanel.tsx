"use client";

import { useId } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { TenantHealthCard } from "@/ui/components/tenant/TenantHealthCard";
import { TenantHealthSkeleton } from "@/ui/components/tenant/TenantHealthSkeleton";
import { Button } from "@/ui/components/ui/button";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useTenantHealth } from "@/ui/hooks/useTenantHealth";

/**
 * Walking-skeleton screen: component -> hook -> service -> internal HTTP API
 * (docs/07 §4.1). The only client component on the home page; the page itself
 * stays a Server Component.
 *
 * M1.4 removed the "Mã đơn vị (tenant)" box: nobody types a company id any
 * more. The check runs against the company of the SESSION, which is also the
 * only one the server would accept — a box that could only ever be filled with
 * one correct value was a trap, not a feature.
 *
 * Covers the four mandatory states (core-feedback-states):
 * idle (company not known yet) · loading (skeleton) · data (card) · error,
 * classified by `presentApiError` so a 4xx never offers a pointless retry.
 */
export function TenantHealthPanel() {
  const headingId = useId();
  const { isResolved, tenant } = useActiveTenant();

  const query = useTenantHealth();
  const isFirstLoad = query.isPending && query.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  return (
    <section className="space-y-4" aria-labelledby={headingId}>
      <div className="space-y-1">
        <h2 id={headingId} className="text-lg font-semibold">
          Sức khoẻ đơn vị (tenant)
        </h2>
        <p className="text-muted-foreground text-sm">
          Kiểm tra toàn tuyến: giao diện → API nội bộ → usecase → cơ sở dữ liệu. Kiểm tra chạy trên
          công ty bạn đang làm việc
          {tenant ? ` — ${tenant.name}` : ""}.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="lg"
          variant="outline"
          disabled={!isResolved || query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? "Đang kiểm tra…" : "Kiểm tra lại"}
        </Button>
      </div>

      {/* Announce state changes to screen readers without moving focus. */}
      <p className="sr-only" role="status" aria-live="polite">
        {query.isFetching ? "Đang kiểm tra đơn vị" : ""}
      </p>

      <TenantHealthResult
        isResolved={isResolved}
        showSkeleton={showSkeleton}
        isFirstLoad={isFirstLoad}
        query={query}
      />
    </section>
  );
}

function TenantHealthResult({
  isResolved,
  showSkeleton,
  isFirstLoad,
  query,
}: {
  isResolved: boolean;
  showSkeleton: boolean;
  isFirstLoad: boolean;
  query: ReturnType<typeof useTenantHealth>;
}) {
  // --- Idle: the session's company is not known yet -------------------------
  if (!isResolved) {
    return (
      <div className="text-muted-foreground bg-muted/30 rounded-xl border border-dashed p-6 text-sm">
        <p className="text-foreground font-medium">Đang xác định công ty của bạn</p>
        <p className="mt-1">
          Kiểm tra này chạy trên công ty bạn đang làm việc, nên nó chờ hệ thống trả lời bạn thuộc
          công ty nào.
        </p>
      </div>
    );
  }

  // --- Loading: skeleton, delayed so a fast answer does not flash ----------
  if (isFirstLoad) return showSkeleton ? <TenantHealthSkeleton /> : null;

  // --- Error: classified centrally; retry only where retrying can succeed --
  if (query.isError) {
    return (
      <ApiErrorNotice
        className="mx-0 max-w-none"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }

  // --- Data (with a non-blocking refresh indicator) ------------------------
  if (query.data) {
    return <TenantHealthCard data={query.data} isRefreshing={query.isFetching} />;
  }

  return null;
}
