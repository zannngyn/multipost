import { DEFAULT_STOCK_POLICY, type StockPolicy } from "@/core/domain/catalog-field-map";
import { AppError, type ErrorCode } from "@/core/domain/errors";
import { evaluateProductInventory, type InventoryDecision } from "@/core/domain/inventory";
import { isSameColor, normalizeColorName, type MediaKind } from "@/core/domain/media-file-name";
import { buildManualProduct, type ManualProductInput } from "@/core/domain/manual-product";
import {
  productOrigin,
  toPromptInput,
  type MediaAsset,
  type MediaOrigin,
  type Product,
  type ProductContent,
  type ProductOrigin,
} from "@/core/domain/product";
import { isTenantId } from "@/core/domain/tenant";
import {
  evaluateVideoSpec,
  isVideoTarget,
  summarizeViolations,
  type VideoSpec,
  type VideoTarget,
} from "@/core/domain/video-spec";
import type { CatalogConfigRepo } from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";
import type { VideoAssetProbe } from "@/core/ports/media-probe";
import type {
  ManualProductSaveResult,
  MediaRepo,
  ProductRepo,
} from "@/core/ports/product-repo";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * E3 — the data half of composing a post: look the product up, run the stock
 * gate, gather media, then (for a video post) check the file's specs. No AI here
 * (that is E4): this usecase produces the `ProductContent` whitelist + the
 * album, and nothing else.
 *
 * The order is the invariant of the whole system (CLAUDE.md business rule 1):
 * sheet -> stock -> media -> video specs -> AI. The stock gate runs before any
 * media work so a sold-out code costs nothing, and the video gate runs before
 * anything is uploaded (brief section 5, docs/02 section 5.1 step 4).
 *
 * Blocking is returned as a value, not thrown: a batch of 50 codes must keep
 * going when one is sold out (brief section 3). Only a malformed CALL throws.
 * That is a deliberate refinement of the sketch in docs/07 section 3.2.
 */

/** Brief section 4.2: 5..10 photos when the operator picks no numbers. */
export const MIN_AUTO_MEDIA = 5;
export const MAX_AUTO_MEDIA = 10;

/** Default destination of a video post until the operator picks Reels. */
export const DEFAULT_VIDEO_TARGET: VideoTarget = "facebook_video";

/**
 * Shown when no probe is wired (a web process without ffprobe). The post is NOT
 * blocked: the worker owns the binary and re-checks before uploading a byte.
 */
export const VIDEO_NOT_CHECKED_WARNING =
  "Chưa kiểm được thông số video ở bước soạn bài — hệ thống sẽ kiểm lại trước khi đăng";

export interface ComposePostInput {
  readonly tenantId: TenantId;
  readonly productCode: string;
  /** Target channel id — carried through for logging/fan-out (E5). */
  readonly channel: string;
  /** Colour filter; any spelling. Empty/absent = every colour of the code. */
  readonly colors?: readonly string[];
  /** Sequence numbers typed by the operator ("25, 3, 7"). */
  readonly sequences?: readonly number[];
  /** Album kind. Video posts land in Phase 2 but the filter is already honest. */
  readonly mediaKind?: MediaKind;
  /**
   * Which of the two file modes this post uses (brief section 8). Defaults to
   * Drive, so mode A keeps behaving exactly as before.
   *
   * The filter is not optional politeness: both modes store their assets in the
   * same table under the same product code, so without it a mode A post would
   * quietly absorb files the operator uploaded for a different post.
   */
  readonly source?: MediaOrigin;
  /**
   * Destination the video must satisfy (`facebook_video` / `facebook_reels`).
   * Ignored for photo posts; defaults to DEFAULT_VIDEO_TARGET.
   */
  readonly videoTarget?: VideoTarget;
  /**
   * ONBOARDING PHASE 3 — the operator types the product instead of it coming
   * from a synced catalog. Absent = today's behaviour (look the code up).
   *
   * It changes WHERE the product data comes from and nothing else: the stock
   * gate, the media gather and the video gate below run in the same order, on
   * the same rules. In particular the typed `stockRaw` goes through the very
   * same decision table, so "nhập tay" is not a way past business rule 3.
   */
  readonly manualProduct?: ManualProductInput;
}

