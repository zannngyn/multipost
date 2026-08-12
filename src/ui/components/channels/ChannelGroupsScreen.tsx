"use client";

import Link from "next/link";
import { useState } from "react";

import { ChannelGroupForm } from "@/ui/components/channels/ChannelGroupForm";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import {
  useChannelGroups,
  useCreateChannelGroup,
  useDeleteChannelGroup,
  useUpdateChannelGroup,
} from "@/ui/hooks/useChannelGroups";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { formatChannelIds } from "@/ui/schemas/channel-group.schema";
import { formatDateTime } from "@/ui/schemas/post-batch.schema";
import { DEMO_TENANT_ID } from "@/ui/schemas/tenant-health.schema";

/**
 * "Nhóm kênh" (E7.6 / E10.3): component -> hook -> service -> internal API.
 *
 * A group is a SHORTCUT for the wizard's channel picker, never an authority:
 * fan-out still creates one post_job per channel and the publish rules (kiểm
 * tồn lần 2, giãn cách, khoá chống trùng) are untouched by what is ticked here.
 *
 * The four mandatory states:
 *   loading — skeleton cards, delayed 300ms
 *   data    — one card per group, each with edit + delete
 *   empty   — first-run box explaining what a group is for
 *   error   — via `presentApiError` (4xx: sửa dữ liệu; 5xx: thử lại)
 *
 * Delete asks first, in place — a two-step button instead of `confirm()`, which
 * cannot be styled, cannot be read properly by a screen reader on every browser
 * and blocks the main thread.
 */
export function ChannelGroupsScreen() {
  // Phase 1 is single-tenant in the UI; E10.4 will read it from the session.
  const tenantId = DEMO_TENANT_ID;
  const groups = useChannelGroups(tenantId);
  const create = useCreateChannelGroup(tenantId);
  const update = useUpdateChannelGroup(tenantId);
  const remove = useDeleteChannelGroup(tenantId);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const isFirstLoad = groups.isPending && groups.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);
  const items = groups.data?.groups ?? [];

  return (
    <section className="space-y-6" aria-labelledby="channels-heading">
      <header className="space-y-1">
        <h1 id="channels-heading" className="text-2xl font-semibold tracking-tight">
          Nhóm kênh
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Gom sẵn các kênh hay đăng cùng nhau để ở màn soạn bài chỉ cần tick một lần. Nhóm chỉ là
          lối tắt chọn kênh — mọi quy tắc đăng (kiểm tồn, giãn cách, chống trùng) vẫn giữ nguyên.
        </p>
      </header>

      <section
        aria-labelledby="channels-create-heading"
        className="bg-card space-y-4 rounded-xl border p-5"
      >
        <h2 id="channels-create-heading" className="text-base font-semibold">
          Tạo nhóm mới
        </h2>
        <ChannelGroupForm
          mode="create"
          pending={create.isPending}
          error={create.isError ? create.error : undefined}
          onSubmit={(values) => {
            create.reset();
            create.mutate(values);
          }}
        />
        {create.isSuccess ? (
          <p
            role="status"
            className="border-success/30 bg-success/10 text-success-foreground rounded-lg border px-3 py-2 text-sm"
          >
            Đã tạo nhóm “{create.data.name}” với {create.data.channelCount} kênh.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="channels-list-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="channels-list-heading" className="text-base font-semibold">
            Nhóm đã lưu
          </h2>
          {/* Only once the list is real: "0 nhóm" while loading reads as an
              answer, and the operator would act on it. */}
          {groups.data ? (
            <p className="text-muted-foreground text-sm tabular-nums">{items.length} nhóm</p>
          ) : null}
        </div>

        {isFirstLoad ? showSkeleton ? <ChannelGroupsSkeleton /> : null : null}

        {groups.isError && items.length === 0 ? (
          <ApiErrorNotice error={groups.error} onRetry={() => void groups.refetch()} />
        ) : null}

        {remove.isError ? <ApiErrorNotice error={remove.error} /> : null}

        {!isFirstLoad && !groups.isError && items.length === 0 ? (
          <EmptyState
            kind="first-run"
            title="Chưa có nhóm kênh nào"
            description="Tạo nhóm đầu tiên bằng biểu mẫu phía trên. Khi đã có nhóm, màn soạn bài sẽ hiện danh sách kênh theo nhóm để tick nhanh."
            action={
              <Button asChild variant="outline">
                <Link href="/compose">Về màn soạn bài</Link>
              </Button>
            }
          />
        ) : null}

        <ul className="space-y-3">
          {items.map((group) => (
            <li key={group.id} className="bg-card space-y-3 rounded-xl border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{group.name}</h3>
                <Badge tone="info">{group.channelCount} kênh</Badge>
              </div>

              <ul className="flex flex-wrap gap-1.5">
                {group.channelIds.map((channelId) => (
                  <li
                    key={channelId}
                    className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 font-mono text-xs break-all"
                  >
                    {channelId}
                  </li>
                ))}
              </ul>

              <p className="text-muted-foreground text-xs tabular-nums">
                Cập nhật: {formatDateTime(group.updatedAt)}
              </p>

              {editingId === group.id ? (
                <div className="border-t pt-3">
                  <ChannelGroupForm
                    mode="edit"
                    defaultValues={{
                      name: group.name,
                      channelIdsText: formatChannelIds(group.channelIds),
                    }}
                    pending={update.isPending}
                    error={update.isError ? update.error : undefined}
                    onCancel={() => {
                      update.reset();
                      setEditingId(null);
                    }}
                    onSubmit={(values) => {
                      update.reset();
                      update.mutate(
                        { groupId: group.id, ...values },
                        { onSuccess: () => setEditingId(null) },
                      );
                    }}
                  />
                </div>
              ) : confirmingId === group.id ? (
                <div
                  role="alertdialog"
                  aria-label={`Xác nhận xoá nhóm ${group.name}`}
                  className="border-destructive/30 bg-destructive/5 space-y-2 rounded-lg border p-3"
                >
                  <p className="text-sm">
                    Xoá nhóm “{group.name}”? Các bài đã đăng không bị ảnh hưởng — chỉ mất lối tắt
                    chọn kênh này.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={remove.isPending}
                      onClick={() => {
                        remove.reset();
                        remove.mutate(
                          { groupId: group.id },
                          { onSuccess: () => setConfirmingId(null) },
                        );
                      }}
                    >
                      {remove.isPending ? "Đang xoá…" : "Xoá nhóm"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setConfirmingId(null)}
                      disabled={remove.isPending}
                    >
                      Giữ lại
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      update.reset();
                      setConfirmingId(null);
                      setEditingId(group.id);
                    }}
                  >
                    Sửa
                    <span className="sr-only"> nhóm {group.name}</span>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      remove.reset();
                      setEditingId(null);
                      setConfirmingId(group.id);
                    }}
                  >
                    Xoá
                    <span className="sr-only"> nhóm {group.name}</span>
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

/** Same card shape as a real group row — no jump when the data lands. */
function ChannelGroupsSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">
      {[0, 1].map((card) => (
        <div key={card} className="bg-card space-y-3 rounded-xl border p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="bg-muted h-4 w-40 rounded" />
            <div className="bg-muted h-5 w-16 rounded-full" />
          </div>
          <div className="flex gap-1.5">
            <div className="bg-muted h-5 w-24 rounded-md" />
            <div className="bg-muted h-5 w-28 rounded-md" />
          </div>
          <div className="bg-muted h-3 w-48 rounded" />
        </div>
      ))}
    </div>
  );
}
