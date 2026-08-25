import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  DEFAULT_STOCK_POLICY,
  makeFieldMap,
  MYSP_FIELD_MAP,
  validateFieldMapStructure,
  validateStockPolicy,
  type CatalogFieldMap,
  type StockPolicy,
} from "@/core/domain/catalog-field-map";
import { AppError } from "@/core/domain/errors";
import { validateCatalogTextConfig } from "@/core/domain/catalog-text-config";
import {
  mediaProfileNeedsLinkColumn,
  validateMediaProfile,
} from "@/core/domain/media-profile";
import type {
  CatalogConfigRepo,
  CatalogSourceConfig,
  SaveCatalogSourceInput,
} from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { lockIntegrationRow } from "./integration-lock";
import { auditLogs, tenantIntegrations } from "./schema";
import { findPlaintextSecretFields } from "./secret-box";
import { forTenant } from "./tenant-scope";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Reads the tenant's Drive/Sheet coordinates from `tenant_integration`
 * (CLAUDE.md business rule 7: no hardcoded folder or spreadsheet id).
 *
 * The JSONB blob is external-ish data — someone edits it by hand — so it goes
 * through a schema before it is trusted (technical rule 2).
 *
 * Encryption: the google row holds NO credential (a folder id, a spreadsheet id
 * and a tab name are not secrets — access comes from the Service Account key in
 * env), so nothing here is sealed. What the repo does do is warn when a
 * secret-looking field shows up unencrypted, which is how a token pasted into
 * the wrong provider row becomes visible instead of silently stored in clear.
 */

export const GOOGLE_PROVIDER = "google";

/**
 * Per-tenant column mapping, stored next to the three coordinates in the same
 * JSONB blob. `.optional()` everywhere is the backward-compatibility contract:
 * every row written before onboarding existed has no `fieldMap` key, and must
 * keep meaning "the MYSP preset" (resolved in core, not here).
 *
 * `.nullable()` on each field because "cột này tenant không có" is a real,
 * stored answer — not a missing value.
 */
const FieldMapSchema = z.object({
  code: z.string().trim().min(1).nullable(),
  name: z.string().trim().min(1).nullable(),
  description: z.string().trim().min(1).nullable(),
  category: z.string().trim().min(1).nullable(),
  season: z.string().trim().min(1).nullable(),
  stock: z.string().trim().min(1).nullable(),
  note: z.string().trim().min(1).nullable(),
  colors: z.string().trim().min(1).nullable(),
  /** Phase 2 slot — accepted and preserved, read by nothing yet. */
  mediaLink: z.string().trim().min(1).nullable().optional(),
});

/**
 * Discriminated on `mode` so a `disabled` policy CANNOT parse without its
 * reason: turning the stock gate off (CLAUDE.md business rule 3) is only legal
 * when a human wrote down why.
 */
const StockPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("numeric") }),
  z.object({
    mode: z.literal("textual"),
    inStockValues: z.array(z.string().trim().min(1)).min(1),
    outOfStockValues: z.array(z.string().trim().min(1)).min(1),
  }),
  z.object({ mode: z.literal("disabled"), reason: z.string().trim().min(10) }),
]);

/**
 * Where this tenant's photos live (onboarding phase 2). Optional for the same
 * backward-compatibility reason as `fieldMap`: a row written before phase 2 has
 * no key and must keep meaning "the internal `MÃ-Màu (số)` convention".
 *
 * The colour vocabulary is stored WITH the profile because it is the same
 * decision — a tenant who does not name colours in file names has no use for a
 * colour list either.
 */
const ColorVocabularySchema = z.object({
  canonical: z.array(z.string().trim().min(1)).max(500).optional(),
  aliases: z.record(z.string().trim().min(1), z.string().trim().min(1)).optional(),
  includeDefaults: z.boolean().optional(),
});

const MediaProfileSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sheet-column"), colors: ColorVocabularySchema.optional() }),
  z.object({ kind: z.literal("folder-per-code"), colors: ColorVocabularySchema.optional() }),
  z.object({ kind: z.literal("code-in-name"), colors: ColorVocabularySchema.optional() }),
  z.object({ kind: z.literal("code-color-seq"), colors: ColorVocabularySchema.optional() }),
]);

