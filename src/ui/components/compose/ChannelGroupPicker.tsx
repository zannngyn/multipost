"use client";

import Link from "next/link";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { Button } from "@/ui/components/ui/button";
import type { ChannelGroup } from "@/ui/schemas/channel-group.schema";

/**
 * Channel picker of the wizard (E10.3): tick boxes, grouped by preset group,
 * with one "chọn cả nhóm" box per group (brief §5).
 *
 * A checkbox per channel, not a multi-select: the operator must SEE every
 * channel a post is about to go to. The group box is a shortcut, so it reflects
 * the children (indeterminate when only some are ticked) instead of pretending
 * to be a separate value.
 *
 * Presentational: selection state and fetching both live in the parent.
 */
export function ChannelGroupPicker({
  groups,
  selected,
  onToggleChannel,
  onToggleGroup,
  loading,
  error,
  onRetry,
  disabled,
}: {
  groups: readonly ChannelGroup[];
  selected: ReadonlySet<string>;
  onToggleChannel: (channelId: string, checked: boolean) => void;
  onToggleGroup: (channelIds: readonly string[], checked: boolean) => void;
  loading: boolean;
  error?: unknown;
  onRetry: () => void;
  disabled?: boolean;
}) {
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
            <Link href="/channels/groups">Tạo nhóm kênh</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const checkedCount = group.channelIds.filter((id) => selected.has(id)).length;
        const allChecked = checkedCount === group.channelIds.length && checkedCount > 0;

        return (
          <fieldset key={group.id} className="flex flex-col gap-2">
            <legend className="text-muted-foreground pb-1 text-xs">
              {group.name} · {checkedCount}/{group.channelIds.length}
            </legend>

            <label className="flex cursor-pointer items-center gap-2.5 text-xs font-medium">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={allChecked}
                // Partial selection must not look like "none" (a11y + honesty).
                ref={(node) => {
                  if (node) node.indeterminate = checkedCount > 0 && !allChecked;
                }}
                disabled={disabled}
                onChange={(event) => onToggleGroup(group.channelIds, event.target.checked)}
              />
              <CheckBox />
              Chọn cả nhóm
            </label>

            <ul className="flex flex-col gap-2">
              {group.channelIds.map((channelId) => (
                <li key={channelId}>
                  <label className="bg-card border-border has-checked:border-primary has-checked:bg-accent/20 has-focus-visible:ring-ring/50 flex cursor-pointer items-center gap-2.5 rounded-xl border p-3 transition-colors has-focus-visible:ring-3">
                    <input
                      type="checkbox"
                      className="peer sr-only"
                      checked={selected.has(channelId)}
                      disabled={disabled}
                      onChange={(event) => onToggleChannel(channelId, event.target.checked)}
                    />
                    <CheckBox />
                    <span className="min-w-0 flex-1 font-mono text-xs break-all">{channelId}</span>
                    <span className="bg-info/15 text-info-foreground shrink-0 rounded-full px-2 py-0.5 text-xs">
                      Fanpage
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        );
      })}
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
      className="border-input bg-card peer-checked:bg-primary peer-checked:border-primary peer-indeterminate:bg-primary/40 peer-indeterminate:border-primary text-primary-foreground peer-checked:[&>span]:inline flex size-4 shrink-0 items-center justify-center rounded-sm border-2 text-xs transition-colors"
    >
      {/* Written from the box's own rule: the tick is a descendant of the
          peer's sibling, which `peer-checked:` alone would never reach. */}
      <span className="hidden">✓</span>
    </span>
  );
}
