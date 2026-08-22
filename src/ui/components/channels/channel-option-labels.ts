import {
  resolveGroupChannelLabels,
  type GroupChannelLabel,
} from "@/ui/components/channels/channel-group-labels";
import { shortenId } from "@/ui/schemas/catalog.schema";
import type { ChannelGroup } from "@/ui/schemas/channel-group.schema";
import type { Channel } from "@/ui/schemas/channel.schema";

/**
 * Turning channel IDS into what an operator can actually read (spec §3.1).
 *
 * `fb-1121597217877301` is not a Page an operator recognises — it is a string
 * they can only compare character by character. Every screen that used to print
 * one now prints the NAME, and keeps the id as the secondary, mono line for
 * quoting to support. The rule itself lives here, out of React, because getting
 * it wrong means posting to the wrong Fanpage.
 *
 * Built on `resolveGroupChannelLabels` (wave 1) so there is ONE answer to
 * "what do we say about this channel id" — including its most important clause:
 * an unknown channel list accuses nothing of being removed.
 */

/**
 * How many characters of a Page id survive on each side of the ellipsis.
 *
 * 8, not the `shortenId` default of 6: a Facebook Page id is 19 characters
 * (`fb-` + 16 digits), and at 6 the visible tail was too short to tell two ids
 * of one shop apart — the exact job the shortened form has to do.
 */
export const CHANNEL_ID_KEEP = 8;

/**
 * Every id asked about, indexed by id — ONE `resolveGroupChannelLabels` call.
 *
 * The rule rebuilds a Map of every channel each time it runs, so calling it per
 * row made naming a 200-row table O(rows × channels) (wave 1, M-1). Callers
 * resolve the whole list once and look each row up here.
 */
export function channelLabelIndex(
  channelIds: readonly string[],
  channels: readonly Channel[] | undefined,
): ReadonlyMap<string, GroupChannelLabel> {
  const unique = [...new Set(channelIds)];
  const labels = resolveGroupChannelLabels(unique, channels);
  return new Map(labels.map((label) => [label.channelId, label]));
}

export interface ChannelFilterOption {
  /** The id — what the URL and the API still speak. */
  readonly value: string;
  /** What the operator reads. */
  readonly label: string;
}

/**
 * Options for a NATIVE `<select>` (the "Lọc theo kênh" field of /posts).
 *
 * A native option holds one string, so the wave-1 "name on top, id underneath"
 * shape is impossible here. The rules, in order of how much they matter:
 *
 *   - name only, normally — the id is noise in a filter
 *   - name + id when TWO Pages share a name, because then the name alone picks
 *     the wrong one and the operator has no way to see it
 *   - "(đang tắt)" / "(đã gỡ)" said in WORDS, never by a colour or by silence:
 *     the filter keeps offering the id the URL already carries, so it must say
 *     why that choice may return nothing
 *   - the raw id while the channel list is not known yet — no name to give and
 *     nothing to accuse
 *
 * Sorted by the label, not by the id: the list is read alphabetically by a
 * person, and `localeCompare(…, "vi")` is what orders "Áo" before "Zen".
 */
export function channelFilterOptions(
  channelIds: readonly string[],
  channels: readonly Channel[] | undefined,
): readonly ChannelFilterOption[] {
  const unique = [...new Set(channelIds)].filter((id) => id.trim().length > 0);
  if (unique.length === 0) return [];

  const index = channelLabelIndex(unique, channels);

  // Which names are worn by more than one Page — only those need their id back.
  const nameCount = new Map<string, number>();
  for (const id of unique) {
    const name = index.get(id)?.name;
    if (name === null || name === undefined) continue;
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
  }

  const options = unique.map((id) => {
    const label = index.get(id);
    // No name to show: either the list is unknown (note "none" — say nothing)
    // or the Page left it (note "removed" — say so).
    if (!label || label.name === null) {
      return {
        value: id,
        label: label?.note === "removed" ? `${shortenId(id, CHANNEL_ID_KEEP)} (đã gỡ)` : id,
      };
    }

    const ambiguous = (nameCount.get(label.name) ?? 0) > 1;
    const base = ambiguous ? `${label.name} · ${shortenId(id, CHANNEL_ID_KEEP)}` : label.name;
    return { value: id, label: label.note === "disabled" ? `${base} (đang tắt)` : base };
  });

  return options.sort((a, b) => a.label.localeCompare(b.label, "vi"));
}

