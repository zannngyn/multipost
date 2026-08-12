import { AppError, type ErrorCode } from "@/core/domain/errors";
import { evaluateProductInventory, type InventoryDecision } from "@/core/domain/inventory";
import { isSameColor, normalizeColorName, type MediaKind } from "@/core/domain/media-file-name";
import { toPromptInput, type MediaAsset, type ProductContent } from "@/core/domain/product";
import { isTenantId } from "@/core/domain/tenant";
import type { Logger } from "@/core/ports/infra";
import type { MediaRepo, ProductRepo } from "@/core/ports/product-repo";

/**
 * E3 — the data half of composing a post: look the product up, run the stock
 * gate, then gather media. No AI here (that is E4): this usecase produces the
 * `ProductContent` whitelist + the album, and nothing else.
 *
 * The order is the invariant of the whole system (CLAUDE.md business rule 1):
 * sheet -> stock -> media. The stock gate runs before any media work so a
 * sold-out code costs nothing.
 *
 * Blocking is returned as a value, not thrown: a batch of 50 codes must keep
 * going when one is sold out (brief section 3). Only a malformed CALL throws.
 * That is a deliberate refinement of the sketch in docs/07 section 3.2.
 */

/** Brief section 4.2: 5..10 photos when the operator picks no numbers. */
export const MIN_AUTO_MEDIA = 5;
export const MAX_AUTO_MEDIA = 10;

export interface ComposePostInput {
  readonly tenantId: string;
  readonly productCode: string;
  /** Target channel id — carried through for logging/fan-out (E5). */
  readonly channel: string;
  /** Colour filter; any spelling. Empty/absent = every colour of the code. */
  readonly colors?: readonly string[];
  /** Sequence numbers typed by the operator ("25, 3, 7"). */
  readonly sequences?: readonly number[];
  /** Album kind. Video posts land in Phase 2 but the filter is already honest. */
  readonly mediaKind?: MediaKind;
}

export interface ComposeBlock {
  readonly code: ErrorCode;
  /** Machine reason, e.g. STOCK_ZERO / SEQUENCES_NOT_FOUND. */
  readonly reason: string;
  /** Vietnamese, shown to the operator. */
  readonly userMessage: string;
}

export interface ComposeResult {
  readonly tenantId: string;
  readonly productCode: string;
  readonly channel: string;
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
}

export interface ComposePostDeps {
  products: ProductRepo;
  media: MediaRepo;
  logger: Logger;
}

export function makeComposePost(deps: ComposePostDeps) {
  return async function composePost(input: ComposePostInput): Promise<ComposeResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const tenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    const productCode =
      typeof input?.productCode === "string" ? input.productCode.trim().toUpperCase() : "";
    const channel = typeof input?.channel === "string" ? input.channel.trim() : "";

    if (!isTenantId(tenantId) || productCode.length === 0 || channel.length === 0) {
      deps.logger.warn("Compose rejected: malformed input", {
        error_code: "INVALID_INPUT",
        tenant_id: tenantId || null,
        product_code: productCode || null,
        channel: channel || null,
      });
      throw new AppError("INVALID_INPUT", {
        message: "composePost requires a tenant UUID, a product code and a channel",
        context: { tenant_id: tenantId || null, product_code: productCode || null, channel },
      });
    }

    const sequences = normaliseSequences(input?.sequences);
    if (sequences === null) {
      throw new AppError("INVALID_INPUT", {
        message: "sequences must be positive integers",
        userMessage: "Danh sách số đuôi ảnh phải là các số nguyên dương.",
        context: { tenant_id: tenantId, product_code: productCode, sequences: input?.sequences },
      });
    }

    const log = deps.logger.child({ tenant_id: tenantId, product_code: productCode, channel });
    const base = { tenantId, productCode, channel, media: [] as MediaAsset[] };

    const product = await deps.products.findByCode(tenantId, productCode);
    if (!product) {
      log.warn("Compose blocked: product not found in sheet snapshot", {
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
          userMessage: `Không tìm thấy mã ${productCode} trên Sheet — chưa đăng được`,
        },
      };
    }

    // --- Stock gate BEFORE anything else (business rule 1) ------------------
    const inventory = evaluateProductInventory(product);
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
    const all = await deps.media.listByProductCode(tenantId, productCode);
    const ofKind = all.filter((asset) => asset.kind === kind);
    const availableColors = collectColors(ofKind);

    if (ofKind.length === 0) {
      log.warn("Compose blocked: no media of the requested kind", {
        error_code: "MEDIA_NOT_FOUND",
        media_kind: kind,
        media_total: all.length,
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
          userMessage: `Mã ${productCode} chưa có ${kind === "video" ? "video" : "ảnh"} hợp lệ trên Drive`,
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

    // --- Happy path ---------------------------------------------------------
    const needingReview = selection.selected.filter((asset) => asset.needsReview).length;
    if (needingReview > 0) {
      warnings.push(`${needingReview} file trong bài có tên không đúng chuẩn — nên kiểm tra lại`);
    }
    if (sequences.length === 0 && selection.selected.length < MIN_AUTO_MEDIA) {
      warnings.push(
        `Mã ${productCode} chỉ có ${selection.selected.length} ảnh (ít hơn mức tối thiểu ${MIN_AUTO_MEDIA})`,
      );
    }

    log.info("Compose ready", {
      media_count: selection.selected.length,
      cover_file: selection.selected[0]?.fileName,
      stock: inventory.stock,
      inventory_status: inventory.status,
      media_needing_review: needingReview,
    });

    return {
      ...base,
      content: toPromptInput(product),
      inventory,
      media: selection.selected,
      availableColors,
      warnings,
      blocked: null,
    };
  };
}

export type ComposePost = ReturnType<typeof makeComposePost>;

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