export interface ComposeBlock {
  readonly code: ErrorCode;
  /** Machine reason, e.g. STOCK_ZERO / SEQUENCES_NOT_FOUND. */
  readonly reason: string;
  /** Vietnamese, shown to the operator. */
  readonly userMessage: string;
}

export interface ComposeResult {
  readonly tenantId: TenantId;
  readonly productCode: string;
  readonly channel: string;
  /**
   * Where this post's product text came from — `sheet` (synced catalog) or
   * `manual` (typed here). On screen and in the logs, so nobody has to guess
   * later why a post carried the description it carried.
   */
  readonly productOrigin: ProductOrigin;
  /** Caption-safe fields. Null whenever the post is blocked. */
  readonly content: ProductContent | null;
  /** Null when the product does not exist at all. */
  readonly inventory: InventoryDecision | null;
  /** Ordered album; index 0 is the cover. Empty when blocked. */
  readonly media: readonly MediaAsset[];
  /** Colours actually available on Drive for this code (brief section 4.1). */
  readonly availableColors: readonly string[];
  /** Internal operator notes: low stock, files needing review, missing numbers. */
  readonly warnings: readonly string[];
  readonly blocked: ComposeBlock | null;
  /**
   * Video posts only. `spec` is null when nothing was probed (photo post, or no
   * probe available at compose time — see VIDEO_NOT_CHECKED_WARNING).
   */
  readonly video: { readonly target: VideoTarget; readonly spec: VideoSpec | null } | null;
}

export interface ComposePostDeps {
  products: ProductRepo;
  media: MediaRepo;
  logger: Logger;
  /**
   * Optional on purpose: a process without an ffprobe binary still composes,
   * with a warning, and the worker performs the binding check before upload.
   */
  videoProbe?: VideoAssetProbe;
  /**
   * Per-tenant stock policy (onboarding phase 1). Optional so a caller that is
   * not wired yet keeps the `numeric` behaviour — the SAFE default, which still
   * checks stock. A tenant on `textual`/`disabled` needs this wired.
   */
  catalogConfig?: CatalogConfigRepo;
}