export interface BulkChannelRow {
  readonly channelId: string;
  /** `null` when there is no name to show — the row prints the id instead. */
  readonly name: string | null;
  readonly note: GroupChannelLabel["note"];
  /** Every preset group holding this Page, in the order the groups arrived. */
  readonly groupNames: readonly string[];
  /** False when ticking it could only ever produce a blocked job. */
  readonly selectable: boolean;
}

/**
 * The flat Page list of "Chạy hàng loạt" (/bulk), one row per Page.
 *
 * THE BUG THIS FIXES: the screen rendered `groups.map(group => group.channelIds
 * .map(…))`, so a Page belonging to "Nhóm sáng" AND "Nhóm chiều" appeared
 * TWICE, with two checkboxes wired to the same id — ticking one silently ticked
 * the other, and the count under the list read like the post was going to more
 * Pages than it was. One Page, one row, and the groups it belongs to written on
 * that row instead.
 *
 * Order is the first group that names the Page, then that group's own order:
 * the operator built the groups, so their reading order is the one they expect.
 *
 * NOTHING IS HIDDEN (business rule 5). A Page that is switched off, or an id
 * whose Page has been removed, still gets a row — it just cannot be ticked, and
 * the row says why. Dropping it would leave an operator staring at a group that
 * claims three Pages while the list offers two, with no way to find out why.
 *
 * `channels === undefined` (loading, or the request failed) means the list is
 * NOT KNOWN: every row stays selectable and nothing is called removed, so a slow
 * query cannot turn this screen into one where nothing may be run.
 */
export function dedupeChannelsAcrossGroups(
  groups: readonly ChannelGroup[],
  channels: readonly Channel[] | undefined,
): readonly BulkChannelRow[] {
  // --- Edge cases first ------------------------------------------------------
  if (!Array.isArray(groups) || groups.length === 0) return [];

  /** id -> the group names holding it, deduplicated, in arrival order. */
  const order: string[] = [];
  const groupNames = new Map<string, string[]>();

  for (const group of groups) {
    const name = typeof group?.name === "string" ? group.name.trim() : "";
    for (const rawId of group?.channelIds ?? []) {
      // A blank id is corrupt data, not a Page: it can be neither named nor
      // ticked, and a nameless empty row would only look like a bug.
      if (typeof rawId !== "string" || rawId.trim().length === 0) continue;

      const existing = groupNames.get(rawId);
      if (!existing) {
        order.push(rawId);
        groupNames.set(rawId, name.length > 0 ? [name] : []);
        continue;
      }
      if (name.length > 0 && !existing.includes(name)) existing.push(name);
    }
  }

  const index = channelLabelIndex(order, channels);

  return order.map((channelId) => {
    const label = index.get(channelId);
    const note = label?.note ?? "none";
    return {
      channelId,
      name: label?.name ?? null,
      note,
      groupNames: groupNames.get(channelId) ?? [],
      selectable: note === "none",
    };
  });
}

/**
 * What to SAY about a channel in a sentence — a button's accessible name, a
 * dialog description, a warning. Never markup, so it also works inside a
 * template string.
 *
 * The id is the fallback of last resort: a sentence reading "trên kênh
 * fb-1121597217877301" is one an operator cannot act on, but an empty one is
 * worse.
 */
export function channelSentenceName(
  channelId: string,
  index: ReadonlyMap<string, GroupChannelLabel>,
): string {
  const label = index.get(channelId);
  if (!label || label.name === null) {
    return label?.note === "removed"
      ? `${shortenId(channelId, CHANNEL_ID_KEEP)} (đã gỡ)`
      : channelId;
  }
  return label.note === "disabled" ? `${label.name} (đang tắt)` : label.name;
}
