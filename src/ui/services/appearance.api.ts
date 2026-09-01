import {
  AppearanceSettingsSchema,
  UpdateAppearanceResponseSchema,
  type AppearancePresetId,
  type AppearanceSettings,
  type UpdateAppearanceResponse,
} from "@/ui/schemas/appearance.schema";

import { apiRequest } from "./http-client";

/**
 * Data layer of the appearance screen (M3.4), docs/07 §4.1.
 *   GET /api/platform/appearance   which colour the product is wearing
 *   PUT /api/platform/appearance   repaint it, for every company at once
 *
 * NOT tenant-scoped: one value governs the whole platform, and the person
 * setting it may hold no membership anywhere.
 */

export const appearanceKeys = {
  /** No tenant segment — this belongs to the PLATFORM, not to a company. */
  settings: () => ["platform", "appearance"] as const,
};

export async function readAppearance(signal?: AbortSignal): Promise<AppearanceSettings> {
  return apiRequest("/api/platform/appearance", {
    schema: AppearanceSettingsSchema,
    signal,
    malformedMessage:
      "Cấu hình màu trả về không đúng định dạng. Hãy báo quản trị hệ thống kiểm tra máy chủ.",
  });
}

/**
 * Never auto-retried. The call is idempotent server-side, so a retry would be
 * safe — but a silent retry hides a save the operator should be told failed,
 * and this screen has exactly one thing to report.
 */
export async function updateAppearance(
  presetId: AppearancePresetId,
): Promise<UpdateAppearanceResponse> {
  return apiRequest("/api/platform/appearance", {
    method: "PUT",
    body: { presetId },
    schema: UpdateAppearanceResponseSchema,
    malformedMessage: "Máy chủ trả về kết quả không đọc được. Hãy tải lại trang và kiểm tra.",
  });
}