/**
 * Where the product TEXT is read from (onboarding phase 3). Optional for the
 * same backward-compatibility reason as `fieldMap`: a row without the key means
 * the Google tab, exactly as before.
 *
 * A `file` source cannot parse without its storage key, so a half-written
 * upload can never be read as "an empty catalog".
 */
const TextSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("google_sheet") }),
  z.object({
    kind: z.literal("file"),
    storageKey: z.string().trim().min(1),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().max(255).nullable().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    uploadedAt: z.string().trim().min(1).optional(),
    delimiter: z.string().max(4).nullable().optional(),
  }),
]);

/** Keys of the blob that describe MAPPING rather than coordinates. */
const MAPPING_KEYS = new Set(["fieldMap", "stockPolicy", "mediaProfile", "textSource"]);

const CatalogConfigShape = z.object({
  driveFolderId: z.string().trim(),
  spreadsheetId: z.string().trim(),
  sheetName: z.string().trim(),
  fieldMap: FieldMapSchema.optional(),
  stockPolicy: StockPolicySchema.optional(),
  mediaProfile: MediaProfileSchema.optional(),
  textSource: TextSourceSchema.optional(),
});

/**
 * Which coordinates are REQUIRED depends on the source (phase 3):
 *   - google_sheet (or absent): all three, exactly as before — a tenant
 *     configured before phase 3 is validated by the same rules it always was;
 *   - file: none of them. That tenant may have no Google account at all, and
 *     may run its photos through the upload mode.
 */
const CatalogConfigSchema = CatalogConfigShape.superRefine((value, ctx) => {
  if ((value.textSource?.kind ?? "google_sheet") !== "google_sheet") return;
  for (const key of ["driveFolderId", "spreadsheetId", "sheetName"] as const) {
    if (value[key].length > 0) continue;
    ctx.addIssue({ code: "custom", path: [key], message: `${key} is required` });
  }
});

/** True when every problem is about the mapping keys, not the coordinates. */
function isMappingOnlyIssue(issues: readonly { path: PropertyKey[] }[]): boolean {
  return issues.every((issue) => MAPPING_KEYS.has(String(issue.path[0] ?? "")));
}

/** Drops `undefined` keys so the returned object matches the optional port. */
function toSourceConfig(parsed: z.infer<typeof CatalogConfigSchema>): CatalogSourceConfig {
  return {
    driveFolderId: parsed.driveFolderId,
    spreadsheetId: parsed.spreadsheetId,
    sheetName: parsed.sheetName,
    ...(parsed.fieldMap ? { fieldMap: parsed.fieldMap } : {}),
    ...(parsed.stockPolicy ? { stockPolicy: parsed.stockPolicy } : {}),
    ...(parsed.mediaProfile ? { mediaProfile: parsed.mediaProfile } : {}),
    ...(parsed.textSource ? { textSource: parsed.textSource } : {}),
  };
}

/**
 * The source kind already stored for this tenant, read straight off the raw
 * blob. Deliberately NOT taken from `CatalogConfigSchema`: a row whose
 * `fieldMap` is broken still knows perfectly well that it reads a file, and
 * falling back to "google_sheet" there would re-create the bug this exists to
 * fix. Anything unreadable answers null, and the caller defaults safely.
 */
function readStoredTextSourceKind(config: Record<string, unknown>): "google_sheet" | "file" | null {
  const parsed = TextSourceSchema.safeParse((config as { textSource?: unknown })?.textSource);
  return parsed.success ? parsed.data.kind : null;
}

/**
 * The stored value of ONE key, read straight off the raw blob — same reasoning
 * as `readStoredTextSourceKind`: a row whose OTHER keys are broken still knows
 * what this one says, and parsing the whole blob would make a broken
 * `stockPolicy` silently change the answer about the `fieldMap`.
 */
function readStoredKey<T>(
  config: Record<string, unknown>,
  key: "fieldMap" | "stockPolicy" | "mediaProfile",
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
): T | null {
  const parsed = schema.safeParse((config as Record<string, unknown>)[key]);
  return parsed.success ? parsed.data : null;
}

