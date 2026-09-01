import { AppError } from "@/core/domain/errors";
import type { AppearanceSettingRepo } from "@/core/ports/appearance-setting-repo";
import type { Logger } from "@/core/ports/infra";
import {
  APPEARANCE_PRESET_IDS,
  DEFAULT_APPEARANCE_PRESET_ID,
  isAppearancePresetId,
  type AppearancePresetId,
} from "@/shared/appearance-presets";

/**
 * M3.4 — the colour of the product, set by MYSP staff for every company at once.
 *
 * Two rules shape everything here:
 *
 * 1. READING NEVER FAILS. This value is read on the way to rendering ANY page,
 *    including the sign-in screen. A stored id that no longer exists (a preset
 *    retired by a later deploy) is a cosmetic problem, and turning it into a
 *    500 would take the whole product down over the colour of a button. So the
 *    reader falls back to the approved default — but it says so, loudly, with
 *    the offending value in the log line. That is degrading, not swallowing
 *    (CLAUDE.md §5: every catch logs with context or moves a state).
 *
 * 2. WRITING IS STRICT. An unknown id from a request is a caller error and
 *    comes back as INVALID_INPUT. Nothing is coerced: an operator who mistypes
 *    must see a refusal, not silently keep the colour they already had.
 */

export interface AppearanceSettings {
  readonly presetId: AppearancePresetId;
  /** False = nothing stored yet, so this is the approved default, not a choice. */
  readonly isDefault: boolean;
}

export interface SetAppearanceInput {
  readonly presetId: string;
  readonly actorAccountId: string;
  readonly actorEmail: string | null;
}

export interface SetAppearanceResult {
  readonly presetId: AppearancePresetId;
  /** True = it was already this colour; nothing was written, nothing audited. */
  readonly already: boolean;
}

export interface PlatformAppearance {
  get(): Promise<AppearanceSettings>;
  set(input: SetAppearanceInput): Promise<SetAppearanceResult>;
}

export interface PlatformAppearanceDeps {
  settings: AppearanceSettingRepo;
  logger: Logger;
}

export function makePlatformAppearance(deps: PlatformAppearanceDeps): PlatformAppearance {
  async function get(): Promise<AppearanceSettings> {
    const stored = await deps.settings.read();

    if (stored === null || stored === undefined) {
      return { presetId: DEFAULT_APPEARANCE_PRESET_ID, isDefault: true };
    }

    if (!isAppearancePresetId(stored)) {
      // Not a crash and not a shrug: the row is real, we cannot honour it, and
      // whoever reads the logs gets the exact value that is wrong.
      deps.logger.warn("Stored appearance preset is not a known preset — using the default", {
        error_code: "INVALID_INPUT",
        stored_value: typeof stored === "string" ? stored : JSON.stringify(stored),
        fallback_preset: DEFAULT_APPEARANCE_PRESET_ID,
      });
      return { presetId: DEFAULT_APPEARANCE_PRESET_ID, isDefault: true };
    }

    return { presetId: stored, isDefault: false };
  }

  async function set(input: SetAppearanceInput): Promise<SetAppearanceResult> {
    // --- Refusals first -----------------------------------------------------
    if (!isAppearancePresetId(input.presetId)) {
      throw new AppError("INVALID_INPUT", {
        message: "Unknown appearance preset",
        userMessage: "Bộ màu không hợp lệ. Hãy chọn lại một bộ màu trong danh sách.",
        context: {
          preset_id: typeof input.presetId === "string" ? input.presetId : String(input.presetId),
          known_presets: APPEARANCE_PRESET_IDS.join(","),
        },
      });
    }

    if (typeof input.actorAccountId !== "string" || input.actorAccountId.length === 0) {
      throw new AppError("UNAUTHORIZED", {
        message: "Appearance change requires an account",
        userMessage: "Phiên đăng nhập không hợp lệ. Hãy đăng nhập lại.",
      });
    }

    const current = await get();

    // Idempotent: re-picking the colour that is already on writes no row and
    // files no audit entry — a book full of "changed to the same thing" is a
    // book nobody reads.
    if (!current.isDefault && current.presetId === input.presetId) {
      return { presetId: input.presetId, already: true };
    }

    await deps.settings.write({
      presetId: input.presetId,
      actorAccountId: input.actorAccountId,
      actorEmail: input.actorEmail,
      previousPresetId: current.isDefault ? null : current.presetId,
    });

    deps.logger.info("Platform appearance changed", {
      preset_id: input.presetId,
      previous_preset_id: current.isDefault ? null : current.presetId,
      actor_account_id: input.actorAccountId,
    });

    return { presetId: input.presetId, already: false };
  }

  return { get, set };
}
