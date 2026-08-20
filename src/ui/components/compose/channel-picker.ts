import { ChannelGroupFormSchema, type ChannelGroup } from "@/ui/schemas/channel-group.schema";
import type { Channel } from "@/ui/schemas/channel.schema";

/**
 * Pure rules of the "Chọn kênh đăng" modal (ComposeFocus template 161–191).
 *
 * Everything here decides WHICH Pages a post is about to go to, so it lives
 * outside React where it can be tested directly: a wrong answer means a post
 * landing on the wrong Fanpage, which is not something a component test on a
 * rendered checkbox would reliably catch.
 */

/** How many rows the modal shows before "Xem thêm N page" (template 178, 186). */
export const CHANNEL_ROWS_BEFORE_EXPAND = 5;

/** Number of avatar washes in `compose-theme.ts` (`--compose-avatar-0..4`). */
const AVATAR_TONES = 5;

/** Casefold + strip Vietnamese marks, so "Lady" finds "Lady Fashion" and "lady". */
export function searchKey(value: string): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .trim();
}

/**
 * Initials on the round avatar (template 118, 181: "LF", "MP").
 *
 * Two letters from two words, two from one word, and "FB" when the Page has no
 * usable name at all — a Page CAN carry a blank name (`channel.schema`), and an
 * empty circle tells the operator nothing.
 */
export function channelInitials(name: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "FB";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

/**
 * Which avatar wash a Page gets. Derived from the name by a stable hash, NOT
 * from its position in the list: a Page must keep the same colour after a
 * search filters the list, or the row a person recognised by colour moves.
 */
export function avatarToneIndex(name: string): number {
  const key = (name ?? "").trim();
  if (key.length === 0) return 0;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) % 100_000;
  }
  return hash % AVATAR_TONES;
}

/** `var(--compose-avatar-N)` for a Page — the only place the index is spent. */
export function avatarToneVar(name: string): string {
  return `var(--compose-avatar-${avatarToneIndex(name)})`;
}

/**
 * The Pages this screen may offer.
 *
 * Phase 1 publishes to Facebook, so a TikTok channel has no business in this
 * list. Disabled channels ARE kept: `create-post-batch` blocks them with
 * CHANNEL_NOT_CONFIGURED, and an operator who cannot see the Page at all has no
 * way to understand why their post never went there — the row explains itself
 * instead of disappearing (business rule 5).
 */
export function publishableChannels(channels: readonly Channel[]): Channel[] {
  return channels.filter((channel) => channel.platform === "facebook");
}

/** Free-text filter over the visible name, with the ids as a fallback. */
export function filterChannels(channels: readonly Channel[], query: string): Channel[] {
  const key = searchKey(query);
  if (key.length === 0) return [...channels];
  return channels.filter(
    (channel) =>
      searchKey(channel.name).includes(key) ||
      searchKey(channel.channelId).includes(key) ||
      searchKey(channel.externalId).includes(key),
  );
}

/** A disabled channel cannot be published to — the reason, or null when it can. */
export function channelBlockReason(channel: Channel): string | null {
  if (channel.status === "active") return null;
  return "Kênh đang tắt — bật lại ở màn Kênh trước khi đăng";
}

/**
 * Which preset group the current selection IS, exactly.
 *
 * Exact match on purpose (template 170 + `.grp-on`): a pill that lit up merely
 * because the group is a subset of the selection would claim "bạn đang đăng
 * đúng nhóm này" while three other Pages are ticked.
 */
export function matchingGroupId(
  groups: readonly ChannelGroup[],
  selected: ReadonlySet<string>,
): string | null {
  for (const group of groups) {
    const ids = new Set(group.channelIds);
    if (ids.size !== selected.size) continue;
    if ([...ids].every((id) => selected.has(id))) return group.id;
  }
  return null;
}

/**
 * Picking a preset group REPLACES the selection with that group.
 *
 * The mock's pills are one-of ("Bộ 5 page chính" / "Nhóm sĩ" / "Miền Bắc"), and
 * the footer counts one number. Adding to whatever was ticked before would make
 * the lit pill a lie the moment a sixth Page is left over from the last pick.
 *
 * Channels the tenant no longer owns are dropped: a group can outlive a Page,
 * and sending an id that is not in the list would only produce a blocked job.
 */
export function selectionForGroup(
  group: ChannelGroup,
  available: readonly Channel[],
): { selected: string[]; dropped: string[] } {
  const owned = new Set(available.map((channel) => channel.channelId));
  const selected: string[] = [];
  const dropped: string[] = [];
  for (const id of group.channelIds) {
    if (owned.has(id)) selected.push(id);
    else dropped.push(id);
  }
  return { selected, dropped };
}

/** Adds or removes one id, returning a NEW set (never mutating the applied one). */
export function toggleChannelId(
  selected: ReadonlySet<string>,
  channelId: string,
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  if (checked) next.add(channelId);
  else next.delete(channelId);
  return next;
}

/**
 * "Chọn tất cả" (template 177) — every channel currently LISTED that can
 * actually be published to.
 *
 * Scoped to the filtered list on purpose: pressing it under a search reading
 * "Lady" must not silently tick twenty Pages the operator cannot see. Disabled
 * channels are skipped for the same reason the rows refuse a click.
 */
export function selectAllVisible(
  selected: ReadonlySet<string>,
  visible: readonly Channel[],
): Set<string> {
  const next = new Set(selected);
  for (const channel of visible) {
    if (channelBlockReason(channel) === null) next.add(channel.channelId);
  }
  return next;
}

/**
 * THE rule that makes the modal safe: what the draft selection becomes when the
 * dialog opens or closes.
 *
 * Opening RE-SEEDS from what is applied to the post; closing changes nothing.
 * That is what lets Escape or a click outside be harmless — the applied
 * selection was never touched, and the next open starts from it again rather
 * than from whatever half-finished ticking was abandoned last time.
 *
 * Pure, because "closing the box by accident must not change where the post
 * goes" is a rule worth a test rather than a comment.
 */
export function draftOnOpenChange(input: {
  open: boolean;
  wasOpen: boolean;
  applied: ReadonlySet<string>;
  draft: ReadonlySet<string>;
}): ReadonlySet<string> {
  const opening = input.open && !input.wasOpen;
  return opening ? new Set(input.applied) : input.draft;
}

/**
 * The body of POST /api/channel-groups, or the reason it cannot be sent.
 *
 * Validated with `ChannelGroupFormSchema` — the SAME schema the /channels/groups
 * form uses and a mirror of the server's own rules — so an empty name or a
 * selection over the limit is refused here with the sentence the server would
 * have used, instead of costing a round trip to be told the same thing.
 */
export function groupPayloadFrom(
  name: string,
  selected: ReadonlySet<string>,
):
  | { ok: true; value: { name: string; channelIds: string[] } }
  | { ok: false; message: string } {
  const parsed = ChannelGroupFormSchema.safeParse({ name, channelIds: [...selected] });
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Không lưu được nhóm kênh.",
    };
  }
  return { ok: true, value: parsed.data };
}

/** Rows to draw right now, and how many are folded away behind "Xem thêm". */
export function visibleRows(
  channels: readonly Channel[],
  expanded: boolean,
): { rows: Channel[]; hidden: number } {
  if (expanded || channels.length <= CHANNEL_ROWS_BEFORE_EXPAND) {
    return { rows: [...channels], hidden: 0 };
  }
  return {
    rows: channels.slice(0, CHANNEL_ROWS_BEFORE_EXPAND),
    hidden: channels.length - CHANNEL_ROWS_BEFORE_EXPAND,
  };
}
