import { CHANNEL_ID_KEEP } from "@/ui/components/channels/channel-option-labels";
import type { GroupChannelLabel } from "@/ui/components/channels/channel-group-labels";
import { shortenId } from "@/ui/schemas/catalog.schema";

/**
 * The one way this app prints a channel: NAME first, id underneath (wave 1,
 * JobLogTable). Written once so the log, the schedule and the batch table
 * cannot drift into three different shapes of the same cell
 * (core-component-reuse).
 *
 * Presentational: the caller resolves the label (`channelLabelIndex`) so the
 * rule runs ONCE per list rather than once per row.
 */
export function ChannelNameCell({
  channelId,
  label,
}: {
  channelId: string;
  /**
   * `undefined` means the caller could not resolve this id at all — treated
   * exactly like an unknown channel list: print the id, accuse nothing.
   */
  label: GroupChannelLabel | undefined;
}) {
  if (label && label.name !== null) {
    return (
      <>
        {/* The name may wrap (it is prose); the id may not. */}
        <span className="block break-words">{label.name}</span>
        <ChannelIdText id={channelId} />
        {label.note === "disabled" ? (
          <span className="text-muted-foreground mt-0.5 block text-xs">(đang tắt)</span>
        ) : null}
      </>
    );
  }

  return (
    <>
      <ChannelIdText id={channelId} />
      {/* Only when the list IS known and this id is not in it. While it is
          loading, `note` is "none" and this says nothing — accusing a Page of
          being removed because a query is slow sends someone hunting. */}
      {label?.note === "removed" ? (
        <span className="text-muted-foreground mt-0.5 block text-xs">(đã gỡ)</span>
      ) : null}
    </>
  );
}

/**
 * A Page id in a narrow column: middle-truncated, never broken mid-string.
 *
 * The MIDDLE, not the end: two Pages of one shop share a long prefix, so a
 * head-only truncation shows two rows that look identical. `title` carries the
 * full value for a pointer, and the `sr-only` copy carries it for a screen
 * reader — the id is what an operator quotes to support, so it must remain
 * readable in full by someone who cannot hover.
 */
export function ChannelIdText({ id }: { id: string }) {
  return (
    <span className="text-muted-foreground mt-0.5 block font-mono text-xs whitespace-nowrap">
      <span aria-hidden="true" title={id}>
        {shortenId(id, CHANNEL_ID_KEEP)}
      </span>
      <span className="sr-only">{id}</span>
    </span>
  );
}