export function makeComposePost(deps: ComposePostDeps) {
  return async function composePost(input: ComposePostInput): Promise<ComposeResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    const productCode =
      typeof input?.productCode === "string" ? input.productCode.trim().toUpperCase() : "";
    const channel = typeof input?.channel === "string" ? input.channel.trim() : "";

    if (!isTenantId(rawTenantId) || productCode.length === 0 || channel.length === 0) {
      deps.logger.warn("Compose rejected: malformed input", {
        error_code: "INVALID_INPUT",
        tenant_id: rawTenantId || null,
        product_code: productCode || null,
        channel: channel || null,
      });
      throw new AppError("INVALID_INPUT", {
        message: "composePost requires a tenant UUID, a product code and a channel",
        context: { tenant_id: rawTenantId || null, product_code: productCode || null, channel },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);

    const sequences = normaliseSequences(input?.sequences);
    if (sequences === null) {
      throw new AppError("INVALID_INPUT", {
        message: "sequences must be positive integers",
        userMessage: "Danh sách số đuôi ảnh phải là các số nguyên dương.",
        context: { tenant_id: tenantId, product_code: productCode, sequences: input?.sequences },
      });
    }

    const videoTarget = input?.videoTarget ?? DEFAULT_VIDEO_TARGET;
    if (!isVideoTarget(videoTarget)) {
      throw new AppError("INVALID_INPUT", {
        message: `Unknown video target '${String(input?.videoTarget)}'`,
        userMessage: "Đích đăng video không hợp lệ.",
        context: {
          tenant_id: tenantId,
          product_code: productCode,
          video_target: String(input?.videoTarget),
        },
      });
    }

    const wantsManual = input?.manualProduct !== undefined && input?.manualProduct !== null;
    const requestedOrigin: ProductOrigin = wantsManual ? "manual" : "sheet";

    const log = deps.logger.child({
      tenant_id: tenantId,
      product_code: productCode,
      channel,
      product_origin: requestedOrigin,
    });
    const base = {
      tenantId,
      productCode,
      channel,
      productOrigin: requestedOrigin,
      media: [] as MediaAsset[],
      video: null,
    };

    // --- 1. Product data: synced catalog OR typed by the operator -----------
    // Business rule 1 is about ORDER, not about the source: whichever of the
    // two produced this product, the stock gate below runs before any media
    // work and nothing may jump over it.
    const stored = await deps.products.findByCode(tenantId, productCode);
    let product: Product;

    if (wantsManual) {
      // The real catalog always wins: silently letting typed data shadow a
      // synced row would also let it shadow that row's stock.
      if (stored && productOrigin(stored) === "sheet") {
        log.warn("Compose blocked: manual product collides with a synced one", {
          error_code: "INVALID_INPUT",
          reason: "MANUAL_PRODUCT_CONFLICT",
        });
        return {
          ...base,
          content: null,
          inventory: null,
          availableColors: [],
          warnings: [],
          blocked: {
            // PENDING(error-code): no MANUAL_PRODUCT_CONFLICT code exists yet
            // (adding one means editing the HTTP status table another agent
            // owns). `reason` carries the precise meaning.
            code: "INVALID_INPUT",
            reason: "MANUAL_PRODUCT_CONFLICT",
            userMessage: `Mã ${productCode} đã có sẵn trong dữ liệu đồng bộ — dùng dữ liệu đã đồng bộ, hoặc nhập tay với một mã khác`,
          },
        };
      }

      // Throws INVALID_INPUT on a bad shape/extra key — a typed product must
      // never become a hole in the caption whitelist.
      product = buildManualProduct(productCode, input?.manualProduct);

      // Fail fast, before the operator picks photos: without a writer, the
      // publish step could not re-check this product's stock (rule 3 runs
      // twice), and a post nothing can publish is worse than a refusal.
      if (typeof deps.products.saveManual !== "function") {
        log.error("Compose refused: manual products are not wired in this process", {
          error_code: "INTERNAL",
          reason: "MANUAL_PRODUCT_NOT_SUPPORTED",
        });
        throw new AppError("INTERNAL", {
          message: "ProductRepo has no saveManual: manual products cannot be persisted",
          userMessage:
            "Hệ thống chưa bật chế độ nhập tay sản phẩm ở tiến trình này — báo quản trị viên.",
          context: {
            tenant_id: tenantId,
            product_code: productCode,
            reason: "MANUAL_PRODUCT_NOT_SUPPORTED",
          },
        });
      }
    } else if (!stored) {
      log.warn("Compose blocked: product not found in the synced catalog", {
        error_code: "PRODUCT_NOT_FOUND",
      });
      return {
        ...base,
        content: null,
        inventory: null,
        availableColors: [],
        warnings: [],
        blocked: {
          code: "PRODUCT_NOT_FOUND",
          reason: "PRODUCT_NOT_FOUND",
          userMessage: `Không tìm thấy mã ${productCode} trong dữ liệu sản phẩm — đồng bộ lại bảng dữ liệu, hoặc nhập tay thông tin sản phẩm cho bài này`,
        },
      };
    } else {
      product = stored;
    }

    // A stored row can itself be a manual one (typed earlier, reused today), so
    // the answer comes from the product, not from what this call asked for.
    const resolvedOrigin = productOrigin(product);
    base.productOrigin = resolvedOrigin;

    // --- 2. Stock gate BEFORE anything else (business rule 1) ---------------
    const stockPolicy = await resolveStockPolicy(deps.catalogConfig, tenantId, log);
    const inventory = evaluateProductInventory(product, stockPolicy);
    if (inventory.blocked) {
      log.warn("Compose blocked by the stock gate", {
        error_code: "OUT_OF_STOCK",
        reason: inventory.reason,
        stock: inventory.stock,
      });
      return {
        ...base,
        content: null,
        inventory,
        availableColors: [],
        warnings: [],
        blocked: {
          code: "OUT_OF_STOCK",
          reason: inventory.reason ?? "BLOCKED",
          userMessage: inventory.operatorMessage ?? `Mã ${productCode} bị chặn đăng`,
        },
      };
    }

    const warnings: string[] = [];
    if (inventory.operatorMessage) warnings.push(inventory.operatorMessage);

    // --- Media --------------------------------------------------------------
    const kind: MediaKind = input?.mediaKind ?? "image";
    const source: MediaOrigin = input?.source ?? "drive";
    const all = await deps.media.listByProductCode(tenantId, productCode);
    const fromSource = all.filter((asset) => asset.origin === source);
    const ofKind = fromSource.filter((asset) => asset.kind === kind);
    const availableColors = collectColors(ofKind);

    if (ofKind.length === 0) {
      log.warn("Compose blocked: no media of the requested kind", {
        error_code: "MEDIA_NOT_FOUND",
        media_kind: kind,
        media_source: source,
        media_total: all.length,
        media_from_source: fromSource.length,
      });
      return {
        ...base,
        content: null,
        inventory,
        availableColors,
        warnings,
        blocked: {
          code: "MEDIA_NOT_FOUND",
          reason: kind === "video" ? "NO_VIDEO_FOR_CODE" : "NO_MEDIA_FOR_CODE",
          userMessage:
            source === "upload"
              ? `Bài này chưa có ${kind === "video" ? "video" : "ảnh"} nào được tải lên`
              : `Mã ${productCode} chưa có ${kind === "video" ? "video" : "ảnh"} hợp lệ trên Drive`,
        },
      };
    }

    const colorFiltered = filterByColors(ofKind, input?.colors);
    if (colorFiltered.length === 0) {
      const requested = (input?.colors ?? []).join(", ");
      log.warn("Compose blocked: no media for the requested colours", {
        error_code: "MEDIA_NOT_FOUND",
        requested_colors: requested,
        available_colors: availableColors,
      });
      return {
        ...base,
        content: null,
        inventory,
        availableColors,
        warnings,
        blocked: {
          code: "MEDIA_NOT_FOUND",
          reason: "NO_MEDIA_FOR_COLOR",
          userMessage: `Mã ${productCode} không có ảnh màu "${requested}". Màu đang có: ${availableColors.join(", ") || "(chưa nhận diện được màu)"}`,
        },
      };
    }

    // PENDING(C3)/PENDING(C4): the brief says one post per colour unless the
    // operator asks to merge, but never defines the merged order/cover. Until
    // then, an unspecified colour narrows to the colour with the most photos
    // instead of mixing colours into one album (a business error), and the other
    // colours are named in the warnings so nothing disappears silently.
    const colorScoped = input?.colors?.length ? colorFiltered : restrictToDominantColor(colorFiltered);
    if (colorScoped.length !== colorFiltered.length) {
      warnings.push(
        `Mã ${productCode} có nhiều màu (${availableColors.join(", ")}); bài này chỉ lấy ảnh màu ${describeColor(colorScoped)}`,
      );
    }

    const selection = selectMedia(colorScoped, sequences);
    if (selection.missing.length > 0) {
      // PENDING(C5): the brief says "report the missing number", not whether the
      // post is blocked. Temporary rule: block, so nobody publishes an album
      // that silently differs from what the operator typed.
      log.warn("Compose blocked: requested sequence numbers do not exist", {
        error_code: "MEDIA_NOT_FOUND",
        missing_sequences: selection.missing,
      });
      return {
        ...base,
        content: null,
        inventory,
        availableColors,
        warnings,
        blocked: {
          code: "MEDIA_NOT_FOUND",
          reason: "SEQUENCES_NOT_FOUND",
          userMessage: `Không tìm thấy ảnh số ${selection.missing.join(", ")} của mã ${productCode}`,
        },
      };
    }

    if (selection.selected.length === 0) {
      return {
        ...base,
        content: null,
        inventory,
        availableColors,
        warnings,
        blocked: {
          code: "MEDIA_NOT_FOUND",
          reason: "EMPTY_SELECTION",
          userMessage: `Không chọn được ảnh nào cho mã ${productCode}`,
        },
      };
    }

    // --- Video spec gate (docs/02 section 5.1 step 4) -----------------------
    // Runs AFTER the stock gate and the media gather, BEFORE the caller may call
    // AI or upload anything: "không đạt thì báo lỗi trước, không đăng rồi mới
    // lỗi" (brief section 5).
    let selected = selection.selected;
    let videoSpec: VideoSpec | null = null;

    if (kind === "video") {
      // PENDING(video-single-file): the brief never says what to do when one
      // code has several clips, and a Facebook video post carries exactly one.
      // Temporary rule: keep the first of the existing ordering (smallest
      // sequence number, then name) and name the file in the warnings so the
      // operator can see which clip went out.
      if (selected.length > 1) {
        warnings.push(
          `Mã ${productCode} có ${selected.length} video; bài này chỉ dùng "${selected[0].fileName}"`,
        );
        selected = [selected[0]];
      }

      const gate = await checkVideoSpec({
        probe: deps.videoProbe,
        tenantId,
        asset: selected[0],
        target: videoTarget,
        log,
      });
      warnings.push(...gate.warnings);
      if (!gate.ok) {
        return {
          ...base,
          content: null,
          inventory,
          availableColors,
          warnings,
          blocked: gate.block,
          video: { target: videoTarget, spec: gate.spec },
        };
      }
      videoSpec = gate.spec;
    }

    // --- Happy path ---------------------------------------------------------
    const needingReview = selected.filter((asset) => asset.needsReview).length;
    if (needingReview > 0) {
      warnings.push(`${needingReview} file trong bài có tên không đúng chuẩn — nên kiểm tra lại`);
    }
    // Mode A only: the 5..10 range describes what to pick automatically out of a
    // Drive folder. In mode B the operator chose the files by hand, so telling
    // them three is "below the minimum" is noise, not information.
    if (
      source === "drive" &&
      kind === "image" &&
      sequences.length === 0 &&
      selected.length < MIN_AUTO_MEDIA
    ) {
      warnings.push(
        `Mã ${productCode} chỉ có ${selected.length} ảnh (ít hơn mức tối thiểu ${MIN_AUTO_MEDIA})`,
      );
    }

    // --- Manual product: persist it so the publish step can re-check it -----
    // Last, and only once the post actually holds together: an operator who
    // abandons a blocked compose must not leave a product row behind. The
    // stock this row carries is the one the gate above judged, so the second
    // check before publishing (rule 3) reads exactly the same values.
    if (wantsManual) {
      const verdict = await persistManualProduct(deps, tenantId, product, log);
      if (verdict === "refused_synced") {
        return {
          ...base,
          content: null,
          inventory,
          availableColors,
          warnings,
          blocked: {
            code: "INVALID_INPUT",
            reason: "MANUAL_PRODUCT_CONFLICT",
            userMessage: `Mã ${productCode} vừa được đồng bộ từ bảng dữ liệu — dùng dữ liệu đã đồng bộ, hoặc nhập tay với một mã khác`,
          },
        };
      }
    }

    log.info("Compose ready", {
      product_origin: resolvedOrigin,
      media_kind: kind,
      media_count: selected.length,
      cover_file: selected[0]?.fileName,
      stock: inventory.stock,
      inventory_status: inventory.status,
      stock_policy_mode: inventory.policyMode,
      stock_check_skipped: inventory.stockCheckSkipped,
      media_needing_review: needingReview,
      video_target: kind === "video" ? videoTarget : null,
      video_checked: videoSpec !== null,
    });

    return {
      ...base,
      content: toPromptInput(product),
      inventory,
      media: selected,
      availableColors,
      warnings,
      blocked: null,
      video: kind === "video" ? { target: videoTarget, spec: videoSpec } : null,
    };
  };
}

export type ComposePost = ReturnType<typeof makeComposePost>;

/**
 * Writes the typed product, or says the synced catalog claimed the code first.
 *
 * A storage failure is NOT downgraded to a warning: the publish step re-reads
 * this row to check stock, so composing "successfully" without it would produce
 * a post that dies later with "không tìm thấy mã" — the confusing failure this
 * whole rung exists to avoid.
 */
async function persistManualProduct(
  deps: ComposePostDeps,
  tenantId: TenantId,
  product: Product,
  log: Logger,
): Promise<ManualProductSaveResult> {
  const save = deps.products.saveManual;
  if (typeof save !== "function") {
    // Guarded far above; kept so this helper cannot be misused into silence.
    throw new AppError("INTERNAL", {
      message: "ProductRepo has no saveManual: manual products cannot be persisted",
      userMessage: "Hệ thống chưa bật chế độ nhập tay sản phẩm ở tiến trình này — báo quản trị viên.",
      context: {
        tenant_id: tenantId,
        product_code: product.content.code,
        reason: "MANUAL_PRODUCT_NOT_SUPPORTED",
      },
    });
  }

  let verdict: ManualProductSaveResult;
  try {
    verdict = await save.call(deps.products, tenantId, product);
  } catch (error) {
    const appError = AppError.from(error, "DB_ERROR", {
      tenant_id: tenantId,
      product_code: product.content.code,
      reason: "MANUAL_PRODUCT_SAVE_FAILED",
    });
    log.error("Compose failed: the typed product could not be stored", {
      ...appError.toLogObject(),
      reason: "MANUAL_PRODUCT_SAVE_FAILED",
    });
    throw appError;
  }

  if (verdict === "refused_synced") {
    log.warn("Manual product refused: the code now belongs to the synced catalog", {
      error_code: "INVALID_INPUT",
      reason: "MANUAL_PRODUCT_CONFLICT",
    });
    return verdict;
  }

  log.info("Manual product stored", {
    reason: "MANUAL_PRODUCT_SAVED",
    stock_raw: product.operational.stockRaw,
    note_raw: product.operational.noteRaw,
  });
  return verdict;
}

// --- video gate -------------------------------------------------------------

interface VideoGateInput {
  probe: VideoAssetProbe | undefined;
  tenantId: TenantId;
  asset: MediaAsset;
  target: VideoTarget;
  log: Logger;
}

type VideoGateResult =
  | { ok: true; spec: VideoSpec | null; warnings: string[] }
  | { ok: false; block: ComposeBlock; spec: VideoSpec | null; warnings: string[] };

/**
 * Probes one clip and measures it against the target's limits.
 *
 * Two failures are deliberately NOT the same thing:
 *   - the file breaks a rule  -> block, with every violation spelled out;
 *   - the checker is missing  -> warn, because a web process without ffprobe
 *     must not stop an operator; the worker owns the binary and re-checks
 *     before the upload (same reasoning as the two stock checks).
 * Anything else about the FILE (corrupt, not a video, too large to download)
 * blocks: an unverifiable file must never reach Facebook unchecked.
 */
async function checkVideoSpec(input: VideoGateInput): Promise<VideoGateResult> {
  const { probe, tenantId, asset, target, log } = input;
  const warnings: string[] = [];

  if (!probe) {
    log.warn("Video spec check skipped: no probe wired in this process", {
      error_code: "INTERNAL",
      reason: "VIDEO_PROBE_UNAVAILABLE",
      drive_file_id: asset.driveFileId,
      video_target: target,
    });
    return { ok: true, spec: null, warnings: [VIDEO_NOT_CHECKED_WARNING] };
  }

  let spec: VideoSpec;
  try {
    spec = await probe.probeAsset({ tenantId, asset });
  } catch (error) {
    const appError = AppError.from(error, "INTERNAL", {
      drive_file_id: asset.driveFileId,
      file_name: asset.fileName,
      video_target: target,
    });
    const reason =
      typeof appError.context.reason === "string" ? appError.context.reason : "VIDEO_PROBE_FAILED";

    // Port contract of MediaProbe (core/ports/media-probe): this one reason
    // means "no ffprobe in THIS process", not "bad file".
    if (reason === "FFPROBE_NOT_AVAILABLE") {
      log.warn("Video spec check skipped: ffprobe binary not available", {
        error_code: appError.code,
        reason,
        drive_file_id: asset.driveFileId,
      });
      return { ok: true, spec: null, warnings: [VIDEO_NOT_CHECKED_WARNING] };
    }

    log.error("Compose blocked: video probe failed", {
      ...appError.toLogObject(),
      reason,
      drive_file_id: asset.driveFileId,
    });
    return {
      ok: false,
      spec: null,
      warnings,
      block: {
        // PENDING(error-code): VIDEO_PROBE_FAILED does not exist in errors.ts
        // yet; the probe's own code is kept and `reason` carries the detail.
        code: appError.code,
        reason,
        userMessage: `Không kiểm tra được thông số video "${asset.fileName}": ${appError.userMessage}`,
      },
    };
  }

  const verdict = evaluateVideoSpec(spec, target);
  warnings.push(...verdict.warnings);

  if (verdict.ok) {
    log.info("Video spec check passed", {
      drive_file_id: asset.driveFileId,
      video_target: target,
      container: spec.container,
      video_codec: spec.videoCodec,
      width: spec.width,
      height: spec.height,
      duration_sec: spec.durationSec,
      size_bytes: spec.sizeBytes,
      fps: spec.fps,
    });
    return { ok: true, spec, warnings };
  }

  const summary = summarizeViolations(verdict.violations);
  log.warn("Compose blocked by the video spec gate", {
    error_code: "INVALID_INPUT",
    reason: "VIDEO_SPEC_INVALID",
    drive_file_id: asset.driveFileId,
    file_name: asset.fileName,
    video_target: target,
    violated_rules: verdict.violations.map((violation) => violation.rule),
    violations: verdict.violations.map((violation) => ({
      rule: violation.rule,
      actual: violation.actual,
      limit: violation.limit,
    })),
    container: spec.container,
    video_codec: spec.videoCodec,
    width: spec.width,
    height: spec.height,
    duration_sec: spec.durationSec,
    size_bytes: spec.sizeBytes,
    fps: spec.fps,
  });

  return {
    ok: false,
    spec,
    warnings,
    block: {
      // PENDING(error-code): VIDEO_SPEC_INVALID does not exist in errors.ts yet.
      // INVALID_INPUT is the closest existing code — the file IS invalid input
      // for this channel — and `reason` carries the precise meaning.
      code: "INVALID_INPUT",
      reason: "VIDEO_SPEC_INVALID",
      userMessage: `Video "${asset.fileName}" chưa đạt thông số để đăng: ${summary}`,
    },
  };
}

// --- helpers ----------------------------------------------------------------

/** Returns null when the input is not a list of positive integers. */
function normaliseSequences(input: readonly number[] | undefined): number[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  const result: number[] = [];
  for (const value of input) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function collectColors(assets: readonly MediaAsset[]): string[] {
  const colors = new Set<string>();
  for (const asset of assets) {
    if (asset.color) colors.add(asset.color);
  }
  return [...colors].sort((a, b) => a.localeCompare(b, "vi"));
}

function filterByColors(
  assets: readonly MediaAsset[],
  requested: readonly string[] | undefined,
): MediaAsset[] {
  const wanted = (requested ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  if (wanted.length === 0) return [...assets];

  // PENDING(C3): "the remaining photos" stay inside the chosen colour(s) —
  // mixing colours into one album is a business error until told otherwise.
  return assets.filter((asset) =>
    wanted.some((color) => {
      const canonical = normalizeColorName(color);
      if (canonical && asset.color) return canonical === asset.color;
      return asset.colorRaw !== null && isSameColor(color, asset.colorRaw);
    }),
  );
}

/** Groups by colour (null = "colour unknown") and keeps the largest group. */
function restrictToDominantColor(assets: readonly MediaAsset[]): MediaAsset[] {
  const groups = new Map<string, MediaAsset[]>();
  for (const asset of assets) {
    const key = asset.color ?? "";
    const group = groups.get(key);
    if (group) group.push(asset);
    else groups.set(key, [asset]);
  }
  if (groups.size <= 1) return [...assets];

  // Ties broken by colour name so two syncs cannot produce two different albums.
  let best: { key: string; group: MediaAsset[] } | null = null;
  for (const [key, group] of groups) {
    if (
      !best ||
      group.length > best.group.length ||
      (group.length === best.group.length && key.localeCompare(best.key, "vi") < 0)
    ) {
      best = { key, group };
    }
  }
  return best ? best.group : [...assets];
}

function describeColor(assets: readonly MediaAsset[]): string {
  return assets[0]?.color ?? "(chưa nhận diện được màu)";
}

/**
 * Ordering used whenever the operator does not dictate one: numbered photos by
 * ascending number (they are NOT 1..n — docs/05 section 1.5 closes B4), then
 * unnumbered ones by name so the result is stable across syncs.
 */
function bySequenceThenName(a: MediaAsset, b: MediaAsset): number {
  const seqA = a.sequence ?? Number.POSITIVE_INFINITY;
  const seqB = b.sequence ?? Number.POSITIVE_INFINITY;
  if (seqA !== seqB) return seqA - seqB;
  return a.fileName.localeCompare(b.fileName);
}

interface Selection {
  selected: MediaAsset[];
  missing: number[];
}

function selectMedia(assets: readonly MediaAsset[], sequences: readonly number[]): Selection {
  const sorted = [...assets].sort(bySequenceThenName);

  // Mode "exact list" — brief section 4.2, row 1: exactly those photos, in the
  // typed order, no minimum applied.
  if (sequences.length > 1) {
    const selected: MediaAsset[] = [];
    const missing: number[] = [];
    for (const sequence of sequences) {
      const found = sorted.find((asset) => asset.sequence === sequence);
      if (found) selected.push(found);
      else missing.push(sequence);
    }
    return { selected, missing };
  }

  // Mode "single number" — that photo is the cover, the rest follow.
  if (sequences.length === 1) {
    const cover = sorted.find((asset) => asset.sequence === sequences[0]);
    if (!cover) return { selected: [], missing: [sequences[0]] };
    // PENDING(C1)/PENDING(C2): "the remaining photos" is read as ALL other
    // photos of the code in ascending order, starting from the smallest number
    // (not from cover+1). That also covers the case where the cover is the
    // largest number, which would otherwise select nothing.
    const rest = sorted.filter((asset) => asset !== cover);
    return { selected: [cover, ...rest].slice(0, MAX_AUTO_MEDIA), missing: [] };
  }

  // Mode "nothing typed" — 5..10 first photos ascending.
  return { selected: promoteFrontCover(sorted.slice(0, MAX_AUTO_MEDIA)), missing: [] };
}

/**
 * PENDING(docs/05 section 7 question 3): back-of-garment photos may stay in the
 * album, but a back shot as the cover is certainly wrong. Temporary rule: if the
 * first photo is a back view and a front one exists, promote the front one.
 */
function promoteFrontCover(selected: MediaAsset[]): MediaAsset[] {
  if (selected.length < 2 || !selected[0].variants.backView) return selected;
  const frontIndex = selected.findIndex((asset) => !asset.variants.backView);
  if (frontIndex <= 0) return selected;
  const front = selected[frontIndex];
  return [front, ...selected.filter((asset) => asset !== front)];
}

/**
 * Reads the tenant's stock policy for one compose.
 *
 * No repo wired -> `numeric`: the default every tenant had before onboarding,
 * and the safe one (stock IS checked). A FAILURE is rethrown, never downgraded:
 * the repo only throws when the STORED policy cannot be parsed, and turning
 * that into "compose anyway" is the silent fallback this feature must not have.
 */
async function resolveStockPolicy(
  catalogConfig: CatalogConfigRepo | undefined,
  tenantId: TenantId,
  log: Logger,
): Promise<StockPolicy> {
  if (!catalogConfig) return DEFAULT_STOCK_POLICY;

  try {
    return await catalogConfig.findStockPolicy(tenantId);
  } catch (error) {
    const appError = AppError.from(error, "SYNC_FAILED", { tenant_id: tenantId });
    log.error("Compose stopped: the tenant stock policy could not be read", {
      error_code: appError.code,
      err: appError,
      ...appError.toLogObject(),
    });
    throw appError;
  }
}
