"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWatch } from "react-hook-form";

import {
  buildComposeDraftPayload,
  draftContentKey,
  isDraftWorthSaving,
  pickNewerDraft,
  type ComposeDraftSnapshot,
} from "@/ui/components/compose/compose-draft";
import type { ComposeWizard } from "@/ui/hooks/useComposeWizard";
import type { PublishForm } from "@/ui/hooks/usePublishForm";
import type { ComposeDraftPayload } from "@/ui/schemas/post-draft.schema";
import { TENANT_ID_PATTERN } from "@/ui/schemas/tenant-health.schema";
import { ApiError } from "@/ui/services/api-error";
import { ANONYMOUS_OWNER_KEY, composeDraftBuffer } from "@/ui/services/compose-draft-buffer";
import {
  beaconComposeDraft,
  discardComposeDraft,
  fetchComposeDraft,
  saveComposeDraft,
} from "@/ui/services/draft.api";

/**
 * E10 — the compose screen's anti-data-loss layer (docs/07 §4.1).
 *
 * The shape of the problem, and the answer to each half:
 *
 *  - WHAT is saved: only what the operator typed. `buildComposeDraftPayload`
 *    names every field it copies, so no composed content, stock, price or
 *    signed URL has a path into a draft (business rule 2).
 *  - WHERE it lives: the server row is the source of truth — it survives a new
 *    machine. `localStorage` is a buffer for the seconds between two PUTs. On
 *    mount both are read and the NEWER one wins.
 *  - WHEN it is written: local after ~400ms of quiet, server after ~1500ms, plus
 *    a flush on `pagehide` / hidden. Never on `beforeunload`: that one disables
 *    the bfcache and does not fire reliably when a mobile tab is discarded.
 *  - HOW it comes back: the input is re-filled and compose RE-RUNS for real, so
 *    the Sheet is read again and the stock gate runs again (business rule 3). A
 *    draft restores a question, never an answer.
 *
 * Storage is read in an effect, never during render: the server has no
 * `localStorage`, and reading it at render time is a hydration mismatch waiting
 * to happen (web-state-architecture rule 5).
 */

/** Local mirror: short enough to survive a closed tab, long enough not to churn. */
const LOCAL_DEBOUNCE_MS = 400;
/** Server autosave: one row write per pause, not one per keystroke. */
const SERVER_DEBOUNCE_MS = 1_500;

export type ComposeDraftPhase =
  /** Reading the two copies (and re-composing) on mount. */
  | "restoring"
  /** Nothing pending and nothing stored. */
  | "idle"
  /** A save is in flight. */
  | "saving"
  /** The server holds the current content. */
  | "saved"
  /** Stored on this machine only — no operator row on the server. */
  | "local-only"
  /** The last save failed; the local copy may still be good. */
  | "error";

export interface ComposeDraftState {
  phase: ComposeDraftPhase;
  /** ISO of the last successful SERVER save, or of the draft just restored. */
  updatedAt: string | null;
  /** Vietnamese reason, present for `phase === "error"`. */
  errorMessage: string | null;
  /** What changed while restoring: cleared captions, dropped order, files. */
  notices: readonly string[];
  isRestoring: boolean;
  /** Saves again right now, after a failure. */
  retry: () => void;
  /** "Xoá nháp": drops both copies and resets the screen to an empty step 1. */
  discard: () => void;
  /** True when the buffer on this machine refuses to store (quota, private mode). */
  localBufferFailed: boolean;
}

