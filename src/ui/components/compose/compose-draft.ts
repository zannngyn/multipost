import type { ComposeDraftPayload, ComposeDraftStep } from "@/ui/schemas/post-draft.schema";

/**
 * Pure logic of the compose draft (E10). No React, no storage, no network —
 * every decision that is easy to get subtly wrong lives here where it can be
 * tested directly:
 *
 *  - which copy wins when the server and this machine both hold a draft,
 *  - whether a saved album arrangement still describes the album that came back,
 *  - what a draft is made of, and when it is worth saving at all.
 *
 * The hooks own the timers and the effects; this file owns the rules.
 */

export type ComposeDraftSource = "server" | "local";

export interface PickedComposeDraft {
  readonly payload: ComposeDraftPayload;
  readonly source: ComposeDraftSource;
}

/** `savedAt` as a number; an unparseable stamp sorts oldest instead of throwing. */
function savedAtMs(payload: ComposeDraftPayload): number {
  const parsed = Date.parse(payload.savedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * The newer of the two copies.
 *
 * The buffer wins ties-plus-one, the server wins an exact tie: the server is the
 * source of truth, and a local copy only exists to cover the seconds between two
 * autosaves. Picking the local copy on an equal stamp would let a machine whose
 * clock runs fast keep resurrecting its own version.
 */
export function pickNewerDraft(
  server: ComposeDraftPayload | null,
  local: ComposeDraftPayload | null,
): PickedComposeDraft | null {
  if (!server && !local) return null;
  if (!server) return local ? { payload: local, source: "local" } : null;
  if (!local) return { payload: server, source: "server" };

  return savedAtMs(local) > savedAtMs(server)
    ? { payload: local, source: "local" }
    : { payload: server, source: "server" };
}

export interface AlbumOrderResult<T> {
  /** The rearranged album, or null when the saved order no longer applies. */
  readonly album: T[] | null;
  /** Operator-facing reason, present only when the order was dropped. */
  readonly notice: string | null;
}

/**
 * Re-applies a saved publish order to the album that just came back from
 * compose, matching on the media id.
 *
 * It is all-or-nothing on purpose. A partial match means files were added or
 * removed on Drive since the draft was saved, and "cover first" is the one thing
 * the arrangement exists to decide — a half-applied order could silently promote
 * the wrong photo to the cover. Dropping it and SAYING so leaves the operator
 * with the server's order and a sentence explaining why.
 */
export function applyAlbumOrder<T extends { driveFileId: string }>(
  media: readonly T[],
  order: readonly string[],
): AlbumOrderResult<T> {
  // Nothing was ever rearranged (or nothing came back): keep the server's order.
  if (order.length === 0 || media.length === 0) return { album: null, notice: null };

  const byId = new Map(media.map((asset) => [asset.driveFileId, asset]));
  const arranged: T[] = [];
  for (const id of order) {
    const asset = byId.get(id);
    if (asset) arranged.push(asset);
  }

  if (arranged.length !== media.length || arranged.length !== order.length) {
    return {
      album: null,
      notice:
        "Bộ ảnh của mã này đã thay đổi so với lúc lưu nháp, nên thứ tự bạn sắp xếp trước đó không áp lại được. Hãy kiểm tra lại thứ tự ảnh, ảnh đầu tiên là ảnh bìa.",
    };
  }

  return { album: arranged, notice: null };
}

/**
 * Whether captions typed for one product must be dropped now that another one
 * has been composed.
 *
 * THE rule, in one place, used by both paths that can change what is composed:
 * a manual re-lookup and a draft restore. A caption written for MGK-A must never
 * end up under MGK-B — and dropping one silently is just as wrong, so the caller
 * always tells the operator when this returns true.
 */
export function shouldClearCaptions(
  previousKey: string | null,
  nextKey: string,
  hasCaptions: boolean,
): boolean {
  // Nothing typed = nothing to lose; no previous identity = nothing to compare.
  if (!hasCaptions) return false;
  if (previousKey === null || previousKey.length === 0) return false;
  return previousKey !== nextKey;
}

/**
 * Which step a restored draft may land on.
 *
 * Two gates, both non-negotiable:
 *  - compose refused (hết hàng, không có ảnh, mã đã đổi) → step 1, always. Step
 *    2 and 3 describe a post that does not exist, and showing them with the old
 *    draft's data is exactly the "replay a stale answer" this feature forbids;
 *  - step 3 needs a caption for every channel, the same gate the footer uses.
 */
export function restoreTargetStep(input: {
  composed: boolean;
  draftStep: ComposeDraftStep;
  everyCaption: boolean;
}): ComposeDraftStep {
  if (!input.composed) return "san-pham";
  if (input.draftStep === "xem-lai" && !input.everyCaption) return "caption";
  return input.draftStep;
}

export interface ComposeDraftSnapshot {
  step: ComposeDraftStep;
  composeKey: string;
  productCode: string;
  color: string;
  mediaKind: ComposeDraftPayload["mediaKind"];
  videoTarget: ComposeDraftPayload["videoTarget"];
  source: ComposeDraftPayload["source"];
  captions: Record<string, string>;
  captionOverrides: Record<string, string>;
  albumOrder: readonly string[];
  selectedChannelIds: readonly string[];
  shareCaption: boolean;
  schedule: ComposeDraftPayload["schedule"];
}

/**
 * Builds the payload from what is on screen.
 *
 * The whitelist is enforced by CONSTRUCTION: this function names every field it
 * copies, so there is no path by which a composed product, a stock number or a
 * signed URL can reach the draft — even if a future field appears next to them
 * in the wizard state.
 *
 * Empty entries are dropped rather than stored: an untouched channel override or
 * a blank caption is not a value the operator chose, and keeping them would grow
 * the payload towards the 64 KiB ceiling for nothing.
 */
export function buildComposeDraftPayload(
  snapshot: ComposeDraftSnapshot,
  savedAtMsValue: number = Date.now(),
): ComposeDraftPayload {
  return {
    step: snapshot.step,
    composeKey: snapshot.composeKey,
    productCode: snapshot.productCode,
    color: snapshot.color,
    mediaKind: snapshot.mediaKind,
    videoTarget: snapshot.videoTarget,
    source: snapshot.source,
    captions: withoutEmptyValues(snapshot.captions),
    captionOverrides: withoutEmptyValues(snapshot.captionOverrides),
    albumOrder: [...snapshot.albumOrder].filter((id) => id.length > 0),
    selectedChannelIds: [...snapshot.selectedChannelIds].filter((id) => id.length > 0),
    shareCaption: snapshot.shareCaption,
    schedule: { mode: snapshot.schedule.mode, value: snapshot.schedule.value },
    savedAt: new Date(
      Number.isFinite(savedAtMsValue) ? savedAtMsValue : Date.now(),
    ).toISOString(),
  };
}

function withoutEmptyValues(record: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (key.length > 0 && typeof value === "string" && value.trim().length > 0) kept[key] = value;
  }
  return kept;
}

/**
 * True when the draft holds something the operator would miss.
 *
 * Opening the screen and walking away must not create a row: a draft nobody
 * typed is noise in the table and, worse, something to "restore" on the next
 * visit. The moment anything real is on screen, autosave starts.
 */
export function isDraftWorthSaving(payload: ComposeDraftPayload): boolean {
  if (payload.productCode.trim().length > 0) return true;
  if (payload.albumOrder.length > 0) return true;
  if (payload.selectedChannelIds.length > 0) return true;
  if (payload.schedule.mode === "scheduled") return true;
  if (Object.values(payload.captions).some((text) => text.trim().length > 0)) return true;
  return Object.values(payload.captionOverrides).some((text) => text.trim().length > 0);
}

/**
 * Whether two drafts differ in CONTENT. `savedAt` is excluded: it changes on
 * every render, and comparing it would make autosave fire forever on a screen
 * nobody is touching.
 */
export function draftContentDiffers(
  previous: ComposeDraftPayload | null,
  next: ComposeDraftPayload,
): boolean {
  if (!previous) return true;
  return draftContentKey(previous) !== draftContentKey(next);
}

/**
 * Stable string identity of a draft's CONTENT — also the dependency autosave
 * watches, so the debounce restarts on a real change and not on a re-render.
 */
export function draftContentKey(payload: ComposeDraftPayload): string {
  const { savedAt: _savedAt, ...content } = payload;
  return JSON.stringify(content);
}
