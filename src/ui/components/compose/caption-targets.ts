/**
 * One caption per CHANNEL (brief §7.2) — the rules, without React.
 *
 * The shape of the problem: a post goes to several Fanpages, and the brief says
 * their captions must not be identical (validator D1 on the server measures
 * "trùng > 8 từ liên tiếp"). So the screen holds two things at once:
 *
 *   base       — the caption of record, `form.captions.facebook`. It is what
 *                exists before any channel is ticked, and what "dùng chung"
 *                publishes to every channel.
 *   overrides  — `channelId -> caption`, the per-Fanpage copy. Absent means "chưa
 *                sửa riêng", NOT "rỗng": publishing falls back to `base`, which
 *                is why a post can never go out captionless by accident.
 *
 * Both already travel in the draft (`ComposeDraftPayloadSchema.captions` and
 * `.captionOverrides`) and both already reach the server
 * (`captionByChannel` in POST /api/posts/batches). Nothing about the contracts
 * changes here — this file only decides which text belongs to which channel.
 */

/** Where a generated caption should land. */
export type CaptionTarget =
  | { readonly kind: "shared" }
  | { readonly kind: "channel"; readonly channelId: string };

export const SHARED_TARGET: CaptionTarget = { kind: "shared" };

export function sameTarget(a: CaptionTarget | undefined, b: CaptionTarget): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "shared" || b.kind === "shared") return true;
  return a.channelId === b.channelId;
}

/**
 * WHICH channel the caption editor is editing, and the preview is previewing.
 * `null` = the shared caption.
 *
 * THIS IS THE FIX FOR THE BUG THAT FAILED REVIEW (20/08/2026). The editor used
 * to switch to per-channel only when MORE THAN ONE channel was ticked, while
 * `usePublishForm` built the payload from `resolveCaption` with no such
 * condition. Untick one of two channels after writing a per-channel caption and
 * the box showed the shared text while the post carried the channel's own —
 * the operator approving a string that is not the string being published, which
 * is precisely the "người duyệt" step of business rule 1 broken.
 *
 * So there is no count in here. Per-channel mode is per-channel for one channel
 * as much as for five, every path asks THIS function which channel it is on,
 * and `resolveCaption` then answers for that channel. Hiding the tab strip when
 * there is only one channel is a rendering decision and nothing more.
 *
 * A requested tab that is no longer ticked falls back to the first ticked
 * channel rather than to the shared caption: the operator is still in
 * per-channel mode, and silently showing them the shared text is how this bug
 * happened in the first place.
 */
export function activeCaptionChannel(input: {
  shareCaption: boolean;
  selectedIds: readonly string[];
  /** The tab the operator last opened, if any. */
  requested: string | null;
}): string | null {
  if (input.shareCaption) return null;
  if (input.selectedIds.length === 0) return null;
  if (input.requested && input.selectedIds.includes(input.requested)) return input.requested;
  return input.selectedIds[0];
}

export interface CaptionSources {
  readonly shareCaption: boolean;
  readonly base: string;
  readonly overrides: Readonly<Record<string, string>>;
}

/**
 * The text that will actually be published to one channel.
 *
 * MUST stay the same rule `usePublishForm.captionFor` uses to build the payload:
 * the tab an operator reads and the string the server receives being two
 * different answers is the whole class of bug this function exists to remove.
 */
export function resolveCaption(sources: CaptionSources, channelId: string): string {
  if (sources.shareCaption) return sources.base;
  const own = sources.overrides[channelId];
  return typeof own === "string" && own.trim().length > 0 ? own : sources.base;
}

/**
 * What a channel tab has to say about itself.
 *
 *  own       — it has its own text. The goal state.
 *  inherited — nothing of its own, so it will publish the shared caption. NOT an
 *              error: the post can go out. It IS worth a warning, because two
 *              Fanpages with the identical caption is what the platform reads as
 *              spam and what validator D1 refuses.
 *  empty     — neither its own text nor a shared one. This channel cannot be
 *              published, and it is named by the action bar.
 */
export type ChannelCaptionState = "own" | "inherited" | "empty";

export function channelCaptionState(
  sources: CaptionSources,
  channelId: string,
): ChannelCaptionState {
  const own = (sources.overrides[channelId] ?? "").trim();
  if (!sources.shareCaption && own.length > 0) return "own";
  if (sources.base.trim().length > 0) return "inherited";
  return own.length > 0 ? "own" : "empty";
}

/** Channels that would go out with NO text at all — the publish blockers. */
export function missingCaptionChannelIds(
  sources: CaptionSources,
  selectedIds: readonly string[],
): string[] {
  return selectedIds.filter(
    (channelId) => resolveCaption(sources, channelId).trim().length === 0,
  );
}

/** Channels that would repeat the shared caption word for word. */
export function inheritedCaptionChannelIds(
  sources: CaptionSources,
  selectedIds: readonly string[],
): string[] {
  if (sources.shareCaption) return [];
  return selectedIds.filter(
    (channelId) => channelCaptionState(sources, channelId) === "inherited",
  );
}

/**
 * Turning "dùng chung" OFF: every ticked channel starts from the caption that
 * was on screen, so nobody is handed five empty boxes and has to retype the
 * post they already approved. An override that already exists is left alone.
 */
export function seedOverridesFromBase(
  overrides: Readonly<Record<string, string>>,
  selectedIds: readonly string[],
  base: string,
): Record<string, string> {
  const next = { ...overrides };
  const seed = base.trim();
  if (seed.length === 0) return next;
  for (const channelId of selectedIds) {
    if ((next[channelId] ?? "").trim().length === 0) next[channelId] = base;
  }
  return next;
}

/**
 * Which per-channel captions would be LOST by turning "dùng chung" back on.
 *
 * The caller asks for confirmation only when this is non-empty: a confirmation
 * dialog for a switch that destroys nothing is noise, and one that is always
 * shown stops being read (core-feedback-states).
 */
export function overridesThatDifferFromBase(
  sources: CaptionSources,
  selectedIds: readonly string[],
): string[] {
  const base = sources.base.trim();
  return selectedIds.filter((channelId) => {
    const own = (sources.overrides[channelId] ?? "").trim();
    return own.length > 0 && own !== base;
  });
}
