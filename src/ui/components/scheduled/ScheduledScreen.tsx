"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { CancelDialog } from "@/ui/components/scheduled/CancelDialog";
import { RescheduleDialog } from "@/ui/components/scheduled/RescheduleDialog";
import { ScheduledJobTable } from "@/ui/components/scheduled/ScheduledJobTable";
import { ScheduledSkeleton } from "@/ui/components/scheduled/ScheduledSkeleton";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { Select } from "@/ui/components/ui/select";
import { useChannelGroups } from "@/ui/hooks/useChannelGroups";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useNowMs } from "@/ui/hooks/useNowMs";
import {
  SCHEDULED_DIALOG_PARAMS,
  formatDayHeading,
  groupScheduledByDay,
  hasScheduledFilter,
  isDateOnly,
  parseScheduledFilter,
  scheduledSearchParams,
  timeZoneLabel,
  type ScheduledFilter,
} from "@/ui/schemas/scheduled.schema";
import { DEMO_TENANT_ID } from "@/ui/schemas/tenant-health.schema";
import {
  useCancelScheduledJob,
  useReschedulePostJob,
  useScheduledJobs,
} from "@/ui/hooks/useScheduledJobs";

/**
 * "Bài đã hẹn" (E8.4): component -> hook -> service -> internal API.
 *
 * Soonest first, grouped by day: the screen answers "cái gì sắp lên?", so the
 * next event is at the top and the operator reads a timeline, not a table dump.
 *
 * The filter AND the two dialogs live in the URL (core-data-list-query rule 1 +
 * web-crud-inline-edit rule 1): `/scheduled?channelId=fbpage-a&doi-gio=<id>` is
 * shareable, survives F5 and makes Back behave. `useState` for a modal would
 * lose all three.
 *
 * The four mandatory states:
 *   loading — skeleton with the real day groups + five columns, delayed 300ms
 *   data    — day groups + "Tải thêm" (cursor, so no page numbers)
 *   empty   — told apart: "chưa có bài nào được hẹn giờ" (nothing scheduled) vs
 *             "không có bài nào khớp bộ lọc" (a filter is on)
 *   error   — 4xx (sửa bộ lọc) vs 5xx (thử lại), via `presentApiError`
 */
