import { z } from "zod";

import { tenantIdField } from "./tenant-health.schema";

/**
 * Contracts of the "Soạn bài" wizard (E3 compose + E4 captions).
 *
 * Mirrors `core/domain/product.ts` (ProductContent, MediaAsset),
 * `core/domain/inventory.ts` (InventoryDecision) and the results of
 * `compose-post` / `generate-captions`. `ui/` may not import `core/`
 * (docs/07 §2), so the mirror is intentional and parsed at runtime.
 *
 * CLAUDE.md business rule 2 (whitelist): `ProductContentSchema` holds ONLY the
 * four caption-safe columns. Stock/price/notes have no field here to land in —
 * `InventoryDecisionSchema` is a SEPARATE type, rendered only in the internal
 * operator area and never inside a caption or a post preview.
 */

// --- Channels (Phase 1: Facebook only) --------------------------------------

export const COMPOSE_CHANNELS = [
  { id: "facebook", label: "Facebook", platform: "facebook", contentType: "photo_post" },
] as const;

export type ComposeChannelId = (typeof COMPOSE_CHANNELS)[number]["id"];

// --- Step 1: the wizard form (ONE schema for the whole flow, core-wizard) ---

const PRODUCT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const ComposeWizardSchema = z.object({
  tenantId: tenantIdField(),
  productCode: z
    .string()
    .trim()
    .min(1, "Nhập mã sản phẩm, ví dụ: MGKVX6310.")
    .max(64, "Mã sản phẩm quá dài (tối đa 64 ký tự).")
    .regex(PRODUCT_CODE_PATTERN, "Mã sản phẩm chỉ gồm chữ, số và các ký tự . _ -"),
  /** Optional colour filter, any spelling — the server normalises TRẮNG/TRANG. */
  color: z.string().trim().max(64, "Tên màu quá dài (tối đa 64 ký tự).").optional(),
  /** Caption per channel, edited by hand or filled in by the AI step. */
  captions: z.record(z.string(), z.string()),
});

export type ComposeWizardValues = z.infer<typeof ComposeWizardSchema>;

/** Fields step 1 owns — `trigger()` must not validate steps not reached yet. */
export const STEP_PRODUCT_FIELDS = ["tenantId", "productCode", "color"] as const;

// --- Step 1 response --------------------------------------------------------

/** The ONLY product fields allowed near a caption (brief §2.2). */
export const ProductContentSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  category: z.string().nullable(),
  season: z.string().nullable(),
});
export type ProductContent = z.infer<typeof ProductContentSchema>;

export const MediaAssetSchema = z.object({
  driveFileId: z.string().min(1),
  fileName: z.string().min(1),
  color: z.string().nullable(),
  sequence: z.number().nullable(),
  kind: z.enum(["image", "video"]),
  warnings: z.array(z.string()),
  needsReview: z.boolean(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

/** INTERNAL ONLY — never rendered inside a caption or a post preview. */
export const InventoryDecisionSchema = z.object({
  status: z.enum(["in_stock", "low_stock", "blocked"]),
  blocked: z.boolean(),
  reason: z.string().nullable(),
  stock: z.number().nullable(),
  operatorMessage: z.string().nullable(),
});
export type InventoryDecision = z.infer<typeof InventoryDecisionSchema>;

export const ComposeResponseSchema = z.object({
  tenantId: z.string().min(1),
  productCode: z.string().min(1),
  channel: z.string().min(1),
  content: ProductContentSchema,
  inventory: InventoryDecisionSchema.nullable(),
  media: z.array(MediaAssetSchema).min(1),
  availableColors: z.array(z.string()),
  /** Operator notes: several colours, files needing review, low stock… */
  warnings: z.array(z.string()),
});
export type ComposeResponse = z.infer<typeof ComposeResponseSchema>;

export const INVENTORY_STATUS_LABELS: Record<InventoryDecision["status"], string> = {
  in_stock: "Còn hàng",
  low_stock: "Sắp hết",
  blocked: "Bị chặn",
};

// --- Step 2 response --------------------------------------------------------

export const GeneratedCaptionSchema = z.object({
  channelId: z.string().min(1),
  platform: z.string().min(1),
  /** Publish-ready text assembled by the system ("Tên – TIÊU ĐỀ" + body + tag). */
  text: z.string().min(1),
  hashtags: z.array(z.string()),
  model: z.string().min(1),
  provider: z.string().min(1),
});
export type GeneratedCaption = z.infer<typeof GeneratedCaptionSchema>;

export const FailedCaptionSchema = z.object({
  channelId: z.string().min(1),
  platform: z.string().min(1),
  code: z.string().min(1),
  /** Vietnamese reason — always populated by the usecase. */
  reason: z.string().min(1),
});
export type FailedCaption = z.infer<typeof FailedCaptionSchema>;

export const CaptionsResponseSchema = z.object({
  generated: z.array(GeneratedCaptionSchema),
  failed: z.array(FailedCaptionSchema),
});
export type CaptionsResponse = z.infer<typeof CaptionsResponseSchema>;
