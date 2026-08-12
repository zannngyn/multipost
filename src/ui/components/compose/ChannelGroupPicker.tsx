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
            <Link href="/channels">Tạo nhóm kênh</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const checkedCount = group.channelIds.filter((id) => selected.has(id)).length;
        const allChecked = checkedCount === group.channelIds.length && checkedCount > 0;

        return (
          <fieldset key={group.id} className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{group.name}</legend>

            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                className="accent-primary size-4"
                checked={allChecked}
                // Partial selection must not look like "none" (a11y + honesty).
                ref={(node) => {
                  if (node) node.indeterminate = checkedCount > 0 && !allChecked;
                }}
                disabled={disabled}
                onChange={(event) => onToggleGroup(group.channelIds, event.target.checked)}
              />
              Chọn cả nhóm ({checkedCount}/{group.channelIds.length})
            </label>

            <ul className="space-y-1 pl-6">
              {group.channelIds.map((channelId) => (
                <li key={channelId}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="accent-primary size-4"
                      checked={selected.has(channelId)}
                      disabled={disabled}
                      onChange={(event) => onToggleChannel(channelId, event.target.checked)}
                    />
                    <span className="font-mono text-xs break-all">{channelId}</span>
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
