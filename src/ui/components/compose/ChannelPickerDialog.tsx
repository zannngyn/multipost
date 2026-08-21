"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";

import { cn } from "@/shared/utils";
import {
  applyChannelGroup,
  avatarToneStyle,
  channelBlockReason,
  channelInitials,
  draftOnOpenChange,
  filterChannels,
  groupPayloadFrom,
  matchingGroupId,
  publishableChannels,
  selectAllVisible,
  toggleChannelId,
  visibleRows,
} from "@/ui/components/compose/channel-picker";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/ui/components/ui/dialog";
import { useChannelGroups, useCreateChannelGroup } from "@/ui/hooks/useChannelGroups";
import { useChannels } from "@/ui/hooks/useChannels";
import type { ChannelGroup } from "@/ui/schemas/channel-group.schema";

/**
 * "Chọn kênh đăng" — the modal of the ComposeFocus design (template 161–191).
 *
 * Structure, top to bottom, as the mock draws it:
 *   heading (163) · ô "Tìm page" (165) · NHÓM CÓ SẴN + pills + "+ Tạo nhóm"
 *   (166–172) · FACEBOOK · N page + "Chọn tất cả" (173–177) · rows with a
 *   square checkbox, a round initials avatar and the Page name (178–185) ·
 *   "Xem thêm N page" (186) · footer: "Đã chọn N page" · "Lưu thành nhóm" ·
 *   "Xong" (187–191).
 *
 * THE ONE BEHAVIOUR RULE: ticking in here is a DRAFT. Nothing reaches the post
 * until "Xong" is pressed, and Escape or a click outside leaves the previously
 * applied selection exactly as it was. A picker that wrote straight through
 * would mean closing the box by accident changes where a post goes.
 *
 * Radix Dialog does the parts a hand-rolled modal always gets wrong: focus in
 * on open, focus back to the trigger on close, `Esc`, `aria-modal`, and the
 * page behind made inert (core-accessibility).
 *
 * Pressing a group chip ADDS the group to what is ticked (`applyChannelGroup`)
 * instead of replacing it, so two groups can be pressed in a row and a Page
 * ticked by hand survives. A group that cannot be loaded at all does not block
 * the dialog: the row says so and the list underneath still works.
 *
 * What the mock shows and this cannot: follower counts ("128K theo dõi", 184).
 * Nothing in this system stores them — see the handover note; the column shows
 * the channel's on/off state instead, which is a fact we do have and one that
 * decides whether the post can go out at all.
 */
