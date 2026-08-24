"use client";

import Link from "next/link";
import { useMemo } from "react";

import {
  dedupeChannelsAcrossGroups,
  groupToggleViews,
} from "@/ui/components/channels/channel-option-labels";
import { ChannelIdText } from "@/ui/components/channels/ChannelNameCell";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { Button } from "@/ui/components/ui/button";
import type { ChannelGroup } from "@/ui/schemas/channel-group.schema";
import type { Channel } from "@/ui/schemas/channel.schema";

/**
 * Channel picker of the wizard (E10.3): tick boxes with the preset groups as
 * shortcuts above them (brief §5).
 *
 * ONE ROW PER PAGE (spec §3.1). It used to render `groups.map(g =>
 * g.channelIds.map(…))`, so a Page in two groups appeared twice with two
 * checkboxes bound to the same id: ticking one lit the other, and the list
 * looked like the post was going to more Pages than it was. The list is now
 * flat and deduplicated, and each row says which groups it belongs to —
 * `dedupeChannelsAcrossGroups` owns that rule and is tested directly.
 *
 * A checkbox per channel, not a multi-select: the operator must SEE every
 * channel a post is about to go to. The group boxes stay as the "chọn nhanh cả
 * nhóm" shortcut and reflect their children (indeterminate when only some are
 * ticked) instead of pretending to be a separate value.
 *
 * Presentational: selection state and fetching both live in the parent.
 */
