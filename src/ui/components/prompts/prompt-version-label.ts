import {
  formatPromptDate,
  type PromptStatus,
  type PromptVersion,
} from "@/ui/schemas/prompt.schema";

/**
 * Naming a prompt version so two rows can never read the same (E10.7, wave 2).
 *
 * THE BUG THIS FIXES: the version number is NOT unique across the list. The
 * built-in template carries its own counter (`FACEBOOK_CONTENT_TEMPLATE_V2`)
 * while a tenant row keeps whatever number it was minted with, so a company
 * that saved its own v2 back when the built-in was still v1 now sees two rows
 * both labelled "v2" — one "Đang dùng", one "Đã thay thế" — with no way to tell
 * which text is which.
 *
 * Everything below is DERIVED FROM THE ROWS THEMSELVES. `PromptVersionSchema`
 * has no `replacedBy` and no `activatedAt`, so nothing here claims a direct
 * succession or an activation time: the copy says what is running now, which is
 * a fact the same list already carries.
 */

/** Astryx `Badge` variants — `PROMPT_STATUS_TONES` speaks the shadcn dialect. */
export const PROMPT_STATUS_BADGE_VARIANTS: Record<
  PromptStatus,
  "neutral" | "info" | "success" | "warning" | "error"
> = {
  draft: "info",
  active: "success",
  retired: "neutral",
};

export interface PromptVersionLabel {
  /** The real number, never renumbered: "v2". */
  number: string;
  /**
   * Where the row comes from. Always said for the built-in row (it explains why
   * it cannot be activated by hand); said for a tenant row only when another row
   * carries the same number, which is exactly when "v2" alone is ambiguous.
   */
  origin: string | null;
  /** When it appeared. The built-in has no `createdAt` — it ships in the code. */
  stamp: string;
  /** For a replaced row: what is running instead. Null when nothing is active. */
  supersededNote: string | null;
}

export interface PromptVersionDescriptor {
  /** Unique across the list even when two rows share a number. */
  key: string;
  item: PromptVersion;
  label: PromptVersionLabel;
}

const BUILT_IN_ORIGIN = "Mẫu hệ thống";
const TENANT_ORIGIN = "Bản của đơn vị";
const BUILT_IN_STAMP = "Đi kèm phần mềm";
const UNKNOWN_STAMP = "Không rõ thời điểm";

/** Stable row id: the version number alone collides, the pair never does. */
export function promptRowKey(version: PromptVersion): string {
  return `${version.source}-v${version.version}`;
}

export function describePromptVersions(
  versions: readonly PromptVersion[],
): readonly PromptVersionDescriptor[] {
  // Edge case first: nothing to describe, and nothing to count against.
  if (versions.length === 0) return [];

  const seen = new Map<number, number>();
  for (const version of versions) {
    seen.set(version.version, (seen.get(version.version) ?? 0) + 1);
  }

  // Exactly one row is active (the usecase demotes the built-in as soon as the
  // tenant has a version of its own), but a broken payload must not crash the
  // screen — `find` simply reports "nothing is active" and the note disappears.
  const activeVersion = versions.find((version) => version.status === "active")?.version ?? null;

  return versions.map((item) => ({
    key: promptRowKey(item),
    item,
    label: {
      number: `v${item.version}`,
      origin: originOf(item, (seen.get(item.version) ?? 0) > 1),
      stamp: stampOf(item),
      supersededNote: supersededNoteOf(item, activeVersion),
    },
  }));
}

function originOf(version: PromptVersion, isAmbiguous: boolean): string | null {
  if (version.source === "built_in") return BUILT_IN_ORIGIN;
  return isAmbiguous ? TENANT_ORIGIN : null;
}

function stampOf(version: PromptVersion): string {
  if (version.createdAt) return formatPromptDate(version.createdAt);
  // Two different silences: the built-in never had a creation row, a tenant row
  // that lost its timestamp is a gap in the data and says so.
  return version.source === "built_in" ? BUILT_IN_STAMP : UNKNOWN_STAMP;
}

function supersededNoteOf(version: PromptVersion, activeVersion: number | null): string | null {
  if (version.status !== "retired") return null;
  if (activeVersion === null) return null;

  // True by construction: the built-in is only retired once the tenant has an
  // active version of its own (manage-prompt-templates.ts, `listVersions`).
  if (version.source === "built_in") {
    return `Đã thay bằng bản riêng của đơn vị (v${activeVersion})`;
  }

  // Deliberately NOT "thay bởi vN": the list cannot say which version directly
  // replaced this one, only which one is running now.
  return `Hiện dùng v${activeVersion}`;
}