export function ChannelPickerDialog({
  open,
  onOpenChange,
  applied,
  onApply,
  readOnlyReason,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selection currently on the post. */
  applied: ReadonlySet<string>;
  onApply: (channelIds: string[]) => void;
  /** Support mode: writing is off. Ticking still works, saving a group does not. */
  readOnlyReason?: string | null;
}) {
  const titleId = useId();
  const channels = useChannels();
  const groups = useChannelGroups();
  const createGroup = useCreateChannelGroup();

  const [draft, setDraft] = useState<ReadonlySet<string>>(applied);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [groupName, setGroupName] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Re-seeds the draft every time the modal opens. Adjusting state during
   * render (React's documented alternative to an effect): an effect would let
   * one frame of the previous draft show before it was reset.
   */
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setDraft(draftOnOpenChange({ open, wasOpen, applied, draft }));
    if (open) {
      setQuery("");
      setExpanded(false);
      setGroupName(null);
      setGroupError(null);
      setNotice(null);
      createGroup.reset();
    }
  }

  const all = publishableChannels(channels.data?.channels ?? []);
  const filtered = filterChannels(all, query);
  const { rows, hidden } = visibleRows(filtered, expanded);
  const groupItems = groups.data?.groups ?? [];
  const activeGroupId = matchingGroupId(groupItems, draft);
  /**
   * The Pages a group press may actually tick. A disabled Page is listed (so it
   * can explain itself) but cannot be published to, so `applyChannelGroup` is
   * given the publishable ids only and the row below counts what it left out.
   */
  const activeIds = all
    .filter((channel) => channelBlockReason(channel) === null)
    .map((channel) => channel.channelId);

  /** One group press: union into the draft, then say what could not come. */
  function pressGroup(group: ChannelGroup) {
    const next = applyChannelGroup([...draft], group.channelIds, activeIds);
    // Everything the press could have kept and did not — from the group AND
    // from what was already ticked, because a Page switched off since it was
    // chosen leaves the same way and must not leave silently.
    const asked = new Set([...draft, ...group.channelIds]);
    const lost = [...asked].filter((id) => !next.includes(id));
    setDraft(new Set(next));
    setNotice(
      lost.length > 0
        ? `${lost.length} kênh của nhóm “${group.name}” không đăng được (đã gỡ khỏi danh sách hoặc đang tắt) nên không được tick.`
        : null,
    );
  }

  function saveGroup() {
    // The server's own rules, checked locally with the SAME sentences so the
    // operator is never told two different things about one field.
    const payload = groupPayloadFrom(groupName ?? "", draft);
    if (!payload.ok) {
      setGroupError(payload.message);
      return;
    }
    setGroupError(null);
    createGroup.mutate(payload.value, {
      onSuccess: (group) => {
        setGroupName(null);
        setNotice(`Đã lưu ${group.channelCount} kênh thành nhóm “${group.name}”.`);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-labelledby={titleId}
        className="bg-card text-foreground max-w-160 gap-0 overflow-hidden rounded-xl border-0 p-0"
      >
        <div className="px-6 py-5 shadow-[inset_0_-1px_0_var(--border)]">
          <DialogTitle id={titleId} className="text-[19px] font-semibold">
            Chọn kênh đăng
          </DialogTitle>
          <DialogDescription className="sr-only">
            Tick từng Page hoặc chọn một nhóm có sẵn. Lựa chọn chỉ áp vào bài khi bạn bấm “Xong”.
          </DialogDescription>
        </div>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-6 py-5">
          <label htmlFor={`${titleId}-q`} className="sr-only">
            Tìm page
          </label>
          <input
            id={`${titleId}-q`}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setExpanded(false);
            }}
            placeholder="Tìm page"
            className="focus-visible:ring-ring h-11.5 rounded-md border-0 bg-[var(--card)] px-4 text-sm shadow-[inset_0_0_0_1.5px_var(--input)] outline-none focus-visible:ring-3"
          />

          {/* --- Nhóm có sẵn (166–172) --------------------------------------- */}
          <section aria-labelledby={`${titleId}-groups`} className="flex flex-col gap-2.5">
            <h3
              id={`${titleId}-groups`}
              className="font-mono text-[10px] tracking-[0.1em] text-[var(--foreground-subtle)] uppercase"
            >
              Nhóm có sẵn
            </h3>

            {groups.isError ? (
              <ApiErrorNotice error={groups.error} onRetry={() => void groups.refetch()} />
            ) : (
              <div className="flex flex-wrap gap-2.5">
                {groupItems.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    aria-pressed={group.id === activeGroupId}
                    onClick={() => pressGroup(group)}
                    className={cn(
                      "focus-visible:ring-ring h-10 cursor-pointer rounded-lg px-4.5 text-sm font-medium transition-colors outline-none focus-visible:ring-3",
                      group.id === activeGroupId
                        ? "bg-primary text-primary-foreground"
                        : "bg-card shadow-[inset_0_0_0_1px_var(--input)]",
                    )}
                  >
                    {group.name}
                    <span className="sr-only"> — thêm {group.channelCount} kênh vào lựa chọn</span>
                  </button>
                ))}

                {groupItems.length === 0 && !groups.isPending ? (
                  <p className="text-[13px] text-[var(--muted-foreground)]">
                    Chưa có nhóm nào. Tick vài Page rồi bấm “Lưu thành nhóm” để dùng lại lần sau.
                  </p>
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    setGroupName(groupName === null ? "" : null);
                    setGroupError(null);
                  }}
                  aria-expanded={groupName !== null}
                  className="focus-visible:ring-ring h-10 cursor-pointer rounded-lg border-0 px-4.5 text-sm text-[var(--muted-foreground)] shadow-[inset_0_0_0_1.5px_var(--input)] outline-none focus-visible:ring-3"
                >
                  + Tạo nhóm
                </button>
              </div>
            )}

            {groupName !== null ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <label htmlFor={`${titleId}-group-name`} className="sr-only">
                    Tên nhóm kênh mới
                  </label>
                  <input
                    id={`${titleId}-group-name`}
                    value={groupName}
                    onChange={(event) => setGroupName(event.target.value)}
                    placeholder="Tên nhóm, ví dụ: Bộ 5 page chính"
                    aria-invalid={Boolean(groupError)}
                    className="focus-visible:ring-ring h-10 min-w-60 flex-1 rounded-lg border-0 bg-[var(--card)] px-3.5 text-sm shadow-[inset_0_0_0_1.5px_var(--input)] outline-none focus-visible:ring-3"
                  />
                  <button
                    type="button"
                    onClick={saveGroup}
                    disabled={createGroup.isPending || Boolean(readOnlyReason)}
                    title={readOnlyReason ?? undefined}
                    className="focus-visible:ring-ring h-10 cursor-pointer rounded-lg bg-[var(--card)] px-4 text-sm font-semibold text-[var(--primary)] shadow-[inset_0_0_0_1px_var(--input)] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {createGroup.isPending ? "Đang lưu…" : "Lưu nhóm"}
                  </button>
                </div>

                {groupError ? (
                  <p role="alert" className="text-xs text-[var(--destructive)]">
                    {groupError}
                  </p>
                ) : null}
                {readOnlyReason ? (
                  <p className="text-xs text-[var(--muted-foreground)]">{readOnlyReason}</p>
                ) : null}
                {createGroup.isError ? <ApiErrorNotice error={createGroup.error} /> : null}
              </div>
            ) : null}
          </section>

          {/* --- Facebook · N page (173–186) --------------------------------- */}
          <section aria-labelledby={`${titleId}-list`} className="flex flex-col">
            <div className="flex items-center gap-3 pb-2.5">
              <h3
                id={`${titleId}-list`}
                className="font-mono text-[10px] tracking-[0.1em] text-[var(--foreground-subtle)] uppercase"
              >
                Facebook · {all.length} page
              </h3>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setDraft(selectAllVisible(draft, filtered))}
                disabled={filtered.length === 0}
                className="focus-visible:ring-ring cursor-pointer rounded-md text-[13px] font-semibold text-[var(--primary)] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Chọn tất cả
              </button>
            </div>

            {channels.isPending ? (
              <ul aria-hidden="true" className="flex flex-col motion-safe:animate-pulse">
                {[0, 1, 2].map((row) => (
                  <li key={row} className="flex h-15 items-center gap-3.5">
                    <span className="size-5.5 rounded-sm bg-[var(--muted)]" />
                    <span className="size-8.5 rounded-full bg-[var(--muted)]" />
                    <span className="h-3.5 w-40 rounded bg-[var(--muted)]" />
                  </li>
                ))}
              </ul>
            ) : channels.isError ? (
              <ApiErrorNotice error={channels.error} onRetry={() => void channels.refetch()} />
            ) : all.length === 0 ? (
              <div className="flex flex-col items-start gap-2 py-4">
                <p className="text-sm font-medium">Chưa có Page nào</p>
                <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
                  Bài đăng cần ít nhất một Fanpage. Kết nối Facebook ở màn Kênh — chỉ làm một lần.
                </p>
                <Link
                  href="/channels"
                  className="text-[13px] font-semibold text-[var(--primary)] underline underline-offset-4"
                >
                  Mở màn Kênh
                </Link>
              </div>
            ) : filtered.length === 0 ? (
              <p className="py-4 text-[13px] text-[var(--muted-foreground)]">
                Không có Page nào khớp “{query.trim()}”. Xoá bớt từ khoá để xem lại danh sách.
              </p>
            ) : (
              <ul className="flex flex-col">
                {rows.map((channel) => {
                  const blocked = channelBlockReason(channel);
                  const checked = draft.has(channel.channelId);

                  return (
                    <li key={channel.channelId}>
                      <label
                        className={cn(
                          "flex h-15 items-center gap-3.5 shadow-[inset_0_-1px_0_var(--border)]",
                          blocked ? "cursor-not-allowed opacity-55" : "cursor-pointer",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="peer sr-only"
                          checked={checked}
                          disabled={Boolean(blocked)}
                          onChange={(event) =>
                            setDraft((current) =>
                              toggleChannelId(current, channel.channelId, event.target.checked),
                            )
                          }
                        />
                        {/* Drawn box for the sr-only input immediately before it:
                            the native control keeps the role and the keyboard. */}
                        <span
                          aria-hidden="true"
                          className="peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-ring/50 bg-card peer-checked:[&>svg]:block flex size-5.5 shrink-0 items-center justify-center rounded-sm shadow-[inset_0_0_0_1.5px_var(--input)] peer-checked:shadow-[inset_0_0_0_1.5px_var(--primary)] peer-focus-visible:ring-3"
                        >
                          <Check aria-hidden="true" className="hidden size-3.5" strokeWidth={3} />
                        </span>

                        <span
                          aria-hidden="true"
                          style={avatarToneStyle(channel.name)}
                          className="flex size-8.5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                        >
                          {channelInitials(channel.name)}
                        </span>

                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-sm font-medium">
                            {channel.name.trim().length > 0
                              ? channel.name
                              : "(Page chưa có tên)"}
                          </span>
                          {blocked ? (
                            <span className="text-xs text-[var(--warning-foreground)]">
                              {blocked}
                            </span>
                          ) : null}
                        </span>

                        <span className="flex-1" />
                        {/* The mock puts follower counts here; we have none, so
                            this says the one thing that decides whether the post
                            can go out at all. */}
                        <span className="shrink-0 text-[13px] text-[var(--foreground-subtle)]">
                          {channel.status === "active" ? "Đang bật" : "Đã tắt"}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}

            {hidden > 0 || expanded ? (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="focus-visible:ring-ring cursor-pointer self-start rounded-md pt-3.5 text-sm font-semibold text-[var(--primary)] outline-none focus-visible:ring-3"
              >
                {expanded ? "Thu gọn danh sách" : `Xem thêm ${hidden} page`}
              </button>
            ) : null}
          </section>

          {notice ? (
            <p role="status" className="text-xs text-[var(--muted-foreground)]">
              {notice}
            </p>
          ) : null}
        </div>

        {/* --- Footer (187–191) --------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-3.5 bg-[var(--muted)] px-6 py-4.5 shadow-[inset_0_1px_0_var(--border)]">
          <p className="text-[13px] text-[var(--muted-foreground)]">
            Đã chọn {draft.size} page
          </p>
          <span className="flex-1" />

          <button
            type="button"
            onClick={() => {
              setGroupName((current) => (current === null ? "" : current));
              setGroupError(null);
            }}
            disabled={draft.size === 0 || Boolean(readOnlyReason)}
            title={readOnlyReason ?? undefined}
            className="focus-visible:ring-ring h-12 cursor-pointer rounded-xl bg-[var(--card)] px-6 text-sm font-semibold shadow-[inset_0_0_0_1px_var(--input)] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Lưu thành nhóm
          </button>

          <button
            type="button"
            onClick={() => {
              onApply([...draft]);
              onOpenChange(false);
            }}
            className="focus-visible:ring-ring h-12 cursor-pointer rounded-xl bg-primary text-primary-foreground px-8 text-sm font-semibold outline-none focus-visible:ring-3"
          >
            Xong
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
