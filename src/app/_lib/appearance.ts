import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { getContainer } from "@/composition/container";
import {
  DEFAULT_APPEARANCE_PRESET_ID,
  type AppearancePresetId,
} from "@/shared/appearance-presets";

/**
 * The preset the root layout stamps on `<html>` (M3.4).
 *
 * WHY IT IS READ IN THE ROOT LAYOUT AND NOT IN THE BROWSER: a preset applied
 * after hydration is a preset the operator watches CHANGE — the indigo paints,
 * then flips. `mysp-theme.ts` documents that trap for runtime themes and takes
 * the same way out: decide before the markup leaves the server. The attribute
 * ships in the HTML, and the stylesheet that answers it is already in the
 * `<head>`, so the first paint is the right colour.
 *
 * WHY IT NEVER THROWS: this sits in front of EVERY page, `/signin` included.
 * The container itself can fail to build (no DATABASE_URL on a bare dev box),
 * and the database can be down. Neither is a reason to refuse to render a page
 * — the operator would see a crash instead of a sign-in form because a button
 * colour could not be looked up. It degrades to the approved default and says
 * so in the log; the gate behind it logs the database case with its cause, and
 * this layer catches only what happens before the gate exists.
 *
 * The gate's cache is what makes this affordable: one query a minute per
 * process, not one per page view (`composition/appearance-gate.ts`).
 */
export async function readAppearancePreset(): Promise<AppearancePresetId> {
  try {
    const settings = await getContainer().usecases.platformAppearance.get();
    return settings.presetId;
  } catch (error) {
    // Reached when the CONTAINER could not be built — a read failure inside it
    // is already handled (and logged with its cause) by the gate.
    fallbackLogger.warn("Could not read the appearance preset — rendering the default", {
      err: error,
      fallback_preset: DEFAULT_APPEARANCE_PRESET_ID,
    });
    return DEFAULT_APPEARANCE_PRESET_ID;
  }
}
