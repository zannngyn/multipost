import type { Channel } from "@/ui/schemas/channel.schema";

/**
 * What a channel group's card says about one of its channels.
 *
 * `note` is the difference the operator acts on:
 *   none     — a live Page, name shown
 *   disabled — the Page exists but is switched off, so it will be SKIPPED when
 *              posting; the group still holds it
 *   removed  — the id is not in the channel list any more (gỡ khỏi màn Kênh);
 *              there is no name to show, so the raw id is
 */
export type GroupChannelNote = "none" | "disabled" | "removed";

export interface GroupChannelLabel {
  readonly channelId: string;
  /** `null` when there is no name to show — render the id instead. */
  readonly name: string | null;
  readonly note: GroupChannelNote;
}

/**
 * Same placeholder the channel table and the group form use for a blank name.
 *
 * Exported so callers can TELL IT APART from a real name: a sentence built on
 * the placeholder alone identifies nothing, and has to carry the id too.
 */
export const CHANNEL_NO_NAME = "(Page chưa có tên)";

/**
 * Group ids → what to print on the card.
 *
 * `channels === undefined` means the channel list is NOT KNOWN yet (loading, or
 * the request failed). In that case nothing is called "đã gỡ": a screen that
 * says a channel was removed while it is merely still loading would send the
 * operator to fix a group that is perfectly fine.
 *
 * Pure so the rule can be tested without rendering; the caller passes
 * `useChannels().data?.channels` straight in. It reads the FULL list, not the
 * active-only one the picker uses — a disabled Page is still a Page.
 */
export function resolveGroupChannelLabels(
  channelIds: readonly string[],
  channels: readonly Channel[] | undefined,
): readonly GroupChannelLabel[] {
  // Not known yet: name nothing, accuse nothing.
  if (channels === undefined) {
    return channelIds.map((channelId) => ({ channelId, name: null, note: "none" as const }));
  }

  const byId = new Map(channels.map((channel) => [channel.channelId, channel]));

  // Every id gets a row, including a blank or duplicated one: a group of three
  // must never render as two (business rule 5 — nothing disappears silently).
  return channelIds.map((channelId) => {
    const found = typeof channelId === "string" ? byId.get(channelId.trim()) : undefined;
    if (!found) return { channelId, name: null, note: "removed" as const };

    const name = found.name.trim();
    return {
      channelId,
      name: name.length > 0 ? name : CHANNEL_NO_NAME,
      note: found.status === "active" ? ("none" as const) : ("disabled" as const),
    };
  });
}
