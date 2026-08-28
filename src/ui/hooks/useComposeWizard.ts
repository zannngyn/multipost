"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { DEFAULT_CAPTION_TONE, type CaptionTone } from "@/shared/caption-tone";
import {
  COMPOSE_CHANNELS,
  ComposeWizardSchema,
  STEP_PRODUCT_FIELDS,
  type ComposeResponse,
  type ComposeWizardValues,
  type DetectCodeResponse,
  type UploadedAsset,
  type UploadRejection,
  type UploadResponse,
} from "@/ui/schemas/compose.schema";
import {
  manualProductCaptionKey,
  manualProductEntry,
  manualProductForCode,
  toManualProductPayload,
  type ManualProductEntry,
  type ManualProductFormValues,
} from "@/ui/schemas/manual-product.schema";
import type { CaptionTarget } from "@/ui/components/compose/caption-targets";
import { applyAlbumOrder, shouldClearCaptions } from "@/ui/components/compose/compose-draft";
import type { QueuedFile } from "@/ui/components/compose/upload-queue";
import { useDirectUpload } from "@/ui/hooks/useDirectUpload";
import type { ComposeDraftPayload } from "@/ui/schemas/post-draft.schema";
import { ApiError } from "@/ui/services/api-error";
import { composePost, generateCaptions, type GenerateCaptionsResult } from "@/ui/services/post.api";
import { detectUploadCode } from "@/ui/services/upload.api";

/**
 * Logic layer of the compose screen (docs/07 §4.1).
 *
 * ONE SCREEN, no steps. The approved ComposeFocus design puts the whole post on
 * a single card: the code resolves, and the colours, the album, the caption and
 * the channels appear underneath it in that order. The BUSINESS order is
 * untouched (CLAUDE.md rule 1 — sheet → tồn kho → media → AI → duyệt → đăng);
 * what went away is the three-screen presentation, and with it `?step=`,
 * `goToStep` and the "which step may I be on" arithmetic.
 *
 * Decisions worth knowing before reading the code:
 *  - ONE form object and ONE schema; `submitProduct()` validates the lookup
 *    fields only, and the publish action re-checks everything before it fires.
 *  - Nothing about the post lives in the URL except `?code=` (a deep link from
 *    the product list). A reload therefore loses the composed post, and E10's
 *    draft is what brings it back: `restoreDraft()` re-fills the INPUT and
 *    re-runs compose for real (Sheet lookup + stock gate), so a restored screen
 *    is never a replay of yesterday's answer. Where that fails, the typed input
 *    stays on screen with the server's own reason next to it.
 */

/** "idle" = nothing to restore (yet); "done" covers success AND refusal. */
export type ComposeRestorePhase = "idle" | "restoring" | "done";

/**
 * What the lookup action did: composed, refused by field validation, or refused
 * by the server. The failure carries the server's error so the caller can put
 * the reason exactly where it belongs — `null` when the throw was not an
 * `ApiError` (a bug, not a business refusal).
 */
export type ProductStepOutcome =
  | { ok: true; composed: ComposeResponse }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "failed"; error: ApiError | null };

export interface ComposeRestoreOutcome {
  /** True only when the post was re-composed for real (Sheet + stock gate). */
  readonly composed: boolean;
  /** What changed on the way back: cleared captions, dropped order, files. */
  readonly notices: readonly string[];
}

/**
 * Identity of what was composed — changing it invalidates the captions.
 * The media kind is part of it: a caption written for an album is not the same
 * post as a caption for a Reel, and letting it survive silently would be the
 * "im lặng xoá / im lặng giữ" mistake core-wizard forbids.
 */
function composeKey(
  values: Pick<ComposeWizardValues, "productCode" | "color" | "mediaKind" | "videoTarget">,
  /**
   * Onboarding phase 3. A typed product keeps its code while its TEXT changes,
   * so the four fields above cannot tell "same post" from "same code, product
   * rewritten" — and a caption written for the old text would survive silently.
   */
  manual: ManualProductFormValues | null = null,
): string {
  const target = values.mediaKind === "video" ? values.videoTarget : "-";
  const base = [
    values.productCode.trim().toUpperCase(),
    (values.color ?? "").trim().toLowerCase(),
    values.mediaKind,
    target,
  ].join("|");

  // APPENDED, never always-on: a synced post's key must stay byte-identical to
  // what earlier builds produced, or every stored draft would come back looking
  // like a different post and lose its captions on the first restore.
  const manualKey = manualProductCaptionKey(manual);
  return manualKey.length > 0 ? `${base}|manual:${manualKey}` : base;
}

