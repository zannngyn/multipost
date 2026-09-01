/**
 * The platform's appearance setting (M3.4). Types only.
 *
 * PLATFORM layer, like `platform-tenant-repo`: no tenant context anywhere —
 * one value governs every company at once.
 *
 * Contract for every implementer:
 * - `read` returns the value EXACTLY as stored, unvalidated, and `null` when
 *   nothing was ever written. It must not substitute a default: only the
 *   usecase knows which ids are still real after a deploy, and a repo that
 *   quietly hands back "cham" would hide a row nobody can explain;
 * - `write` is one transaction — the setting and its audit row land together
 *   or neither does;
 * - `write` is an upsert on the key: the table holds ONE row per setting, and
 *   a second call must replace, never accumulate.
 */

export interface WriteAppearancePresetRecord {
  readonly presetId: string;
  readonly actorAccountId: string;
  /** For the audit payload only — never used to authorise. */
  readonly actorEmail: string | null;
  /** What the value was before, so the trail reads as a change, not a state. */
  readonly previousPresetId: string | null;
}

export interface AppearanceSettingRepo {
  read(): Promise<unknown>;
  write(record: WriteAppearancePresetRecord): Promise<void>;
}