export function ScheduledScreen() {
  // Phase 1 is single-tenant in the UI; E10.4 will read it from the session.
  const tenantId = DEMO_TENANT_ID;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const channelFilterId = useId();
  const fromId = useId();
  const toId = useId();
  const nowMs = useNowMs();

  const filter = useMemo(
    () => parseScheduledFilter(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const list = useScheduledJobs(tenantId, filter);
  const groups = useChannelGroups(tenantId);
  const reschedule = useReschedulePostJob(tenantId);
  const cancel = useCancelScheduledJob(tenantId);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const isFirstLoad = list.isPending && list.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const dayGroups = useMemo(() => groupScheduledByDay(items), [items]);
  const filtered = hasScheduledFilter(filter);

  /** Channel ids the tenant actually uses, from the preset groups (E7.6). */
  const channelOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const group of groups.data?.groups ?? []) {
      for (const channelId of group.channelIds) ids.add(channelId);
    }
    // Keep the active filter selectable even when its group was deleted, or the
    // select would silently jump back to "Tất cả kênh" while the URL says else.
    if (filter.channelId) ids.add(filter.channelId);
    return [...ids].sort((a, b) => a.localeCompare(b, "vi"));
  }, [groups.data, filter.channelId]);

  const rescheduleId = searchParams.get(SCHEDULED_DIALOG_PARAMS.reschedule)?.trim() ?? "";
  const cancelId = searchParams.get(SCHEDULED_DIALOG_PARAMS.cancel)?.trim() ?? "";
  const rescheduleJob = items.find((item) => item.postJobId === rescheduleId) ?? null;
  const cancelJob = items.find((item) => item.postJobId === cancelId) ?? null;

  function pushFilter(next: ScheduledFilter) {
    setNotice(null);
    setWarning(null);
    const query = scheduledSearchParams(next).toString();
    // `replace`: changing a filter is not a navigation step to walk back to.
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function hrefForDialog(action: "reschedule" | "cancel", postJobId: string): string {
    const params = scheduledSearchParams(filter);
    params.set(SCHEDULED_DIALOG_PARAMS[action], postJobId);
    return `${pathname}?${params.toString()}`;
  }

  /** Closing a dialog only drops its parameter — the filter must survive. */
  function closeDialogs() {
    reschedule.reset();
    cancel.reset();
    const query = scheduledSearchParams(filter).toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function handleReschedule(params: { postJobId: string; scheduledAt: string }) {
    setNotice(null);
    setWarning(null);
    reschedule.mutate(params, {
      onSuccess: (result) => {
        setNotice(result.userMessage);
        // A leftover delayed entry can still fire at the OLD hour: publish-post
        // only guards on status, so an early post is possible. Say it.
        if (!result.previousQueueEntryRemoved) {
          setWarning(
            "Đã lưu giờ mới, nhưng không xoá được lịch cũ trong hàng đợi — bài vẫn có thể lên vào giờ cũ. Hãy theo dõi ở Nhật ký đăng bài.",
          );
        }
        closeDialogs();
      },
      // The error stays inside the dialog so the chosen time is not lost.
    });
  }

  function handleCancel(params: { postJobId: string; note?: string }) {
    setNotice(null);
    setWarning(null);
    cancel.mutate(params, {
      onSuccess: (result) => {
        setNotice(result.userMessage);
        if (!result.queueEntryRemoved) {
          setWarning(
            "Đã huỷ trong hệ thống, nhưng không xoá được lịch cũ trong hàng đợi. Bài vẫn sẽ KHÔNG lên (trạng thái đã là “Bị chặn”), chỉ là hàng đợi còn một mục thừa.",
          );
        }
        closeDialogs();
      },
    });
  }

  return (
    <section className="space-y-6" aria-labelledby="scheduled-heading">
      <header className="space-y-1">
        <h1 id="scheduled-heading" className="text-2xl font-semibold tracking-tight">
          Bài đã hẹn
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Những bài đang chờ tới giờ đăng, sớm nhất ở trên. Giờ hiển thị theo múi giờ máy bạn (
          {timeZoneLabel()}). Đổi giờ hoặc huỷ chỉ được trước khi tới giờ — tồn kho vẫn được kiểm
          tra lại ngay trước khi đăng.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 basis-64 space-y-1.5">
          <label htmlFor={channelFilterId} className="text-sm font-medium">
            Lọc theo kênh
          </label>
          <Select
            id={channelFilterId}
            value={filter.channelId ?? ""}
            onChange={(event) =>
              pushFilter({ ...filter, channelId: event.target.value || null })
            }
          >
            <option value="">Tất cả kênh</option>
            {channelOptions.map((channelId) => (
              <option key={channelId} value={channelId}>
                {channelId}
              </option>
            ))}
          </Select>
        </div>

        <div className="min-w-0 basis-44 space-y-1.5">
          <label htmlFor={fromId} className="text-sm font-medium">
            Từ ngày
          </label>
          <Input
            id={fromId}
            type="date"
            value={filter.from ?? ""}
            max={filter.to ?? undefined}
            onChange={(event) => {
              const value = event.target.value;
              pushFilter({ ...filter, from: isDateOnly(value) ? value : null });
            }}
          />
        </div>

        <div className="min-w-0 basis-44 space-y-1.5">
          <label htmlFor={toId} className="text-sm font-medium">
            Đến hết ngày
          </label>
          <Input
            id={toId}
            type="date"
            value={filter.to ?? ""}
            min={filter.from ?? undefined}
            onChange={(event) => {
              const value = event.target.value;
              pushFilter({ ...filter, to: isDateOnly(value) ? value : null });
            }}
          />
        </div>

        {filtered ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => pushFilter({ channelId: null, from: null, to: null })}
          >
            Bỏ bộ lọc
          </Button>
        ) : null}

        <Button
          type="button"
          variant="outline"
          onClick={() => void list.refetch()}
          disabled={list.isFetching}
        >
          {list.isFetching ? "Đang tải…" : "Tải lại"}
        </Button>
      </div>

      {groups.isError ? (
        <p className="text-muted-foreground text-sm">
          Không tải được danh sách nhóm kênh nên ô lọc kênh đang trống. Bộ lọc ngày vẫn dùng được.
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="border-success/30 bg-success/10 text-success-foreground rounded-lg border px-3 py-2 text-sm"
        >
          {notice}
        </p>
      ) : null}

      {warning ? (
        <p
          role="alert"
          className="border-warning/40 bg-warning/10 text-warning-foreground rounded-lg border px-3 py-2 text-sm"
        >
          {warning}{" "}
          <Link href="/jobs" className="underline underline-offset-4">
            Mở nhật ký đăng bài
          </Link>
          .
        </p>
      ) : null}

      {isFirstLoad ? showSkeleton ? <ScheduledSkeleton /> : null : null}

      {list.isError && items.length === 0 ? (
        <ApiErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      ) : null}

      {!isFirstLoad && !list.isError && items.length === 0 ? (
        filtered ? (
          <EmptyState
            kind="no-result"
            title="Không có bài hẹn nào khớp bộ lọc"
            description="Không có bài nào được hẹn trong khoảng thời gian hoặc trên kênh đang chọn. Dữ liệu vẫn còn nguyên — bỏ bộ lọc để xem toàn bộ."
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => pushFilter({ channelId: null, from: null, to: null })}
              >
                Bỏ bộ lọc
              </Button>
            }
          />
        ) : (
          <EmptyState
            kind="first-run"
            title="Chưa có bài nào được hẹn giờ"
            description="Khi soạn bài hoặc chạy hàng loạt, chọn “Hẹn giờ đăng” thay vì “Đăng ngay” — những bài đang chờ tới giờ sẽ hiện ở đây."
            action={
              <Button asChild>
                <Link href="/compose">Soạn bài</Link>
              </Button>
            }
          />
        )
      ) : null}

      {items.length > 0 ? (
        <>
          <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
            Đang hiển thị {items.length.toLocaleString("vi-VN")} bài đã hẹn
            {list.hasNextPage ? " (còn nữa)" : ""}.
          </p>

          <div className="space-y-6">
            {dayGroups.map((group) => {
              const headingId = `scheduled-day-${group.dayKey}`;
              return (
                <section key={group.dayKey} className="space-y-2">
                  <h2 id={headingId} className="text-base font-semibold">
                    {/* nowMs is 0 only on the server: the heading then shows the
                        full date, never a wrong "Hôm nay". */}
                    {formatDayHeading(group.dayKey, nowMs)}
                    <span className="text-muted-foreground ml-2 text-sm font-normal">
                      {group.items.length} bài
                    </span>
                  </h2>
                  <ScheduledJobTable
                    items={group.items}
                    headingId={headingId}
                    nowMs={nowMs}
                    hrefFor={hrefForDialog}
                    busyJobId={
                      reschedule.isPending
                        ? (reschedule.variables?.postJobId ?? null)
                        : cancel.isPending
                          ? (cancel.variables?.postJobId ?? null)
                          : null
                    }
                  />
                </section>
              );
            })}
          </div>

          {list.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? "Đang tải…" : "Tải thêm"}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-center text-sm">Đã hết danh sách.</p>
          )}
        </>
      ) : null}

      {rescheduleId.length > 0 ? (
        <RescheduleDialog
          // Remounts per row: the field must start from THAT job's hour, and a
          // stale error from the previous row must not survive.
          key={rescheduleId}
          job={rescheduleJob}
          open
          onOpenChange={(open) => {
            if (!open) closeDialogs();
          }}
          onSubmit={handleReschedule}
          isPending={reschedule.isPending}
          error={reschedule.isError ? reschedule.error : null}
        />
      ) : null}

      {cancelId.length > 0 ? (
        <CancelDialog
          key={cancelId}
          job={cancelJob}
          open
          onOpenChange={(open) => {
            if (!open) closeDialogs();
          }}
          onSubmit={handleCancel}
          isPending={cancel.isPending}
          error={cancel.isError ? cancel.error : null}
        />
      ) : null}
    </section>
  );
}
