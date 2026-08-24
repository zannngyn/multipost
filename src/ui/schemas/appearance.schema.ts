import { z } from "zod";

import {
  APPEARANCE_PRESET_IDS,
  APPEARANCE_PRESETS,
  DEFAULT_APPEARANCE_PRESET_ID,
  type AppearancePresetId,
} from "@/shared/appearance-presets";

/**
 * Contract of the appearance screen (M3.4).
 *
 * The preset table itself is NOT redefined here — it comes from `@/shared`,
 * the one module the server, the stylesheet generator and this screen can all
 * reach. A second list in the UI layer is a list that drifts, and a swatch
 * labelled "Rêu" that saves `reu-2` is a bug nobody sees until an operator
 * clicks it.
 *
 * SECURITY NOTE: everything here is UX. The server re-checks the role and the
 * preset id on every call and answers 403/400 — the client-side ladder only
 * keeps somebody from walking into a refusal.
 */

export const AppearancePresetIdSchema = z.enum(
  APPEARANCE_PRESET_IDS as unknown as [AppearancePresetId, ...AppearancePresetId[]],
);

export const AppearanceSettingsSchema = z.object({
  presetId: AppearancePresetIdSchema,
  /** False = nothing was ever chosen, so this is the approved default. */
  isDefault: z.boolean(),
});
export type AppearanceSettings = z.infer<typeof AppearanceSettingsSchema>;

export const UpdateAppearanceResponseSchema = z.object({
  presetId: AppearancePresetIdSchema,
  /** True = it was already this colour; the server wrote nothing. */
  already: z.boolean(),
});
export type UpdateAppearanceResponse = z.infer<typeof UpdateAppearanceResponseSchema>;

/** Re-exported so the screen imports its data from one place. */
export { APPEARANCE_PRESETS, DEFAULT_APPEARANCE_PRESET_ID };
export type { AppearancePresetId };

/**
 * Only a super_admin may repaint the product; `support` reads the screen and
 * sees which colour is on. Mirrors the ladder the route enforces.
 */
export function canChangeAppearance(platformRole: string | null): boolean {
  return platformRole === "super_admin";
}

/** Why the save button is off, in words an operator can act on. */
export function appearanceBlockReason(platformRole: string | null): string | null {
  if (platformRole === null) return "Tài khoản của bạn không có quyền quản trị nền tảng.";
  if (platformRole !== "super_admin") {
    return "Chỉ quản trị viên cấp cao của MYSP mới đổi được màu giao diện.";
  }
  return null;
}
