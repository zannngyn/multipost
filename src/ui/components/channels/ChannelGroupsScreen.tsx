"use client";

import Link from "next/link";
import { useState } from "react";

import { resolveGroupChannelLabels } from "@/ui/components/channels/channel-group-labels";
import { ChannelGroupForm } from "@/ui/components/channels/ChannelGroupForm";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import {
  useChannelGroups,
  useCreateChannelGroup,
  useDeleteChannelGroup,
  useUpdateChannelGroup,
} from "@/ui/hooks/useChannelGroups";
import { useChannels } from "@/ui/hooks/useChannels";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { writeGate } from "@/ui/hooks/read-only-gate";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import type { Channel } from "@/ui/schemas/channel.schema";
import { formatDateTime } from "@/ui/schemas/post-batch.schema";

/**
 * "Nhóm kênh" (E7.6 / E10.3): component -> hook -> service -> internal API.
 *
 * Since the wave-1 IA this is a TAB of the "Kênh" hub (`/channels?tab=groups`),
 * not a page of its own: the hub owns the frame and the page's h1, so this
 * screen starts at h2 and its own sections at h3.
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
  const groups = useChannelGroups();
  const create = useCreateChannelGroup();
  const update = useUpdateChannelGroup();
  const remove = useDeleteChannelGroup();
  const channels = useChannels();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const isFirstLoad = groups.isPending && groups.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);
  const items = groups.data?.groups ?? [];

  /**
   * The FULL channel list, used to print names on the cards: a group may hold a
   * Page that has since been switched off, and "đang tắt" is a different fact
   * from "đã gỡ". `undefined` while the list is unknown — see
   * `resolveGroupChannelLabels`, which refuses to accuse anything of being
   * removed until it has an answer.
   */
  const knownChannels = channels.data?.channels;

  /**
   * A group may only hold channels that are actually publishable: a disabled
   * Page is skipped at publish time, so offering it here would promise a post
   * that never goes out. The picker therefore sees ACTIVE channels only.
   */
  const pickableChannels = {
    items: (channels.data?.channels ?? []).filter((channel) => channel.status === "active"),
    isLoading: channels.isPending && channels.fetchStatus === "fetching",
    error: channels.isError ? channels.error : undefined,
    onRetry: () => void channels.refetch(),
  };

  // Support mode is read-only (M3.3): creating, editing and deleting a group
  // all answer 403, so the controls go off with the reason attached rather
  // than staying live to fail.
  const readOnlyReason = useReadOnlyReason();
  const gate = writeGate(readOnlyReason);

  return (
    <section className="space-y-6" aria-labelledby="channel-groups-heading">
      <header className="space-y-1">
        <h2 id="channel-groups-heading" className="text-2xl font-semibold tracking-tight">
          Nhóm kênh
        </h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          Gom sẵn các kênh hay đăng cùng nhau để ở màn soạn bài chỉ cần tick một lần. Nhóm chỉ là
          lối tắt chọn kênh — mọi quy tắc đăng (kiểm tồn, giãn cách, chống trùng) vẫn giữ nguyên.
        </p>
      </header>

      <section
        aria-labelledby="channels-create-heading"
        className="bg-card space-y-4 rounded-xl border p-5"
      >
        <h3 id="channels-create-heading" className="text-base font-semibold">
          Tạo nhóm mới
        </h3>
        {gate.isDisabled ? (
          // The whole form goes, not just its button: a form nobody can submit
          // invites typing that gets thrown away.
          <ReadOnlyNotice reason={gate.reason} />
        ) : (
          <ChannelGroupForm
            mode="create"
            channels={pickableChannels}
            pending={create.isPending}
            error={create.isError ? create.error : undefined}
            onSubmit={(values) => {
              create.reset();
              create.mutate(values);
            }}
          />
        )}
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
          <h3 id="channels-list-heading" className="text-base font-semibold">
            Nhóm đã lưu
          </h3>
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

        {/* Partial failure (core-feedback-states §6): the groups loaded, the
            channel list did not. The cards below then have no names to print —
            say why instead of leaving the operator staring at raw ids. */}
        {channels.isError && items.length > 0 ? (
          <div className="border-warning/40 bg-warning/10 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
            <p className="text-warning-foreground">
              Chưa tải được danh sách kênh — các nhóm bên dưới đang hiện mã kênh thay cho tên Page.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={channels.isFetching}
              onClick={() => void channels.refetch()}
            >
              {channels.isFetching ? "Đang tải…" : "Thử lại"}
            </Button>
          </div>
        ) : null}

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
                <h4 className="text-sm font-semibold">{group.name}</h4>
                <Badge tone="info">{group.channelCount} kênh</Badge>
              </div>

              <GroupChannelList channelIds={group.channelIds} channels={knownChannels} />

              <p className="text-muted-foreground text-xs tabular-nums">
                Cập nhật: {formatDateTime(group.updatedAt)}
              </p>

              {editingId === group.id ? (
                <div className="border-t pt-3">
                  <ChannelGroupForm
                    mode="edit"
                    defaultValues={{
                      name: group.name,
                      channelIds: [...group.channelIds],
                    }}
                    channels={pickableChannels}
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
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={gate.isDisabled}
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
                    disabled={gate.isDisabled}
                    onClick={() => {
                      remove.reset();
                      setEditingId(null);
                      setConfirmingId(group.id);
                    }}
                  >
                    Xoá
                    <span className="sr-only"> nhóm {group.name}</span>
                  </Button>
                  {/* One line per row, next to the buttons it explains. */}
                  <ReadOnlyNotice reason={gate.reason} className="basis-full text-xs" />
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

/**
 * What is inside a group, in the operator's words.
 *
 * Names, not `channelId`s: the id is a MYSP internal key that appears nowhere
 * else the operator works, so a card full of them could not answer "nhóm này
 * đăng lên những Page nào". The id only comes back when there is no name to
 * show — and then it comes with the reason.
 */
function GroupChannelList({
  channelIds,
  channels,
}: {
  channelIds: readonly string[];
  /** `undefined` while the channel list is unknown (loading or failed). */
  channels: readonly Channel[] | undefined;
}) {
  /**
   * ONE CHIP PER STORED ENTRY — duplicates included, deliberately.
   *
   * /bulk merges an id that appears twice (`dedupeChannelsAcrossGroups`): there
   * the list answers "bài này lên những Page nào", and two boxes for one Page
   * would misstate where the post goes. HERE the list answers "nhóm này đang
   * lưu những gì", and this is the screen where a corrupt group gets repaired —
   * merging would hide the very duplicate the operator has to delete
   * (business rule 5, wave 1).
   */
  const labels = resolveGroupChannelLabels(channelIds, channels);

  // A saved group with no channel is a data problem, not an empty list to hide:
  // it can never post anything, and the operator has to see that.
  if (labels.length === 0) {
    return (
      <p className="text-warning-foreground text-xs">
        Nhóm này chưa có kênh nào — sửa nhóm và tick ít nhất một kênh, nếu không nó không dùng được
        ở màn soạn bài.
      </p>
    );
  }

  return (
    <ul className="flex flex-wrap gap-1.5">
      {labels.map((label, index) => (
        // Index in the key as well as the id: a duplicated id must still render
        // as two chips rather than collapse into one.
        <li
          key={`${label.channelId}-${index}`}
          className="bg-muted rounded-md px-2 py-0.5 text-xs break-all"
        >
          {label.name === null ? (
            <span className="text-muted-foreground font-mono">{label.channelId}</span>
          ) : (
            <span className="text-foreground">{label.name}</span>
          )}
          {label.note === "removed" ? (
            <span className="text-warning-foreground"> — đã gỡ khỏi màn Kênh</span>
          ) : null}
          {label.note === "disabled" ? (
            <span className="text-muted-foreground"> — đang tắt, sẽ bị bỏ qua khi đăng</span>
          ) : null}
        </li>
      ))}
    </ul>
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
