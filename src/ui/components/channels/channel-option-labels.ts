import {
  CHANNEL_NO_NAME,
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
 * it wrong means posting to the wrong Page.
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
 * WHY THIS MERGES AND THE "Nhóm kênh" SCREEN DOES NOT: a group that lists the
 * same id twice is corrupt data. Here it must be merged — this screen is where
 * an operator decides where a post goes, and two checkboxes bound to one id
 * make the post look like it goes to two Pages. `ChannelGroupsScreen` renders
 * one chip PER STORED ENTRY on purpose (wave 1): that screen is where the
 * corrupt group is repaired, and merging there would hide the very duplicate
 * the operator has to delete.
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
      if (typeof rawId !== "string") continue;
      // TRIMMED, and the trimmed form is what the row carries: the name lookup
      // trims (`resolveGroupChannelLabels`), so keying the row on the raw string
      // would make " fb-a " and "fb-a" two rows that resolve to one Page — and
      // the ticked value handed to the API would keep the stray space.
      const id = rawId.trim();
      if (id.length === 0) continue;

      const existing = groupNames.get(id);
      if (!existing) {
        order.push(id);
        groupNames.set(id, name.length > 0 ? [name] : []);
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
  // The placeholder names nothing, so the id rides along: "(Page chưa có tên)"
  // on its own cannot tell two nameless Pages apart, and this string is the
  // only thing a screen reader or a dialog gets.
  const base =
    label.name === CHANNEL_NO_NAME
      ? `${CHANNEL_NO_NAME} · ${shortenId(channelId, CHANNEL_ID_KEEP)}`
      : label.name;
  return label.note === "disabled" ? `${base} (đang tắt)` : base;
}

/**
 * `channelSentenceName` for a caller holding ONE id and no index.
 *
 * Convenience only — a list must still resolve once with `channelLabelIndex`
 * rather than calling this per row.
 */
export function channelNameOf(
  channelId: string,
  channels: readonly Channel[] | undefined,
): string {
  return channelSentenceName(channelId, channelLabelIndex([channelId], channels));
}

/**
 * Marks a `groupId` this module invented because the payload had none.
 *
 * English, like every other identifier in the codebase: this string is a REACT
 * KEY and never reaches the screen (the row prints `name`), so the rule that
 * user-facing text is Vietnamese does not apply — the rule that code is English
 * does. The colon keeps it outside the shape any stored id can take.
 */
const GROUP_WITHOUT_ID_PREFIX = "group-without-id:#";

export interface GroupToggleView {
  /**
   * The group's stored id, trimmed — or a positional stand-in when the payload
   * arrived without one. It identifies a ROW ON SCREEN (the React key); a write
   * still reads `group.id` from the group itself.
   */
  readonly groupId: string;
  readonly name: string;
  /** Distinct, non-blank ids of this group that HAVE a row in the flat list. */
  readonly rowIds: readonly string[];
  /** The subset of `rowIds` a click may actually tick. */
  readonly selectableIds: readonly string[];
  /** Rows this group owns that can never be ticked (switched off / removed). */
  readonly blockedCount: number;
}

/**
 * What a "chọn cả nhóm" shortcut may do, and what its counter may claim.
 *
 * TWO BUGS THIS CLOSES:
 *   1. the shortcut used to hand `group.channelIds` straight to the parent, so
 *      pressing it ticked Pages that are switched off or no longer exist — ids
 *      that then travelled into `run.start` and could only come back blocked.
 *      Only `selectableIds` leaves this function.
 *   2. the counter's denominator used to be `group.channelIds.length`, which
 *      counts blanks and duplicates the flat list below has already merged
 *      away: "1/3" under a list showing two rows. `rowIds` is exactly the set
 *      of rows this group owns down there.
 *
 * A group with no row at all keeps its entry (it exists, and hiding it would
 * hide the problem) but has nothing to count and nothing to tick — the caller
 * renders it as "chưa có Page", never as "0/1".
 *
 * A group with no usable ID keeps its entry too, on a stand-in key. The schema
 * promises `id` is non-blank, but this function is already defensive about
 * every other field of the same payload, and here the failure is silent: the
 * caller keys its rows on `groupId`, so two id-less groups would share a React
 * key and start swapping tick state with each other.
 */
export function groupToggleViews(
  groups: readonly ChannelGroup[],
  rows: readonly BulkChannelRow[],
): readonly GroupToggleView[] {
  if (!Array.isArray(groups) || groups.length === 0) return [];

  const byId = new Map(rows.map((row) => [row.channelId, row]));

  return groups.map((group, index) => {
    const rowIds: string[] = [];
    const selectableIds: string[] = [];
    const seen = new Set<string>();

    for (const rawId of group?.channelIds ?? []) {
      if (typeof rawId !== "string") continue;
      const id = rawId.trim();
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);

      const row = byId.get(id);
      // No row means the flat list is not showing this id (it was dropped as
      // blank, or the caller passed rows built from other groups). Counting it
      // would put the shortcut and the list back out of step.
      if (!row) continue;

      rowIds.push(id);
      if (row.selectable) selectableIds.push(id);
    }

    const storedId = typeof group?.id === "string" ? group.id.trim() : "";

    return {
      // Positional, so two id-less groups never collide; prefixed so it cannot
      // be mistaken for — or collide with — a real stored id.
      groupId: storedId.length > 0 ? storedId : `${GROUP_WITHOUT_ID_PREFIX}${index}`,
      name: group.name,
      rowIds,
      selectableIds,
      blockedCount: rowIds.length - selectableIds.length,
    };
  });
}

export interface SelectionPrune {
  /** What may stay ticked, in the order it was given. */
  readonly next: readonly string[];
  /** What was dropped, already named for a sentence. */
  readonly removedLabels: readonly string[];
  readonly changed: boolean;
}

/**
 * The selection, re-checked against the channel list that has just arrived.
 *
 * THE RACE: /bulk renders its Pages before `useChannels` answers, so during
 * that window every row is tickable (an unknown list may accuse nothing). If
 * the answer then says a ticked Page is switched off or gone, the selection is
 * carrying an id that can only produce a blocked job — and the operator would
 * find out from the result table, one code at a time.
 *
 * `channels === undefined` prunes NOTHING: no answer is not an answer.
 *
 * The caller must say what was dropped (business rule 5) — hence `removedLabels`
 * rather than a bare count.
 */
export function pruneSelection(
  selected: Iterable<string>,
  channels: readonly Channel[] | undefined,
): SelectionPrune {
  const ids = [...(selected ?? [])];
  // --- Edge cases first ------------------------------------------------------
  if (ids.length === 0 || channels === undefined) {
    return { next: ids, removedLabels: [], changed: false };
  }

  const index = channelLabelIndex(ids, channels);
  const next: string[] = [];
  const removedLabels: string[] = [];

  for (const id of ids) {
    const note = index.get(id)?.note ?? "none";
    if (note === "none") {
      next.push(id);
      continue;
    }
    removedLabels.push(channelSentenceName(id, index));
  }

  return { next, removedLabels, changed: removedLabels.length > 0 };
}