export function useComposeDraft(wizard: ComposeWizard, publish: PublishForm): ComposeDraftState {
  const [phase, setPhase] = useState<ComposeDraftPhase>("restoring");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notices, setNotices] = useState<readonly string[]>([]);
  const [localBufferFailed, setLocalBufferFailed] = useState(false);
  /**
   * Flipped once the mount-time restore is over, whatever the outcome. It is
   * STATE, not just the ref below, because the autosave effect has to wake up
   * when it changes — a ref would leave autosave asleep until the next keystroke.
   */
  const [hydrationSettled, setHydrationSettled] = useState(false);

  /**
   * Latest wizard/publish instances. Both are rebuilt on every render, so a
   * callback that closed over the first one would keep calling into a screen
   * state that no longer exists — the classic stale-closure autosave bug.
   */
  const wizardRef = useRef(wizard);
  const publishRef = useRef(publish);
  useEffect(() => {
    wizardRef.current = wizard;
    publishRef.current = publish;
  });

  /** Content last handed to the server — the dirty check compares against it. */
  const lastSavedRef = useRef<ComposeDraftPayload | null>(null);
  /** Freshest payload; the debounced callbacks read THIS, never a captured copy. */
  const latestPayloadRef = useRef<ComposeDraftPayload | null>(null);
  const localTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True while a discard/publish is settling: autosave must not undo it. */
  const suspendedRef = useRef(false);
  /** True once something was stored, so EMPTYING the screen is saved too. */
  const everSavedRef = useRef(false);
  /**
   * The mount-time restore runs once — but "once" must mean "once it has
   * ACTUALLY applied", not "once it has started".
   *
   * React remounts every effect one extra time in development (Strict Mode).
   * With a single "already started" flag the first run claims the slot, its
   * cleanup cancels it mid-fetch, and the second run refuses because the ref
   * survived the remount — so the draft is read and then dropped on the floor,
   * which is exactly the F5-loses-everything bug this feature exists to prevent.
   * Two flags: the started one is HANDED BACK by the cleanup unless the run got
   * far enough to apply.
   */
  const hydrationStartedRef = useRef(false);
  const hydrationDoneRef = useRef(false);
  /**
   * Owner of the drafts on this screen, as named by the server. Held in a ref
   * because every storage call needs it and none of them re-render on it.
   * `null` = the server has not answered yet, and until it does the local buffer
   * must NOT be read: on a shared machine the entry sitting there may belong to
   * whoever used it last (business rule 7).
   */
  const ownerKeyRef = useRef<string | null>(null);
  /** Bumped by "Xoá nháp": answers from an older generation are ignored. */
  const generationRef = useRef(0);
  const saveAbortRef = useRef<AbortController | null>(null);
  /** The save currently on the wire, so a discard can wait for it to settle. */
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);

  const { form } = wizard;
  /**
   * Step 1 is uncontrolled (`register`), so typing a product code re-renders
   * nothing — and a draft that only notices the code when something ELSE
   * changes would miss exactly the case this feature exists for. Watching the
   * five step-1 fields costs one render per keystroke on a five-field step,
   * which is the cheapest honest way to autosave them.
   */
  const watched = useWatch({
    control: form.control,
    name: ["tenantId", "productCode", "color", "mediaKind", "videoTarget", "source"],
  });
  const values = form.getValues();
  const [watchedTenantId, productCode, color, mediaKind, videoTarget, source] = watched;

  const tenantId = (watchedTenantId ?? values.tenantId ?? "").trim();
  /**
   * The tenant field is editable, and half a UUID is not a tenant. Without this
   * every keystroke in that field would fire a request that can only 400, and
   * paint "Lưu nháp lỗi" over a form nobody has finished typing.
   */
  const canPersist = TENANT_ID_PATTERN.test(tenantId);

  const snapshot: ComposeDraftSnapshot = {
    step: wizard.step.slug,
    composeKey: wizard.composedKey ?? "",
    productCode: productCode ?? "",
    color: color ?? "",
    mediaKind: mediaKind ?? values.mediaKind,
    videoTarget: videoTarget ?? values.videoTarget,
    source: source ?? values.source,
    captions: wizard.captionValues ?? {},
    captionOverrides: publish.captionOverrides,
    albumOrder: wizard.albumOrder,
    selectedChannelIds: publish.selectedIds,
    shareCaption: publish.shareCaption,
    schedule: { mode: publish.schedule.mode, value: publish.schedule.value },
  };

  const payload = buildComposeDraftPayload(snapshot);
  const contentKey = draftContentKey(payload);

  // Kept in a ref so the debounced callbacks always send the NEWEST payload,
  // not the one captured when the timer was armed. Written in an effect, never
  // during render, and declared FIRST so it is up to date before the autosave
  // effect below runs in the same commit.
  useEffect(() => {
    latestPayloadRef.current = payload;
  }, [payload]);

  const clearTimers = useCallback(() => {
    if (localTimerRef.current) clearTimeout(localTimerRef.current);
    if (serverTimerRef.current) clearTimeout(serverTimerRef.current);
    localTimerRef.current = null;
    serverTimerRef.current = null;
  }, []);

  /** Writes the buffer now, and reports a storage that refuses to hold it. */
  const mirrorLocally = useCallback(
    (next: ComposeDraftPayload) => {
      if (tenantId.length === 0) return;
      const result = composeDraftBuffer.write(
        { tenantId, ownerKey: ownerKeyRef.current ?? ANONYMOUS_OWNER_KEY },
        next,
      );
      setLocalBufferFailed(!result.ok);
    },
    [tenantId],
  );

  /**
   * One server save. Never auto-retried: the next pause brings another one.
   *
   * Two guards on the WAY BACK, both about work the operator has since undone:
   *  - the request is abortable, and "Xoá nháp" aborts it, so a PUT cannot land
   *    after the DELETE and quietly resurrect the row;
   *  - the generation counter makes a late answer from an aborted-but-already-
   *    sent request harmless: it can no longer write `lastSavedRef` or paint
   *    "Đã lưu" over a screen that has just been reset.
   */
  const pushToServer = useCallback(
    async (next: ComposeDraftPayload) => {
      if (tenantId.length === 0) return;

      const generation = generationRef.current;
      const controller = new AbortController();
      saveAbortRef.current = controller;
      setPhase("saving");

      const attempt = (async () => {
        try {
          const result = await saveComposeDraft({ tenantId, payload: next }, controller.signal);
          if (!mountedRef.current || generationRef.current !== generation) return;
          lastSavedRef.current = next;
          everSavedRef.current = true;
          setErrorMessage(null);
          if (result.persisted) {
            setUpdatedAt(result.updatedAt);
            setPhase("saved");
          } else {
            // NOT a failure: this environment has no `app_user` row for the
            // session. The screen says "chỉ lưu trên máy này" rather than paint
            // a save that did not happen.
            setPhase("local-only");
          }
        } catch (error) {
          if (!mountedRef.current || generationRef.current !== generation) return;
          // An abort is our own doing (discard), not something to report.
          if (controller.signal.aborted) return;
          setPhase("error");
          setErrorMessage(
            ApiError.is(error)
              ? error.userMessage
              : "Không lưu được nháp lên máy chủ. Nháp vẫn được giữ trên máy này.",
          );
        } finally {
          if (saveAbortRef.current === controller) saveAbortRef.current = null;
        }
      })();

      inFlightSaveRef.current = attempt;
      await attempt;
      if (inFlightSaveRef.current === attempt) inFlightSaveRef.current = null;
    },
    [tenantId],
  );

  // --- Hydrate on mount ------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    /** The restore is over (applied or not): release the URL, wake autosave. */
    function settle(nextPhase: ComposeDraftPhase): void {
      hydrationDoneRef.current = true;
      wizardRef.current.markRestoreSettled();
      setHydrationSettled(true);
      setPhase(nextPhase);
    }

    async function hydrate(): Promise<void> {
      // --- Edge cases first --------------------------------------------------
      // A run is already applying (or has applied) — leave it alone, and do NOT
      // touch the phase: overwriting it here is what turned a restored screen
      // back into an idle one.
      if (hydrationDoneRef.current || hydrationStartedRef.current) return;

      // Editing the tenant field changes where the draft is SAVED; it must not
      // pull another operator's draft onto a screen already being worked on.
      if (!canPersist) {
        settle("idle");
        return;
      }
      // A `?code=` deep link is an explicit "soạn bài NÀY"; restoring another
      // product on top of it would be a surprise, not a rescue.
      if (wizardRef.current.deepLinked) {
        settle("idle");
        return;
      }
      hydrationStartedRef.current = true;

      let server: ComposeDraftPayload | null = null;
      let serverUpdatedAt: string | null = null;
      let serverPersisted = true;
      /** Null until the server names the owner — see `ownerKeyRef`. */
      let ownerKey: string | null = null;
      let serverUnreachable = false;
      let unreachableMessage: string | null = null;

      // The SERVER answers first, because its answer says whose drafts these
      // are. Reading the buffer before that would mean reading a bucket we
      // cannot yet attribute to anybody.
      try {
        const response = await fetchComposeDraft(tenantId);
        server = response.draft;
        serverUpdatedAt = response.updatedAt;
        serverPersisted = response.persisted;
        ownerKey = response.ownerKey ?? ANONYMOUS_OWNER_KEY;
        ownerKeyRef.current = ownerKey;
      } catch (error) {
        serverUnreachable = true;
        // The server copy is unreachable. Staying silent would hide why only
        // half the work came back — but say it AFTER the cancelled guard below,
        // or the run React throws away leaves its message on a healthy screen.
        unreachableMessage = ApiError.is(error)
          ? error.userMessage
          : "Không đọc được nháp trên máy chủ.";
      }

      // Cancelled = this run is the one React threw away on the extra mount.
      // The cleanup has already handed the slot back, so the next run redoes it.
      if (cancelled) return;
      if (unreachableMessage !== null) setErrorMessage(unreachableMessage);

      // A draft left behind by a publish whose cleanup failed: drop it before it
      // can be offered back as "nháp đang soạn" of a post that already went out.
      if (ownerKey !== null && composeDraftBuffer.takePendingDiscard({ tenantId, ownerKey })) {
        server = null;
        serverUpdatedAt = null;
        void discardComposeDraft(tenantId).catch((error: unknown) => {
          composeDraftBuffer.markPendingDiscard({ tenantId, ownerKey });
          console.warn("[useComposeDraft] retry of the post-publish cleanup failed", {
            scope: "ui/useComposeDraft",
            action: "retry-discard",
            tenantId,
            errorCode: ApiError.is(error) ? error.code : undefined,
          });
        });
      }

      const local =
        ownerKey === null ? null : composeDraftBuffer.read({ tenantId, ownerKey });

      const picked = pickNewerDraft(server, local);
      if (!picked) {
        if (serverUnreachable) {
          // Honest about the gap: there IS possibly a buffered draft on this
          // machine, but with no owner from the server it cannot be attributed,
          // and opening someone else's draft is worse than opening none.
          setNotices([
            "Không đọc được nháp trên máy chủ nên chưa xác định được người dùng — bản lưu trên máy này không được mở ra để tránh nhầm nháp của người khác. Hãy tải lại trang khi có mạng.",
          ]);
        }
        settle(serverPersisted ? "idle" : "local-only");
        return;
      }

      // The operator got here first: they opened the screen, typed something,
      // and only now is the draft arriving. Overwriting live keystrokes with a
      // stored copy is the one thing worse than not restoring at all.
      const onScreen = latestPayloadRef.current;
      if (onScreen && isDraftWorthSaving(onScreen)) {
        setNotices([
          "Có nháp đã lưu, nhưng màn hình đã có nội dung bạn vừa nhập nên nháp cũ không được mở đè. Bấm “Xoá nháp” nếu muốn bỏ hẳn bản cũ.",
        ]);
        settle(serverPersisted ? "saved" : "local-only");
        return;
      }

      // Past this point the draft IS being applied, so the slot stays taken.
      hydrationDoneRef.current = true;
      // Re-fills the input and RE-COMPOSES (Sheet + stock gate run again).
      const outcome = await wizardRef.current.restoreDraft(picked.payload);

      // No early return on `cancelled` here, deliberately. The slot was taken
      // for good on the line above, so no later run will finish what this one
      // started: bailing out mid-restore left the form filled, the channels and
      // the schedule empty, and the screen stuck on "Đang khôi phục" with
      // "Xoá nháp" disabled — a half-restore nobody was told about.
      publishRef.current.restore({
        selectedChannelIds: picked.payload.selectedChannelIds,
        shareCaption: picked.payload.shareCaption,
        captionOverrides: picked.payload.captionOverrides,
        schedule: picked.payload.schedule,
      });

      // ONLY a server copy is content the server already holds. Marking a local
      // pick as "already sent" made the autosave guard treat the newer local
      // draft as saved, so it was never pushed and the next machine got the old
      // one — while this screen said "Đã lưu".
      if (picked.source === "server") lastSavedRef.current = picked.payload;
      everSavedRef.current = true;
      setNotices([
        picked.source === "local"
          ? "Đã khôi phục nháp lưu trên máy này (mới hơn bản trên máy chủ)."
          : "Đã khôi phục nháp đang lưu trên máy chủ.",
        ...outcome.notices,
      ]);
      setUpdatedAt(picked.source === "server" ? serverUpdatedAt : picked.payload.savedAt);
      settle(serverPersisted ? "saved" : "local-only");
    }

    // `settle` in the failure path too: an unexpected throw must not leave the
    // screen restoring forever with no way out.
    void hydrate().catch((error: unknown) => {
      console.error("[useComposeDraft] restoring the draft failed", {
        scope: "ui/useComposeDraft",
        action: "hydrate",
        tenantId,
        errorCode: ApiError.is(error) ? error.code : undefined,
      });
      setErrorMessage(
        ApiError.is(error) ? error.userMessage : "Không mở lại được nháp đã lưu.",
      );
      if (!hydrationDoneRef.current) hydrationStartedRef.current = false;
      settle("error");
    });

    return () => {
      cancelled = true;
      // A run that never got as far as applying must hand the slot back, or the
      // extra mount React does in development leaves nobody to restore anything.
      if (!hydrationDoneRef.current) hydrationStartedRef.current = false;
    };
  }, [tenantId, canPersist]);

  // --- Autosave --------------------------------------------------------------
  /**
   * `contentKey` is the dependency, so the debounce restarts on a real edit and
   * not on every re-render. Everything else the guard needs lives in refs and is
   * read HERE rather than during render — a ref read at render time is exactly
   * the value React tells you not to trust.
   */
  useEffect(() => {
    // `phase` is deliberately NOT a dependency: `pushToServer` sets it to
    // "saving" as its first act, so depending on it re-ran this effect mid-save
    // and armed a second timer — one PUT of identical content per round trip
    // longer than the debounce. Hydration state is read from its ref instead.
    if (!hydrationDoneRef.current || suspendedRef.current || !canPersist) return;

    const next = latestPayloadRef.current;
    if (!next) return;

    const savedKey = lastSavedRef.current ? draftContentKey(lastSavedRef.current) : null;
    if (savedKey === contentKey) return;
    // An untouched screen must not create a row; once anything HAS been stored,
    // emptying it is a change worth saving too.
    if (!isDraftWorthSaving(next) && !everSavedRef.current) return;

    localTimerRef.current = setTimeout(() => {
      const latest = latestPayloadRef.current;
      if (latest) mirrorLocally(latest);
    }, LOCAL_DEBOUNCE_MS);

    serverTimerRef.current = setTimeout(() => {
      const latest = latestPayloadRef.current;
      if (latest) void pushToServer(latest);
    }, SERVER_DEBOUNCE_MS);

    return () => {
      if (localTimerRef.current) clearTimeout(localTimerRef.current);
      if (serverTimerRef.current) clearTimeout(serverTimerRef.current);
    };
    // `phase` intentionally absent (see above); `hydrationSettled` is what tells
    // this effect the restore is over, without re-running it on every save.
  }, [contentKey, hydrationSettled, canPersist, mirrorLocally, pushToServer]);

  // --- Flush while the tab is going away -------------------------------------
  useEffect(() => {
    function flush(): void {
      if (suspendedRef.current || !canPersist) return;
      const next = latestPayloadRef.current;
      if (!next || !isDraftWorthSaving(next)) return;
      const savedKey = lastSavedRef.current ? draftContentKey(lastSavedRef.current) : null;
      if (savedKey === draftContentKey(next)) return;

      clearTimers();
      // Local first: it is synchronous and nothing can cancel it.
      mirrorLocally(next);
      if (beaconComposeDraft({ tenantId, payload: next })) lastSavedRef.current = next;
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === "hidden") flush();
    }

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [canPersist, clearTimers, mirrorLocally, tenantId]);

  /**
   * The draft's job is done once the batch exists.
   *
   * The effect only touches the OUTSIDE world (timers, buffer, server); what the
   * screen shows is derived from `batchCreated` in the return value below. An
   * effect that also called setState here would be a cascading render for a
   * state React can compute on its own.
   */
  const batchCreated = publish.createBatch.isSuccess;
  useEffect(() => {
    if (!batchCreated || tenantId.length === 0) return;
    const ownerKey = ownerKeyRef.current ?? ANONYMOUS_OWNER_KEY;

    suspendedRef.current = true;
    generationRef.current += 1;
    saveAbortRef.current?.abort();
    clearTimers();
    composeDraftBuffer.clear({ tenantId, ownerKey });

    void discardComposeDraft(tenantId).catch((error: unknown) => {
      // The lô exists, so this is not the operator's failure to see — but it is
      // NOT nothing either: the row left behind would be offered back as "nháp
      // đang soạn" of a post that has already gone out. The marker makes the
      // next mount retry the delete instead of restoring it.
      composeDraftBuffer.markPendingDiscard({ tenantId, ownerKey });
      console.warn("[useComposeDraft] draft cleanup after publish failed", {
        scope: "ui/useComposeDraft",
        action: "discard-after-publish",
        tenantId,
        errorCode: ApiError.is(error) ? error.code : undefined,
      });
    });
  }, [batchCreated, clearTimers, tenantId]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (localTimerRef.current) clearTimeout(localTimerRef.current);
      if (serverTimerRef.current) clearTimeout(serverTimerRef.current);
    };
  }, []);

  const retry = useCallback(() => {
    const next = latestPayloadRef.current;
    if (!next) return;
    suspendedRef.current = false;
    mirrorLocally(next);
    void pushToServer(next);
  }, [mirrorLocally, pushToServer]);

  const discard = useCallback(() => {
    suspendedRef.current = true;
    clearTimers();
    // Everything already on the wire belongs to the draft being thrown away.
    // Without this, a PUT that left 200ms ago can land AFTER the DELETE and put
    // the row back — the operator asked for a delete, saw it happen, and the
    // draft returns on the next visit.
    generationRef.current += 1;
    saveAbortRef.current?.abort();
    saveAbortRef.current = null;

    lastSavedRef.current = null;
    everSavedRef.current = false;
    setNotices([]);
    setErrorMessage(null);
    setUpdatedAt(null);
    setPhase("idle");

    if (tenantId.length > 0) {
      const ownerKey = ownerKeyRef.current ?? ANONYMOUS_OWNER_KEY;
      composeDraftBuffer.clear({ tenantId, ownerKey });

      // Waits for the aborted save to settle before deleting, so the two
      // requests cannot cross on the wire in the other order.
      const pending = inFlightSaveRef.current ?? Promise.resolve();
      void pending
        .catch(() => undefined)
        .then(() => discardComposeDraft(tenantId))
        .catch((error: unknown) => {
          if (!mountedRef.current) return;
          // The operator asked for this one, so a failure is theirs to see —
          // and the marker makes the next mount try again.
          composeDraftBuffer.markPendingDiscard({ tenantId, ownerKey });
          setPhase("error");
          setErrorMessage(
            ApiError.is(error)
              ? error.userMessage
              : "Không xoá được nháp trên máy chủ. Hãy thử lại.",
          );
        });
    }

    // The screen goes back to an empty step 1: dropping the stored copy while
    // leaving the content on screen would simply save it again a second later.
    wizardRef.current.resetWizard();
    publishRef.current.reset();
    suspendedRef.current = false;
  }, [clearTimers, tenantId]);

  return useMemo(
    () => ({
      // Once the batch is created the draft is gone by definition — derived, so
      // no effect has to write it.
      phase: batchCreated ? "idle" : phase,
      updatedAt: batchCreated ? null : updatedAt,
      errorMessage: batchCreated ? null : errorMessage,
      notices: batchCreated ? [] : notices,
      isRestoring: !batchCreated && (phase === "restoring" || wizard.restorePhase === "restoring"),
      retry,
      discard,
      localBufferFailed,
    }),
    [
      batchCreated,
      discard,
      errorMessage,
      localBufferFailed,
      notices,
      phase,
      retry,
      updatedAt,
      wizard.restorePhase,
    ],
  );
}