function emptyCaptions(): Record<string, string> {
  return Object.fromEntries(COMPOSE_CHANNELS.map((channel) => [channel.id, ""]));
}

/**
 * Order-insensitive fingerprint of a queue's file names (E9 T7 review round 1,
 * Important 2). A drag-reorder must not look like a new batch to detect, but
 * adding or removing a file — even keeping the same count — must: compares
 * the SET of names, not the array reference and not position.
 */
function queueNameFingerprint(queue: readonly QueuedFile[]): string {
  return queue
    .map((item) => item.file.name)
    .slice()
    .sort()
    .join("\0");
}

export function useComposeWizard() {
  const searchParams = useSearchParams();

  const form = useForm<ComposeWizardValues>({
    resolver: zodResolver(ComposeWizardSchema),
    mode: "onSubmit",
    defaultValues: {
      productCode: "",
      color: "",
      // Ảnh is the default: Phase 1 is an album tool, video is opt-in.
      mediaKind: "image",
      videoTarget: "facebook_video",
      // Drive is the default mode; mode B is the exception (brief §8).
      source: "drive",
      captions: emptyCaptions(),
    },
  });

  const [composed, setComposed] = useState<ComposeResponse | null>(null);
  /**
   * The album in PUBLISH order, which the operator may rearrange (brief §8 —
   * both file modes end with an ordered album whose first entry is the cover).
   *
   * Held here rather than written back into `composed`: the compose response is
   * the server's answer and must stay comparable to what was returned, while
   * the arrangement belongs to this post only. Nothing is written to
   * `media_asset` — that table belongs to the Drive sync.
   */
  const [album, setAlbum] = useState<readonly ComposeResponse["media"][number][]>([]);
  const composedKeyRef = useRef<string | null>(null);
  /** Render-visible copy of `composedKeyRef` — the draft is stamped with it. */
  const [composedKey, setComposedKey] = useState<string | null>(null);
  /**
   * Where the draft restore has got to. `markRestoreSettled()` is how the draft
   * hook says "nothing is coming"; the screen reads it to tell "chưa tra mã
   * nào" apart from "đang mở lại nháp", which look identical otherwise.
   */
  const [restorePhase, setRestorePhase] = useState<ComposeRestorePhase>("idle");
  /** Set when re-composing another code cleared captions typed for the old one. */
  const [captionsCleared, setCaptionsCleared] = useState(false);

  /**
   * ONBOARDING PHASE 3 — the product the operator typed, and the code they typed
   * it for (`ManualProductEntry` explains why the two travel together).
   *
   * Held here rather than in the react-hook-form object on purpose:
   *  - the compose DRAFT is a strict whitelist on both sides, and typed product
   *    text is not on it. Putting these six fields in the wizard form would put
   *    them one careless spread away from a payload the server answers 400 for;
   *  - a ref beside the state because `submitProductStep` runs in the SAME tick
   *    as "Dùng thông tin này": React has not re-rendered yet, so a mutation
   *    reading state would send the previous value (or none at all).
   *
   * What it is NOT: a way past the stock gate. The values go to the server
   * untouched and `composePost` judges `stockRaw` with the same decision table
   * it applies to a synced row.
   */
  const manualProductRef = useRef<ManualProductEntry | null>(null);
  const [manualProduct, setManualProductState] = useState<ManualProductEntry | null>(null);

  /** Writes both, so the next request and the next render agree. */
  const applyManualProduct = useCallback((productCode: string, values: ManualProductFormValues) => {
    const entry = manualProductEntry(productCode, values);
    manualProductRef.current = entry;
    setManualProductState(entry);
  }, []);

  /** "Bỏ nhập tay" — back to looking the code up in the synced catalog. */
  const clearManualProduct = useCallback(() => {
    manualProductRef.current = null;
    setManualProductState(null);
  }, []);

  // --- E9 mode B ------------------------------------------------------------
  // The queue holds files chosen but not yet sent. It is NOT form state: a File
  // is not serialisable, and react-hook-form would try to clone it.
  const [uploadQueue, setUploadQueue] = useState<QueuedFile[]>([]);
  const [uploadedCount, setUploadedCount] = useState(0);
  /**
   * E9 T8 — the stored files themselves, not just their count. The queue is
   * cleared on `onSuccess` (a second click must not re-upload the same
   * album), so this is the only thing left on screen the operator can look
   * at; drawn through `MediaThumb` against the preview route, never from the
   * object URLs that just got revoked with the queue.
   *
   * `UploadedAsset`, not `MediaAsset`: a just-uploaded file has no colour, no
   * sync warnings and no review flag — those belong to a catalogue entry the
   * Drive sync produced, and this is neither. `UploadedAsset.assetId` is the
   * `upload_<hex>` id `MediaThumb`'s preview route already accepts.
   */
  const [uploadedAssets, setUploadedAssets] = useState<UploadedAsset[]>([]);
  const [uploadRejections, setUploadRejections] = useState<UploadRejection[]>([]);
  /** Non-blocking notes from `confirmUpload` (e.g. a corrected album order). */
  const [uploadWarnings, setUploadWarnings] = useState<string[]>([]);

  const direct = useDirectUpload();

  /**
   * E9 T7 — which product code the file names in the queue carry. Fires the
   * moment the queue goes from empty to non-empty, BEFORE anything uploads
   * (spec §4.1: the operator is not required to type a code first).
   */
  const [detection, setDetection] = useState<DetectCodeResponse | null>(null);

  const detect = useMutation<DetectCodeResponse, ApiError, readonly QueuedFile[]>({
    mutationFn: (files) =>
      detectUploadCode({ files: files.map((item) => ({ fileName: item.file.name })) }),
    retry: false,
    onSuccess: (result) => setDetection(result),
    // Detection failing must NOT block the compose screen — the operator can
    // still type the code by hand. It still has to be visible (rule 5), and
    // that is what `detect.error` is for; a stale verdict must not linger.
    onError: () => setDetection(null),
  });

  const compose = useMutation<ComposeResponse, ApiError, void>({
    mutationFn: () => {
      const values = form.getValues();
      // Bound to the code being looked up: typed data must not follow the
      // operator onto the next product (see `manualProductForCode`).
      const manual = manualProductForCode(manualProductRef.current, values.productCode);
      return composePost({
        productCode: values.productCode,
        color: values.color,
        mediaKind: values.mediaKind,
        videoTarget: values.videoTarget,
        source: values.source,
        manualProduct: manual ? toManualProductPayload(manual) : null,
      });
    },
    retry: false,
    onSuccess: (result) => {
      const nextKey = composeKey(
        form.getValues(),
        manualProductForCode(manualProductRef.current, form.getValues().productCode),
      );
      const hadCaptions = Object.values(form.getValues().captions ?? {}).some(
        (text) => text.trim().length > 0,
      );
      // A caption written for another code must never survive into this post.
      // The rule itself lives in `shouldClearCaptions` so a manual re-lookup and
      // a draft restore cannot drift apart — and so it is testable on its own.
      if (shouldClearCaptions(composedKeyRef.current, nextKey, hadCaptions)) {
        form.setValue("captions", emptyCaptions(), { shouldDirty: false });
        setCaptionsCleared(true);
      } else {
        setCaptionsCleared(false);
      }
      composedKeyRef.current = nextKey;
      setComposedKey(nextKey);
      setComposed(result);
      // A new album means a new arrangement. Keeping the old ids would either
      // drop photos the operator can now see or resurrect ones that are gone.
      // A restored draft re-applies its own order AFTER this, by asset id.
      setAlbum(result.media);
    },
    onError: () => {
      // Blocked/failed compose invalidates the current post: the caption block,
      // the album and the publish bar must not stay on screen showing the
      // previous product's data.
      setComposed(null);
      setAlbum([]);
      composedKeyRef.current = null;
      setComposedKey(null);
    },
  });

  /**
   * Validates ONLY the lookup fields — the caption is not filled in yet and
   * must not be reported as missing — then composes. On failure the focus moves
   * to the first invalid field so a keyboard user is not left guessing.
   */
  const submitProductStep = useCallback(async (): Promise<ProductStepOutcome> => {
    const valid = await form.trigger([...STEP_PRODUCT_FIELDS]);
    if (!valid) {
      const firstInvalid = STEP_PRODUCT_FIELDS.find((field) => form.getFieldState(field).invalid);
      if (firstInvalid) form.setFocus(firstInvalid);
      return { ok: false, reason: "invalid" };
    }
    try {
      // `mutateAsync`, so the caller can await the answer. The mutation's own
      // `onError` still runs; the throw is caught here rather than left to
      // become an unhandled rejection.
      return { ok: true, composed: await compose.mutateAsync() };
    } catch (error) {
      // The error is HANDED BACK, not just swallowed into a boolean: the caller
      // pins the server's own sentence on the colour chip that caused it, and
      // reading it from `compose.error` instead would be a stale closure — the
      // callback was created before this failure existed.
      return {
        ok: false,
        reason: "failed",
        error: ApiError.is(error) ? error : null,
      };
    }
  }, [compose, form]);

  const upload = useMutation<UploadResponse, ApiError, void>({
    mutationFn: () => {
      const values = form.getValues();
      // The queue order IS the album order (index 0 is the cover); tickets
      // come back tagged with `sourceIndex` into this same array, so sending
      // it straight through keeps that order without needing a separate
      // `order` field on confirm.
      return direct.upload(values.productCode, uploadQueue.map((item) => item.file));
    },
    retry: false,
    onSuccess: (result) => {
      setUploadedCount(result.accepted.length);
      setUploadedAssets(result.accepted);
      setUploadRejections(result.rejected);
      setUploadWarnings([...result.warnings]);
      // Accepted files are stored server-side now; keeping them queued would
      // let a second click upload the same album twice.
      setUploadQueue([]);
      // The detected code was about THIS queue; an empty queue has none, and a
      // leftover error state must not resurface against the next batch.
      setDetection(null);
      detect.reset();
      // C1 — the media the operator just arranged is now on the server, so
      // compose can succeed for real. Composing any earlier (e.g. straight off
      // "Dùng mã này") would hit MEDIA_NOT_FOUND against a post with nothing
      // uploaded yet; this is the one place after that where it is safe.
      if (result.accepted.length > 0) void submitProductStep();
    },
    onError: () => {
      setUploadRejections([]);
      setUploadWarnings([]);
    },
  });

  /**
   * Wraps the raw queue setter so the decision to re-ask detection is made at
   * the one place queue changes actually originate (drop, remove, reorder),
   * rather than reacted to a tick later from a `useEffect` watching
   * `uploadQueue`: this project's lint forbids a synchronous `setState` call
   * in an effect body (`react-hooks/set-state-in-effect`) and ref reads/writes
   * during render (`react-hooks/refs`), both of which an effect-based version
   * of this would need.
   *
   * E9 T7 review round 1, Important 2: re-fires on ANY change to the set of
   * file NAMES, not only the empty→non-empty edge — dropping file B on top of
   * an already-detected file A (or removing down to one of a conflicting
   * pair) must not leave the old verdict on screen describing a queue that no
   * longer exists (rule 5). Compared by name fingerprint, not array identity
   * or length, so a pure drag-reorder — same names, same count — does not
   * re-fire a request nobody asked for.
   */
  const handleUploadQueueChange = useCallback(
    (next: QueuedFile[]) => {
      const previousFingerprint = queueNameFingerprint(uploadQueue);
      setUploadQueue(next);
      if (next.length === 0) {
        setDetection(null);
        // Otherwise a later file dropped back in re-triggers `onError`'s old
        // verdict-clearing path against a stale error/data pair from before
        // the queue emptied.
        detect.reset();
        return;
      }
      if (queueNameFingerprint(next) !== previousFingerprint) detect.mutate(next);
    },
    [uploadQueue, detect],
  );

  /**
   * Tông giọng asked of the writer. State, not form state: it is not part of
   * the post — it only shapes the next request, and it never travels to the
   * publish payload or into a draft.
   */
  const [tone, setTone] = useState<CaptionTone>(DEFAULT_CAPTION_TONE);
  /** Set when the server refused `tone` and the call was retried without it. */
  const [toneDropped, setToneDropped] = useState(false);

  /**
   * "Nhờ AI viết" / "Viết lại", for ONE target at a time.
   *
   * The target is a variable, not a second mutation, so the screen can ask
   * `captions.variables` which tab is currently writing and which one failed —
   * a per-channel spinner needs exactly that and nothing more.
   *
   * The REQUEST is the same either way: `POST /api/posts/captions` takes the
   * platform channel catalogue (`facebook`), not a Fanpage id — the prompt is
   * built from the product alone, so there is nothing Fanpage-specific to send.
   * Asking again simply produces another variation, which is precisely what a
   * per-channel "Viết lại" is for. Where the text LANDS is the caller's call:
   * only a shared target is written here, and a channel target is handed back
   * so `usePublishForm` can put it on that channel's own caption.
   */
  const captions = useMutation<GenerateCaptionsResult, ApiError, CaptionTarget>({
    mutationFn: () => {
      if (!composed) {
        throw new ApiError({
          code: "INVALID_INPUT",
          status: 0,
          message: "generateCaptions called before compose",
          userMessage: "Chưa có dữ liệu bài đăng. Hãy tra mã sản phẩm trước.",
        });
      }
      return generateCaptions({
        content: composed.content,
        channels: COMPOSE_CHANNELS.map((channel) => channel.id),
        tone,
      });
    },
    retry: false,
    onSuccess: (result, target) => {
      setToneDropped(result.toneDropped);
      if (target.kind !== "shared") return;
      for (const item of result.generated) {
        form.setValue(`captions.${item.channelId}`, item.text, { shouldDirty: true });
      }
    },
    onError: () => setToneDropped(false),
  });

  /**
   * E9 T7 — "Dùng mã này" / "Nhập mã BG0SQ9999" / one code from a conflict.
   * Fills the field with the code the button carries and, unless it is blank
   * ("Nhập mã sản phẩm" only opens the field for typing), looks it up right
   * away — spec §8.2 forbids making the operator retype it.
   *
   * Review round 1, Important 3: a BLANK code (the `no_code` verdict's manual
   * button) must NOT overwrite the field — the operator may already have
   * typed something there. It only moves focus to it, same as an invalid
   * lookup does in `submitProductStep`.
   */
  const applyDetectedCode = useCallback(
    (code: string) => {
      const trimmed = code.trim();
      if (trimmed.length === 0) {
        form.setFocus("productCode");
        return;
      }
      form.setValue("productCode", code, { shouldDirty: true });
      // C1 — mode B, no file on the server yet: `compose-post` gates on media
      // BEFORE anything read the code, so composing right now would always
      // answer MEDIA_NOT_FOUND. Fill the field and stop; `upload.onSuccess`
      // runs the real compose once the queued files actually land.
      if (form.getValues("source") === "upload" && uploadedAssets.length === 0) {
        form.setFocus("productCode");
        return;
      }
      void submitProductStep();
    },
    [form, submitProductStep, uploadedAssets],
  );

  /**
   * E10 — puts a stored draft back on screen.
   *
   * The order below is the whole point, and it is the order a human would use:
   *  1. re-fill the INPUT fields (nothing else is stored, by design);
   *  2. re-run compose FOR REAL — the Sheet is read again and the stock gate
   *     runs again (business rule 3). A draft never resurrects an answer;
   *  3. say what changed on the way.
   *
   * There is no longer a step to choose: one screen means the restored state IS
   * the screen, and how far it fills in follows from what compose answered.
   *
   * Compose refusing (hết hàng, không có ảnh, mã đã đổi) is a normal outcome,
   * not a restore failure: the typed input stays on screen, the operator reads
   * the server's own sentence under the field, and nothing pretends to be
   * composed.
   */
  const restoreDraft = useCallback(
    async (draft: ComposeDraftPayload): Promise<ComposeRestoreOutcome> => {
      setRestorePhase("restoring");
      const notices: string[] = [];

      // A draft describes a LOOKUP: the compose draft whitelist has no room for
      // typed product text (post-draft.schema), and inventing it here would put
      // a product on screen that nothing on disk vouches for. So a restore always
      // starts from "tra mã trong dữ liệu đã đồng bộ" — and when that code was a
      // typed product, compose answers PRODUCT_NOT_FOUND and the screen offers to
      // type it again, with the server's own sentence above the form.
      clearManualProduct();

      const finish = (composedOk: boolean): ComposeRestoreOutcome => {
        setRestorePhase("done");
        return { composed: composedOk, notices };
      };

      form.setValue("productCode", draft.productCode, { shouldDirty: false });
      form.setValue("color", draft.color, { shouldDirty: false });
      form.setValue("mediaKind", draft.mediaKind, { shouldDirty: false });
      form.setValue("videoTarget", draft.videoTarget, { shouldDirty: false });
      form.setValue("source", draft.source, { shouldDirty: false });
      form.setValue(
        "captions",
        { ...emptyCaptions(), ...draft.captions },
        { shouldDirty: false },
      );

      // A File cannot be serialised, so mode B's queue is the one thing a draft
      // provably cannot carry. Said plainly, because silently landing on an
      // upload post with no files is a trap.
      if (draft.source === "upload") {
        notices.push(
          "Chế độ tự tải lên: file bạn đã chọn KHÔNG được lưu trong nháp. Hãy chọn và tải lên lại trước khi soạn tiếp.",
        );
      }

      // Nothing to look up yet — the draft was saved on a half-typed code.
      if (draft.productCode.trim().length === 0) return finish(false);

      const draftHadCaptions = Object.values(draft.captions).some(
        (text) => text.trim().length > 0,
      );
      // Hand the draft's identity to the EXISTING key check: if this compose
      // answers with a different key, captions typed for the old product are
      // cleared by exactly the same code path a manual re-compose uses.
      composedKeyRef.current = draft.composeKey.length > 0 ? draft.composeKey : null;

      // Through `submitProductStep`, NOT straight to the mutation: a restore
      // must pass the same field validation and land focus in the same place a
      // typed lookup does. A draft written by an older build can carry a code
      // this build refuses, and that has to be visible, not swallowed.
      const outcome = await submitProductStep();
      if (!outcome.ok) {
        // Compose refused (hết hàng, thiếu ảnh…): nothing below the field is
        // drawn, and `compose.error` under it carries the real sentence.
        notices.push(
          outcome.reason === "invalid"
            ? "Nháp cũ có mã sản phẩm không còn hợp lệ. Hãy sửa lại rồi tra lại."
            : "Không mở lại được bài đang soạn — lý do ở ngay bên dưới. Nội dung bạn đã gõ vẫn còn, hãy sửa rồi tra lại.",
        );
        return finish(false);
      }

      if (
        shouldClearCaptions(
          draft.composeKey,
          composeKey(
            form.getValues(),
            manualProductForCode(manualProductRef.current, form.getValues().productCode),
          ),
          draftHadCaptions,
        )
      ) {
        notices.push(
          "Mã hoặc màu đã khác so với lúc lưu nháp nên caption cũ đã bị xoá — caption luôn gắn với đúng sản phẩm của nó.",
        );
      }

      const arranged = applyAlbumOrder(outcome.composed.media, draft.albumOrder);
      if (arranged.album) setAlbum(arranged.album);
      if (arranged.notice) notices.push(arranged.notice);

      return finish(true);
    },
    [clearManualProduct, form, submitProductStep],
  );

  /** Called by the draft hook when no restore is coming (or none was possible). */
  const markRestoreSettled = useCallback(() => {
    setRestorePhase((current) => (current === "restoring" ? "done" : current));
  }, []);

  /**
   * "Xoá nháp" — back to an empty screen, in one action.
   *
   * Clearing the stored copy alone would be a lie: autosave would put the very
   * same content back a second later. Discarding a draft means starting over,
   * so the screen itself resets.
   */
  const resetWizard = useCallback(() => {
    form.reset({
      productCode: "",
      color: "",
      mediaKind: "image",
      videoTarget: "facebook_video",
      source: "drive",
      captions: emptyCaptions(),
    });
    setComposed(null);
    setAlbum([]);
    composedKeyRef.current = null;
    setComposedKey(null);
    setCaptionsCleared(false);
    setRestorePhase("done");
    setTone(DEFAULT_CAPTION_TONE);
    setToneDropped(false);
    setUploadQueue([]);
    setUploadedCount(0);
    setUploadedAssets([]);
    setUploadRejections([]);
    setUploadWarnings([]);
    // "Xoá nháp" clears the queue directly, bypassing `handleUploadQueueChange`
    // — the detected code has to go with it.
    setDetection(null);
    // A stray in-flight direct upload must not keep POSTing to MinIO or hand
    // back a result once the screen it belonged to no longer exists.
    direct.cancel();
    // "Xoá nháp" means an empty screen. Typed product text left behind would
    // reattach itself the moment the same code is typed again.
    clearManualProduct();
    compose.reset();
    captions.reset();
    upload.reset();
    detect.reset();
  }, [captions, clearManualProduct, compose, detect, direct, form, upload]);

  /**
   * Deep link from the product list: `/compose?code=MGKVX6310&color=TRẮNG`
   * prefills the field and looks the code up straight away, so "Soạn bài" on a
   * row lands on the composed post instead of a form to re-submit.
   *
   * Guards (an auto-submitting effect is a loop waiting to happen):
   *  - it runs ONCE per code — the ref is written BEFORE the request, so a
   *    blocked/failed compose does not retry itself forever;
   *  - it never fires on top of an existing composed post, so a re-render
   *    cannot silently recompose;
   *  - it is a shortcut, not a bypass: the same validation and the same stock
   *    gate run as if the operator had typed the code and pressed the button.
   */
  const codeParam = searchParams.get("code");
  const colorParam = searchParams.get("color");
  const prefilledCodeRef = useRef<string | null>(null);

  useEffect(() => {
    const code = (codeParam ?? "").trim();
    if (code.length === 0 || prefilledCodeRef.current === code) return;

    prefilledCodeRef.current = code;
    form.setValue("productCode", code.toUpperCase(), { shouldDirty: false });
    form.setValue("color", (colorParam ?? "").trim(), { shouldDirty: false });

    // Nothing composed yet = the operator just arrived. Otherwise leave the
    // screen alone: they are already working on something.
    if (composedKeyRef.current === null) void submitProductStep();
    // `submitProductStep` is intentionally out of the dependency list: it is
    // recreated on every mutation state change, and the ref above is what makes
    // this effect run once per code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeParam, colorParam, form]);

  // `useWatch`, not `form.watch()`: the latter returns a fresh function on every
  // render, which the React Compiler cannot memoise safely.
  const captionValues = useWatch({ control: form.control, name: "captions" });

  return {
    form,
    captionValues,
    composed,
    /** The album in publish order — use this, never `composed.media`. */
    album,
    setAlbum,
    /** Publish order as ids — what a draft stores, and all it stores. */
    albumOrder: album.map((asset) => asset.driveFileId),
    compose,
    captions,
    submitProductStep,
    /** Identity of the post currently composed; null before the first lookup. */
    composedKey,
    restoreDraft,
    markRestoreSettled,
    restorePhase,
    resetWizard,
    /**
     * A `?code=` deep link is an explicit "soạn bài này", so it outranks a
     * stored draft — the draft hook skips restoring when this is true.
     */
    deepLinked: (searchParams.get("code") ?? "").trim().length > 0,
    captionsCleared,
    /**
     * Onboarding phase 3. `manualProduct` is what is on the typed form right now
     * (with the code it belongs to); `composed.productOrigin` is what the SERVER
     * says the post on screen was built from, and that is the one to render a
     * badge from — a product typed last week and reused today comes back as
     * `manual` with nothing in this state at all.
     */
    manualProduct,
    applyManualProduct,
    clearManualProduct,
    /** Tông giọng asked of the writer, and whether the server refused it. */
    tone,
    setTone,
    toneDropped,
    upload,
    uploadQueue,
    /** Routes every queue change through detection (E9 T7) as well as state. */
    setUploadQueue: handleUploadQueueChange,
    uploadedCount,
    /** E9 T8 — the stored files, drawn through `MediaThumb` once the queue is gone. */
    uploadedAssets,
    uploadRejections,
    /** E9 T7 — the code(s) read from the queued file names, and the request behind it. */
    detection,
    detect,
    applyDetectedCode,
    /** Non-blocking notes from the confirm step (e.g. a corrected album order). */
    uploadWarnings,
    /** 0..100, real progress of the direct-to-storage POSTs (stage 2 only). */
    uploadProgress: direct.progress,
    /** Cuts the in-flight upload's network calls, not just the UI state. */
    cancelUpload: direct.cancel,
    /** True once every channel has a non-empty caption (the publish gate). */
    hasEveryCaption: COMPOSE_CHANNELS.every(
      (channel) => (captionValues?.[channel.id] ?? "").trim().length > 0,
    ),
  };
}

export type ComposeWizard = ReturnType<typeof useComposeWizard>;