export class DrizzleCatalogConfigRepo implements CatalogConfigRepo {
  /** Logger is optional so existing call sites keep compiling; pass it in prod. */
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  async findCatalogConfig(tenantId: TenantId): Promise<CatalogSourceConfig | null> {
    const scope = forTenant(this.db, tenantId);

    let rows: Array<{ config: Record<string, unknown>; status: string }>;
    try {
      rows = await scope.db
        .select({ config: tenantIntegrations.config, status: tenantIntegrations.status })
        .from(tenantIntegrations)
        .where(
          scope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)),
        )
        .limit(1);
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "tenantId",
        operation: "catalogConfig.find",
      });
    }

    const row = rows[0];
    if (!row) return null;

    if (row.status === "disabled") {
      throw new AppError("SYNC_FAILED", {
        message: "Google integration is disabled for this tenant",
        userMessage: "Tích hợp Google của đơn vị này đang bị tắt.",
        context: { tenant_id: scope.tenantId, provider: GOOGLE_PROVIDER },
      });
    }

    const plaintextSecrets = findPlaintextSecretFields(row.config);
    if (plaintextSecrets.length > 0) {
      // Field NAMES only — a warning that leaks the token defeats its purpose.
      this.logger?.warn("tenant_integration.config holds unencrypted secret-looking fields", {
        scope: "secrets",
        reason: "PLAINTEXT_LEGACY",
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        fields: plaintextSecrets,
      });
    }

    const parsed = CatalogConfigSchema.safeParse(row.config);
    if (!parsed.success) {
      // A half-filled integration row must not turn into an empty sync that
      // looks successful — fail loudly and name the broken keys. A broken
      // fieldMap/stockPolicy is NEVER downgraded to "use the default": that
      // would read a customer sheet with our own column names.
      const mappingOnly = isMappingOnlyIssue(parsed.error.issues);
      throw new AppError("SYNC_FAILED", {
        message: mappingOnly
          ? "tenant_integration.config has an invalid fieldMap/stockPolicy"
          : "tenant_integration.config is missing Drive/Sheet keys",
        userMessage: mappingOnly
          ? "Cấu hình cột dữ liệu / chế độ tồn kho của đơn vị không hợp lệ — mở phần cấu hình nguồn dữ liệu và khai báo lại."
          : "Cấu hình Drive/Sheet của đơn vị chưa đầy đủ (thiếu driveFolderId / spreadsheetId / sheetName).",
        context: {
          tenant_id: scope.tenantId,
          reason: mappingOnly ? "MAPPING_INVALID" : "CONFIG_INCOMPLETE",
          issues: parsed.error.issues.map((issue) => issue.path.join(".")),
        },
      });
    }

    return toSourceConfig(parsed.data);
  }

  /**
   * Read-model twin: same row, but a missing/half-filled/disabled integration
   * is "chưa cấu hình" instead of a thrown error. The reason is logged, because
   * a row that exists but cannot be parsed is a different problem from no row
   * at all — the panel just does not need to say which.
   */
  async findCatalogSource(tenantId: TenantId): Promise<CatalogSourceConfig | null> {
    const scope = forTenant(this.db, tenantId);

    let rows: Array<{ config: Record<string, unknown>; status: string }>;
    try {
      rows = await scope.db
        .select({ config: tenantIntegrations.config, status: tenantIntegrations.status })
        .from(tenantIntegrations)
        .where(scope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)))
        .limit(1);
    } catch (error) {
      // A driver failure is NOT "not configured" — the panel must not invite
      // the operator to re-enter a source that is already there.
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "tenantId",
        operation: "catalogConfig.findSource",
      });
    }

    const row = rows[0];
    if (!row) return null;

    if (row.status === "disabled") {
      this.logger?.warn("Google integration is disabled — panel shows it as unconfigured", {
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        reason: "INTEGRATION_DISABLED",
      });
      return null;
    }

    const parsed = CatalogConfigSchema.safeParse(row.config);
    if (!parsed.success) {
      // Same verdict for a broken mapping as for missing coordinates: the panel
      // says "chưa cấu hình" and the operator re-declares it. Returning the
      // source while dropping an unreadable fieldMap would be the silent
      // fallback to our own columns that technical rule 2 forbids.
      this.logger?.warn("tenant_integration.config could not be parsed", {
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        reason: isMappingOnlyIssue(parsed.error.issues) ? "MAPPING_INVALID" : "CONFIG_INCOMPLETE",
        issues: parsed.error.issues.map((issue) => issue.path.join(".")),
      });
      return null;
    }

    return toSourceConfig(parsed.data);
  }

  /**
   * Hot-path read of the stock policy alone (port contract: never throws for a
   * tenant without an integration).
   *
   * The three answers are deliberately different:
   *   no row / disabled / no `stockPolicy` key -> `numeric`, logged at debug.
   *     A tenant on the upload-only mode has no google row at all, and the
   *     stock gate must keep working for it — `numeric` is the SAFE default,
   *     not a shortcut.
   *   stored policy that does not parse       -> AppError, same code as
   *     `findCatalogConfig`. Degrading a broken policy into "khỏi kiểm tồn"
   *     would be the exact silent fallback this feature must not have.
   *   database failure                        -> rethrown as a DB error: an
   *     outage is not a configuration answer.
   */
  async findStockPolicy(tenantId: TenantId): Promise<StockPolicy> {
    const scope = forTenant(this.db, tenantId);
    const config = await this.readGoogleConfig(scope.tenantId, "catalogConfig.findStockPolicy");
    if (config === null) return DEFAULT_STOCK_POLICY;

    // Only the one key is read: half-filled coordinates are irrelevant to the
    // stock gate and must not block a compose.
    const stored = (config as { stockPolicy?: unknown })?.stockPolicy;
    if (stored === undefined || stored === null) {
      this.logger?.debug("Tenant declared no stock policy — using the numeric default", {
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        reason: "NO_STOCK_POLICY",
        stock_policy_mode: DEFAULT_STOCK_POLICY.mode,
      });
      return DEFAULT_STOCK_POLICY;
    }

    const parsed = StockPolicySchema.safeParse(stored);
    const domainIssues = parsed.success ? validateStockPolicy(parsed.data) : [];
    if (!parsed.success || domainIssues.length > 0) {
      const issues = parsed.success
        ? domainIssues.map((issue) => issue.code)
        : parsed.error.issues.map((issue) => issue.path.join("."));
      this.logger?.error("Stored stock policy is unusable — refusing to guess", {
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        error_code: "SYNC_FAILED",
        reason: "MAPPING_INVALID",
        issues,
      });
      throw new AppError("SYNC_FAILED", {
        message: "tenant_integration.config has an invalid stockPolicy",
        userMessage:
          "Cấu hình kiểm tồn kho của đơn vị không hợp lệ — mở phần cấu hình nguồn dữ liệu và khai báo lại.",
        context: { tenant_id: scope.tenantId, reason: "MAPPING_INVALID", issues },
      });
    }

    if (parsed.data.mode === "disabled") {
      // Every read of a disabled gate is on the record, not just the sync.
      this.logger?.warn("Tenant runs with the stock check DISABLED", {
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        error_code: "STOCK_CHECK_DISABLED",
        stock_policy_mode: "disabled",
        stock_policy_reason: parsed.data.reason,
      });
    }

    return parsed.data;
  }

  /**
   * Hot-path read of the column mapping alone. Symmetric to `findStockPolicy`:
   * the preset answers "nothing configured", a stored map that cannot be parsed
   * answers with an error. Falling back to the preset on a BROKEN map would
   * read a customer sheet with our own Vietnamese headers — zero products, and
   * the sync would look successful.
   */
  async findFieldMap(tenantId: TenantId): Promise<CatalogFieldMap> {
    const scope = forTenant(this.db, tenantId);
    const config = await this.readGoogleConfig(scope.tenantId, "catalogConfig.findFieldMap");
    if (config === null) return MYSP_FIELD_MAP;

    const stored = (config as { fieldMap?: unknown })?.fieldMap;
    if (stored === undefined || stored === null) {
      this.logger?.debug("Tenant declared no field map — using the MYSP preset", {
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        reason: "NO_FIELD_MAP",
      });
      return MYSP_FIELD_MAP;
    }

    const parsed = FieldMapSchema.safeParse(stored);
    const structural = parsed.success ? validateFieldMapStructure(makeFieldMap(parsed.data)) : [];
    const blocking = structural.filter((issue) => issue.severity === "error");
    if (!parsed.success || blocking.length > 0) {
      const issues = parsed.success
        ? blocking.map((issue) => issue.code)
        : parsed.error.issues.map((issue) => issue.path.join("."));
      this.logger?.error("Stored field map is unusable — refusing to guess", {
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        error_code: "SYNC_FAILED",
        reason: "MAPPING_INVALID",
        issues,
      });
      throw new AppError("SYNC_FAILED", {
        message: "tenant_integration.config has an invalid fieldMap",
        userMessage:
          "Cấu hình cột dữ liệu của đơn vị không hợp lệ — mở phần cấu hình nguồn dữ liệu và khai báo lại.",
        context: { tenant_id: scope.tenantId, reason: "MAPPING_INVALID", issues },
      });
    }

    return makeFieldMap(parsed.data);
  }

  /**
   * The row read shared by the two hot-path getters.
   *
   * Returns null — never throws — for "this tenant has no usable google
   * integration" (no row, or one an admin disabled), which is a normal state
   * for a tenant on the upload-only mode. A DRIVER failure is a different
   * thing and is rethrown: an outage must not read as "chưa cấu hình".
   */
  private async readGoogleConfig(
    tenantId: TenantId,
    operation: string,
  ): Promise<Record<string, unknown> | null> {
    const scope = forTenant(this.db, tenantId);

    let rows: Array<{ config: Record<string, unknown>; status: string }>;
    try {
      rows = await scope.db
        .select({ config: tenantIntegrations.config, status: tenantIntegrations.status })
        .from(tenantIntegrations)
        .where(scope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)))
        .limit(1);
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "tenantId",
        operation,
      });
    }

    const row = rows[0];
    if (!row || row.status === "disabled") {
      this.logger?.debug("No usable google integration — falling back to the defaults", {
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        operation,
        reason: row ? "INTEGRATION_DISABLED" : "NO_INTEGRATION_ROW",
      });
      return null;
    }

    return row.config;
  }

  /**
   * Upsert + audit in ONE transaction, behind the per-(tenant, provider)
   * advisory lock every writer of `tenant_integration` takes.
   *
   * The lock is what makes the promise below true. Reading the previous config
   * "inside the transaction" is not enough on its own: the FIRST save of a
   * tenant has no row for `FOR UPDATE` to lock, so two operators saving at the
   * same moment would both read nothing, both write an audit row saying
   * `old: null`, and the second upsert would drop the first one's source (and
   * any other key of the google blob). See adapters/db/integration-lock.
   *
   * Other keys of `config` are preserved: the google row is shared with future
   * provider settings, and a source change must not silently drop them.
   * `status` is left as it is on update — re-enabling a disabled integration is
   * a separate, deliberate action.
   */
  async saveCatalogSource(
    input: SaveCatalogSourceInput,
  ): Promise<{ previous: CatalogSourceConfig | null }> {
    const scope = forTenant(this.db, input.tenantId);
    const source = input?.source;

    // SHAPE only. Whether the three coordinates are REQUIRED depends on which
    // source this tenant ends up reading, and that is a question about STORED
    // state, not about this patch — so it is asked inside the transaction
    // below, where `existing` has been read under the lock.
    // A key that is ABSENT means "keep what is stored"; a key that is present
    // must still be a string ("" = clear it). The two are deliberately not the
    // same thing, so `undefined` passes here and only a wrong TYPE is refused.
    const isPatchString = (value: unknown): boolean =>
      value === undefined || typeof value === "string";
    if (
      !source ||
      !isPatchString(source.driveFolderId) ||
      !isPatchString(source.spreadsheetId) ||
      !isPatchString(source.sheetName)
    ) {
      throw new AppError("INVALID_INPUT", {
        message: "saveCatalogSource coordinates must be strings when present",
        userMessage: "Thiếu thông tin nguồn dữ liệu Drive/Sheet.",
        context: { tenant_id: scope.tenantId, field: "source" },
      });
    }

    // Same door check as the mapping keys below: this blob is hand-edited in
    // production, so a source that could not be read is refused with a code.
    if (source.textSource !== undefined) {
      const parsedText = TextSourceSchema.safeParse(source.textSource);
      const textIssues = parsedText.success ? validateCatalogTextConfig(parsedText.data) : [];
      if (!parsedText.success || textIssues.length > 0) {
        throw new AppError("INVALID_INPUT", {
          message: "saveCatalogSource received an unusable textSource",
          userMessage:
            textIssues[0]?.detail ??
            "Nguồn dữ liệu sản phẩm không hợp lệ — chọn lại bảng tính Google hoặc tải lên file .csv.",
          context: {
            tenant_id: scope.tenantId,
            field: "textSource",
            kind: (source.textSource as { kind?: unknown })?.kind ?? null,
            issues: parsedText.success
              ? textIssues.map((issue) => issue.code)
              : parsedText.error.issues.map((issue) => issue.path.join(".")),
          },
        });
      }
    }

    // The mapping is validated HERE, not only in core: this row is hand-edited
    // in production and a bad map must be refused at the door, with a code.
    if (source.fieldMap !== undefined) {
      const parsedMap = FieldMapSchema.safeParse(source.fieldMap);
      const structural = parsedMap.success
        ? validateFieldMapStructure(makeFieldMap(parsedMap.data))
        : [];
      const blocking = structural.filter((issue) => issue.severity === "error");
      if (!parsedMap.success || blocking.length > 0) {
        throw new AppError("INVALID_INPUT", {
          message: "saveCatalogSource received an unusable fieldMap",
          userMessage:
            blocking[0]?.detail ??
            "Bảng ánh xạ cột không hợp lệ — mỗi trường phải trỏ tới một tên cột có thật.",
          context: {
            tenant_id: scope.tenantId,
            field: "fieldMap",
            issues: parsedMap.success
              ? blocking.map((issue) => issue.code)
              : parsedMap.error.issues.map((issue) => issue.path.join(".")),
          },
        });
      }
    }

    if (source.stockPolicy !== undefined) {
      const parsedPolicy = StockPolicySchema.safeParse(source.stockPolicy);
      const policyIssues = parsedPolicy.success ? validateStockPolicy(parsedPolicy.data) : [];
      if (!parsedPolicy.success || policyIssues.length > 0) {
        throw new AppError("INVALID_INPUT", {
          message: "saveCatalogSource received an unusable stockPolicy",
          userMessage:
            policyIssues[0]?.detail ??
            "Cấu hình kiểm tồn kho không hợp lệ. Chế độ 'tắt kiểm tồn' bắt buộc phải khai lý do.",
          context: {
            tenant_id: scope.tenantId,
            field: "stockPolicy",
            mode: (source.stockPolicy as { mode?: unknown })?.mode ?? null,
            issues: parsedPolicy.success
              ? policyIssues.map((issue) => issue.code)
              : parsedPolicy.error.issues.map((issue) => issue.path.join(".")),
          },
        });
      }
    }

    if (source.mediaProfile !== undefined) {
      const parsedProfile = MediaProfileSchema.safeParse(source.mediaProfile);
      const profileIssues = parsedProfile.success ? validateMediaProfile(parsedProfile.data) : [];
      const blockingProfile = profileIssues.filter((issue) => issue.severity === "error");
      if (!parsedProfile.success || blockingProfile.length > 0) {
        throw new AppError("INVALID_INPUT", {
          message: "saveCatalogSource received an unusable mediaProfile",
          userMessage:
            blockingProfile[0]?.detail ??
            "Cấu hình nguồn ảnh không hợp lệ — chọn lại kiểu nguồn ảnh (link trên bảng tính / thư mục theo mã / mã trong tên file).",
          context: {
            tenant_id: scope.tenantId,
            field: "mediaProfile",
            kind: (source.mediaProfile as { kind?: unknown })?.kind ?? null,
            issues: parsedProfile.success
              ? blockingProfile.map((issue) => issue.code)
              : parsedProfile.error.issues.map((issue) => issue.path.join(".")),
          },
        });
      }
    }

    // Undefined means "keep whatever is stored" (port contract), so a key is
    // only written when the caller actually supplied it. The three coordinates
    // are NOT here: they are merged with the stored ones inside the transaction
    // (see `nextSource` below), because computing them from a read taken
    // outside the lock is exactly the lost update this patch shape prevents.
    const next: Partial<CatalogSourceConfig> = {
      ...(source.fieldMap !== undefined ? { fieldMap: makeFieldMap(source.fieldMap) } : {}),
      ...(source.stockPolicy !== undefined ? { stockPolicy: source.stockPolicy } : {}),
      ...(source.mediaProfile !== undefined ? { mediaProfile: source.mediaProfile } : {}),
      ...(source.textSource !== undefined ? { textSource: source.textSource } : {}),
    };

    try {
      return await scope.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        // First, and before the read: a save that arrives while another one is
        // in flight waits here instead of racing it.
        await lockIntegrationRow(txScope, GOOGLE_PROVIDER);

        const existing = await txScope.db
          .select({ config: tenantIntegrations.config })
          .from(tenantIntegrations)
          .where(txScope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)))
          .limit(1)
          // Row-level guard for any writer that skips the advisory lock.
          .for("update");

        const currentConfig = existing[0]?.config ?? {};

        // WHICH SOURCE will this tenant read after the write: what the patch
        // sends, else what is already stored, else the Google tab.
        //
        // This is the fix for a real cross-layer bug: the check used to read
        // `source.textSource?.kind` alone, but a caller that only changes a
        // column mapping deliberately OMITS `textSource` ("keep what is
        // stored", the port contract). The guard then read `undefined`, assumed
        // Google, and demanded a spreadsheet id from a tenant whose catalog is
        // an uploaded CSV — the one tenant phase 3 exists for.
        const storedTextKind = readStoredTextSourceKind(currentConfig);
        const effectiveTextKind = source.textSource?.kind ?? storedTextKind ?? "google_sheet";

        // The three coordinates, MERGED here and nowhere else: a patch that
        // omits one keeps whatever this row holds RIGHT NOW, under the lock.
        // Computing them from a read taken before the transaction is how two
        // admins saving at once silently revert each other (F3).
        const coordinate = (patched: string | undefined, key: keyof CatalogSourceConfig): string => {
          if (patched !== undefined) return patched.trim();
          const stored = (currentConfig as Record<string, unknown>)[key];
          return typeof stored === "string" ? stored.trim() : "";
        };
        const nextSource = {
          driveFolderId: coordinate(source.driveFolderId, "driveFolderId"),
          spreadsheetId: coordinate(source.spreadsheetId, "spreadsheetId"),
          sheetName: coordinate(source.sheetName, "sheetName"),
        };

        // Unchanged rule, asked of the EFFECTIVE state: a tenant on a Google tab
        // may not end up with a blank coordinate — whether it was blanked by
        // this patch or was already missing.
        if (
          effectiveTextKind === "google_sheet" &&
          (nextSource.driveFolderId.length === 0 ||
            nextSource.spreadsheetId.length === 0 ||
            nextSource.sheetName.length === 0)
        ) {
          throw new AppError("INVALID_INPUT", {
            message: "saveCatalogSource requires driveFolderId, spreadsheetId and sheetName",
            userMessage: "Thiếu thông tin nguồn dữ liệu Drive/Sheet.",
            context: {
              tenant_id: scope.tenantId,
              field: "source",
              text_source: effectiveTextKind,
              stored_text_source: storedTextKind,
            },
          });
        }

        // --- Combinations: each half is legal, the pair is not ------------
        //
        // Judged on PATCH + STORED, never on the patch alone (the bug above,
        // one class up): a save that only changes the media profile carries no
        // fieldMap, and the column it needs may well be sitting in the stored
        // one. The same rules exist in `syncCatalog`, but a sync happens hours
        // later with nobody watching — refusing here puts the message in front
        // of the operator while they are still looking at the form that caused
        // it.
        const effectiveFieldMap =
          source.fieldMap !== undefined
            ? makeFieldMap(source.fieldMap)
            : makeFieldMap(readStoredKey(currentConfig, "fieldMap", FieldMapSchema) ?? undefined);
        const effectiveMediaProfile =
          source.mediaProfile ?? readStoredKey(currentConfig, "mediaProfile", MediaProfileSchema);
        const effectiveStockPolicy =
          source.stockPolicy ?? readStoredKey(currentConfig, "stockPolicy", StockPolicySchema);

        if (mediaProfileNeedsLinkColumn(effectiveMediaProfile) && effectiveFieldMap.mediaLink === null) {
          throw new AppError("INVALID_INPUT", {
            message: "mediaProfile 'sheet-column' requires a mapped fieldMap.mediaLink",
            userMessage:
              "Đang chọn cách tìm ảnh theo cột link trên bảng dữ liệu, nhưng chưa chỉ định cột nào chứa link ảnh. Vào phần chọn cột, gán cột chứa link ảnh (hoặc đổi sang cách tìm ảnh khác) rồi lưu lại.",
            context: {
              tenant_id: scope.tenantId,
              field: "mediaProfile",
              reason: "MEDIA_PROFILE_NEEDS_LINK_COLUMN",
              media_profile_kind: effectiveMediaProfile?.kind ?? null,
              media_profile_from: source.mediaProfile !== undefined ? "patch" : "stored",
              field_map_from: source.fieldMap !== undefined ? "patch" : "stored",
            },
          });
        }

        if (effectiveStockPolicy?.mode === "textual" && effectiveFieldMap.stock === null) {
          throw new AppError("INVALID_INPUT", {
            message: "stockPolicy 'textual' requires a mapped fieldMap.stock",
            userMessage:
              "Đang chọn kiểm tồn kho dạng chữ (khai giá trị CÒN/HẾT hàng), nhưng chưa chỉ định cột nào chứa tồn kho. Vào phần chọn cột, gán cột tồn kho (hoặc đổi chế độ kiểm tồn) rồi lưu lại.",
            context: {
              tenant_id: scope.tenantId,
              field: "stockPolicy",
              reason: "STOCK_POLICY_NEEDS_STOCK_COLUMN",
              stock_policy_mode: effectiveStockPolicy.mode,
              stock_policy_from: source.stockPolicy !== undefined ? "patch" : "stored",
              field_map_from: source.fieldMap !== undefined ? "patch" : "stored",
            },
          });
        }

        const parsedPrevious = CatalogConfigSchema.safeParse(currentConfig);
        const previous: CatalogSourceConfig | null = parsedPrevious.success
          ? toSourceConfig(parsedPrevious.data)
          : null;

        // Spread order keeps every other key of the google blob, including a
        // stored fieldMap/stockPolicy the caller did not touch.
        const mergedConfig = { ...currentConfig, ...nextSource, ...next };

        // The row AFTER the write, read back through the same schema as `old`.
        // Both halves of the audit payload must have the same shape: a payload
        // whose `new` only carried the patched keys made every "chỉ đổi thư
        // mục" save look, in the audit trail, like the mapping had been
        // deleted. `null` on an unparseable blob mirrors `previous` exactly.
        // Every key this save actually carried, coordinates included.
        const patchedKeys = (
          [
            "driveFolderId",
            "spreadsheetId",
            "sheetName",
            "fieldMap",
            "stockPolicy",
            "mediaProfile",
            "textSource",
          ] as const
        ).filter((key) => source[key] !== undefined);

        const parsedNext = CatalogConfigSchema.safeParse(mergedConfig);
        const nextConfig: CatalogSourceConfig | null = parsedNext.success
          ? toSourceConfig(parsedNext.data)
          : null;

        await txScope.db
          .insert(tenantIntegrations)
          .values(txScope.row({ provider: GOOGLE_PROVIDER, config: mergedConfig }))
          .onConflictDoUpdate({
            target: [tenantIntegrations.tenantId, tenantIntegrations.provider],
            set: { config: mergedConfig, updatedAt: new Date() },
          });

        await txScope.db.insert(auditLogs).values(
          txScope.row({
            actorUserId: input.actorUserId ?? null,
            action: "catalog_source.updated",
            entityType: "tenant_integration",
            entityId: GOOGLE_PROVIDER,
            payload: {
              old: previous,
              // The full state of the row after this write — NOT the patch, so
              // an old->new diff describes what actually changed.
              new: nextConfig,
              // What this save actually asked for, kept beside the two states
              // because "đổi cột" and "chỉ đổi thư mục" are different incidents
              // and the diff alone cannot tell them apart.
              patched: patchedKeys,
              actor_email: input.actorEmail ?? null,
            },
          }),
        );

        return { previous };
      });
    } catch (error) {
      // A refusal thrown INSIDE the transaction (blank coordinates, a broken
      // combination) is already an AppError carrying its own `field`/`reason`.
      // `wrapDbError` merges its context ON TOP, so wrapping it here would
      // relabel every one of them `field: "source"` and the form would
      // highlight the wrong box. Only a real driver failure needs wrapping.
      if (AppError.is(error)) throw error;
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "source",
        operation: "catalogConfig.saveSource",
        provider: GOOGLE_PROVIDER,
      });
    }
  }
}
