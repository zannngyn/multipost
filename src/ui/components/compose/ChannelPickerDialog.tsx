"use client";

import Link from "next/link";
import { useId, useState } from "react";

import { cn } from "@/shared/utils";
import {
  avatarToneVar,
  channelBlockReason,
  channelInitials,
  draftOnOpenChange,
  filterChannels,
  groupPayloadFrom,
  matchingGroupId,
  publishableChannels,
  selectAllVisible,
  selectionForGroup,
  toggleChannelId,
  visibleRows,
} from "@/ui/components/compose/channel-picker";
import { COMPOSE_PALETTE } from "@/ui/components/compose/compose-theme";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/ui/components/ui/dialog";
import { useChannelGroups, useCreateChannelGroup } from "@/ui/hooks/useChannelGroups";
import { useChannels } from "@/ui/hooks/useChannels";

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
 * The palette is applied HERE as well as on the screen: the dialog renders in a
 * portal on `document.body`, outside the wrapper that defines `--compose-*`.
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
        style={COMPOSE_PALETTE}
        className="max-w-160 gap-0 overflow-hidden rounded-[var(--compose-radius-modal)] border-0 bg-[var(--card)] p-0 text-[var(--foreground)]"
      >
        <div className="px-6 py-5 shadow-[inset_0_-1px_0_var(--compose-hairline)]">
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
            className="focus-visible:ring-ring h-11.5 rounded-[var(--compose-radius-tile)] border-0 bg-[var(--card)] px-4 text-sm shadow-[inset_0_0_0_1.5px_var(--input)] outline-none focus-visible:ring-3"
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
                    onClick={() => {
                      const { selected, dropped } = selectionForGroup(group, all);
                      setDraft(new Set(selected));
                      setNotice(
                        dropped.length > 0
                          ? `Nhóm “${group.name}” có ${dropped.length} kênh không còn trong danh sách nên đã bỏ qua.`
                          : null,
                      );
                    }}
                    className={cn(
                      "focus-visible:ring-ring h-10 cursor-pointer rounded-[11px] px-4.5 text-sm font-medium transition-colors outline-none focus-visible:ring-3",
                      group.id === activeGroupId
                        ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                        : "bg-[var(--card)] shadow-[inset_0_0_0_1px_var(--compose-hairline-strong)]",
                    )}
                  >
                    {group.name}
                    <span className="sr-only"> — {group.channelCount} kênh</span>
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
                  className="focus-visible:ring-ring h-10 cursor-pointer rounded-[11px] border-0 px-4.5 text-sm text-[var(--muted-foreground)] shadow-[inset_0_0_0_1.5px_var(--compose-hairline-strong)] outline-none focus-visible:ring-3"
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
                    className="focus-visible:ring-ring h-10 min-w-60 flex-1 rounded-[11px] border-0 bg-[var(--card)] px-3.5 text-sm shadow-[inset_0_0_0_1.5px_var(--input)] outline-none focus-visible:ring-3"
                  />
                  <button
                    type="button"
                    onClick={saveGroup}
                    disabled={createGroup.isPending || Boolean(readOnlyReason)}
                    title={readOnlyReason ?? undefined}
                    className="focus-visible:ring-ring h-10 cursor-pointer rounded-[11px] bg-[var(--card)] px-4 text-sm font-semibold text-[var(--primary)] shadow-[inset_0_0_0_1px_var(--compose-hairline-strong)] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
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
                    <span className="size-5.5 rounded-[7px] bg-[var(--compose-track)]" />
                    <span className="size-8.5 rounded-full bg-[var(--compose-track)]" />
                    <span className="h-3.5 w-40 rounded bg-[var(--compose-track)]" />
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
                          "flex h-15 items-center gap-3.5 shadow-[inset_0_-1px_0_var(--compose-hairline)]",
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
                          className="peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-ring/50 peer-checked:[&>span]:inline flex size-5.5 shrink-0 items-center justify-center rounded-[7px] bg-[var(--card)] text-xs shadow-[inset_0_0_0_1.5px_var(--input)] peer-checked:shadow-[inset_0_0_0_1.5px_var(--primary)] peer-focus-visible:ring-3"
                        >
                          <span className="hidden">✓</span>
                        </span>

                        <span
                          aria-hidden="true"
                          style={{ background: avatarToneVar(channel.name) }}
                          className="flex size-8.5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
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
        <div className="flex flex-wrap items-center gap-3.5 bg-[var(--compose-well)] px-6 py-4.5 shadow-[inset_0_1px_0_var(--compose-hairline)]">
          <p className="text-[13px] text-[var(--compose-text-2)]">
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
            className="focus-visible:ring-ring h-12 cursor-pointer rounded-[13px] bg-[var(--card)] px-6 text-sm font-semibold shadow-[inset_0_0_0_1px_var(--compose-hairline-strong)] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Lưu thành nhóm
          </button>

          <button
            type="button"
            onClick={() => {
              onApply([...draft]);
              onOpenChange(false);
            }}
            className="focus-visible:ring-ring h-12 cursor-pointer rounded-[13px] bg-[var(--compose-ink)] px-8 text-sm font-semibold text-[var(--card)] outline-none focus-visible:ring-3"
          >
            Xong
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