export function ChannelGroupPicker({
  groups,
  channels,
  selected,
  onToggleChannel,
  onToggleGroup,
  loading,
  error,
  onRetry,
  disabled,
}: {
  groups: readonly ChannelGroup[];
  /**
   * The tenant's Pages, for naming the rows. `undefined` means the list is NOT
   * KNOWN yet (loading, or the request failed): every row then shows its id and
   * stays tickable — a slow query must not turn this into a screen where
   * nothing can be run.
   */
  channels?: readonly Channel[];
  selected: ReadonlySet<string>;
  onToggleChannel: (channelId: string, checked: boolean) => void;
  onToggleGroup: (channelIds: readonly string[], checked: boolean) => void;
  loading: boolean;
  error?: unknown;
  onRetry: () => void;
  disabled?: boolean;
}) {
  // Hooks run before any early return — the rule is cheap and pure, and the
  // rendered branches below still return first.
  const rows = useMemo(() => dedupeChannelsAcrossGroups(groups, channels), [groups, channels]);
  // What each shortcut may tick, and what its counter may claim — both derived
  // from the rows below, so the two can never disagree.
  const toggles = useMemo(() => groupToggleViews(groups, rows), [groups, rows]);

  if (loading) {
    return (
      <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">
        {[0, 1].map((card) => (
          <div key={card} className="space-y-2 rounded-lg border p-3">
            <div className="bg-muted h-4 w-40 rounded" />
            <div className="bg-muted h-4 w-56 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return <ApiErrorNotice error={error} onRetry={onRetry} />;
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        kind="first-run"
        title="Chưa có nhóm kênh nào"
        description="Bài đăng cần ít nhất một kênh. Hãy tạo nhóm kênh trước — chỉ mất một lần, sau đó màn này sẽ hiện danh sách để tick."
        action={
          <Button asChild variant="outline">
            <Link href="/channels?tab=groups">Tạo nhóm kênh</Link>
          </Button>
        }
      />
    );
  }

  // A tenant CAN own groups that hold nothing (or hold only blank ids). Saying
  // so beats an empty box under a heading that promises a list.
  if (rows.length === 0) {
    return (
      <EmptyState
        kind="no-result"
        title="Các nhóm kênh hiện chưa có Page nào"
        description="Nhóm đã tạo nhưng chưa gán Page nào vào. Thêm Page vào nhóm rồi quay lại màn này."
        action={
          <Button asChild variant="outline">
            <Link href="/channels?tab=groups">Sửa nhóm kênh</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* The shortcuts first, the truth second: a group box only ADDS or
          REMOVES its ids in the flat list below, which stays the single place
          where "bài này sẽ lên những Page nào" can be read. */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-muted-foreground pb-1 text-xs">Chọn nhanh theo nhóm</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {toggles.map((toggle) => {
            // Denominator = the rows this group owns in the list below, blocked
            // ones included: an operator counting rows must reach the same
            // number. `group.channelIds.length` counted blanks and duplicates
            // the list had already merged away.
            const total = toggle.rowIds.length;
            const checkedCount = toggle.rowIds.filter((id) => selected.has(id)).length;
            // "Everything that CAN be on is on". A blocked row can never be
            // ticked, so requiring it here would leave the box permanently
            // half-lit and the shortcut permanently useless; the counter next
            // to it is what tells the operator the group is not all green.
            const allChecked =
              toggle.selectableIds.length > 0 &&
              toggle.selectableIds.every((id) => selected.has(id));
            const empty = total === 0;

            return (
              <label
                key={toggle.groupId}
                className={`flex items-center gap-2.5 text-xs font-medium ${
                  empty ? "opacity-70" : "cursor-pointer"
                }`}
              >
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={allChecked}
                  // Partial selection must not look like "none" (a11y + honesty).
                  ref={(node) => {
                    if (node) node.indeterminate = checkedCount > 0 && !allChecked;
                  }}
                  // A group with nothing tickable has no action to offer.
                  disabled={disabled || toggle.selectableIds.length === 0}
                  // ONLY the ids a click may legally add: handing the raw group
                  // over used to push switched-off and removed Pages into the
                  // run, where they could only come back blocked.
                  onChange={(event) => onToggleGroup(toggle.selectableIds, event.target.checked)}
                />
                <CheckBox />
                {toggle.name}
                {empty ? (
                  // Never "0/1": the fraction would be counting an id that is
                  // not on screen and cannot be ticked.
                  <span className="text-muted-foreground font-normal">(chưa có Page)</span>
                ) : (
                  <span className="text-muted-foreground font-normal">
                    {checkedCount}/{total}
                    {toggle.blockedCount > 0
                      ? ` · ${toggle.blockedCount} không đăng được`
                      : ""}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-muted-foreground pb-1 text-xs">
          Danh sách Page · {rows.length} Page
        </legend>
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const blocked = !row.selectable;
            return (
              <li key={row.channelId}>
                <label
                  className={`bg-card border-border has-checked:border-primary has-checked:bg-accent/20 has-focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-xl border p-3 transition-colors has-focus-visible:ring-3 ${
                    blocked ? "opacity-70" : "cursor-pointer"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={selected.has(row.channelId)}
                    // A Page that is switched off, or an id whose Page has been
                    // removed, can only ever produce a blocked job — so it
                    // cannot be ticked. It is still LISTED, with the reason:
                    // a group that claims three Pages while the list offers two
                    // is exactly the silence business rule 5 forbids.
                    disabled={disabled || blocked}
                    onChange={(event) => onToggleChannel(row.channelId, event.target.checked)}
                  />
                  <CheckBox />
                  <span className="min-w-0 flex-1">
                    {row.name !== null ? (
                      <span className="block text-sm font-medium break-words">{row.name}</span>
                    ) : null}
                    <ChannelIdText id={row.channelId} />
                    {row.groupNames.length > 0 ? (
                      <span className="text-muted-foreground mt-0.5 block text-xs">
                        Thuộc nhóm: {row.groupNames.join(" · ")}
                      </span>
                    ) : null}
                    {blocked ? (
                      <span className="text-warning-foreground mt-0.5 block text-xs">
                        {row.note === "disabled"
                          ? "Kênh đang tắt — bật lại ở màn Kênh trước khi đăng."
                          : "Không còn trong danh sách kênh — hãy sửa lại nhóm ở màn Kênh."}
                      </span>
                    ) : null}
                  </span>
                  <span className="bg-info/15 text-info-foreground shrink-0 rounded-full px-2 py-0.5 text-xs">
                    Page
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
    </div>
  );
}

/**
 * The drawn box for a `sr-only` checkbox that sits immediately before it.
 * The native input keeps the role, the keyboard behaviour and — crucially for
 * the group box — the indeterminate state, which no drawn box can announce.
 */
function CheckBox() {
  return (
    <span
      aria-hidden="true"
      className="border-input bg-card peer-checked:bg-primary peer-checked:border-primary peer-indeterminate:bg-primary/40 peer-indeterminate:border-primary peer-disabled:opacity-50 text-primary-foreground peer-checked:[&>span]:inline flex size-4 shrink-0 items-center justify-center rounded-sm border-2 text-xs transition-colors"
    >
      {/* Written from the box's own rule: the tick is a descendant of the
          peer's sibling, which `peer-checked:` alone would never reach. */}
      <span className="hidden">✓</span>
    </span>
  );
}
