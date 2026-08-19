import { eq } from "drizzle-orm";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import {
  GOOGLE_SOURCE_ACCESS_STATES,
  type DeleteGoogleConnectionInput,
  type GoogleOAuthConnection,
  type GoogleOAuthRepo,
  type SaveGoogleConnectionInput,
  type SaveGoogleSourceAccessInput,
} from "@/core/ports/google-oauth";
import type { Logger } from "@/core/ports/infra";

import { GOOGLE_PROVIDER } from "./catalog-config-repo.drizzle";
import type { Database, DbExecutor } from "./client";
import { wrapDbError } from "./db-errors";
import { lockIntegrationRow } from "./integration-lock";
import { auditLogs, tenantIntegrations } from "./schema";
import { isSealedSecret, type SecretBox } from "./secret-box";
import { forTenant, type TenantScopedDb } from "./tenant-scope";

/**
 * The tenant's Google OAuth connection, stored under `oauth` inside the SAME
 * `tenant_integration` row (provider `google`) that already holds the Drive
 * folder id, the spreadsheet id and the tab name.
 *
 * One row, one lock: every writer of this blob takes the per-(tenant, provider)
 * advisory lock BEFORE reading, because the first write of a tenant has no row
 * for `FOR UPDATE` to lock — see adapters/db/integration-lock for the full
 * story. Without it, connecting Google would silently drop a source that was
 * saved at the same moment.
 *
 * SECRETS: `oauth.refreshToken` is sealed with the same box the Meta channel
 * tokens use. It is opened in exactly ONE method (`findRefreshToken`) and
 * never logged, not even partially.
 */

/** The key of the connection inside `tenant_integration.config`. */
const OAUTH_KEY = "oauth";

/**
 * What we accept back out of the blob. `refreshToken` may be an envelope or (on
 * a legacy row) plaintext — either way it is a string here, and it is opened
 * only where it is needed.
 */
const SourceAccessSchema = z.object({
  state: z.enum(GOOGLE_SOURCE_ACCESS_STATES),
  checkedAt: z.string().trim().min(1),
});

const StoredOAuthSchema = z.object({
  refreshToken: z.string().trim().min(1),
  email: z.string().trim().min(1),
  scopes: z.array(z.string().trim().min(1)).default([]),
  connectedAt: z.string().trim().min(1),
  connectedByUserId: z.string().trim().min(1).nullish(),
  /**
   * Absent on every connection made before the check existed, and on a blob a
   * human edited. Absent reads as "unknown" upstream — never as "ok".
   */
  sourceAccess: SourceAccessSchema.nullish().catch(null),
});

/**
 * `tenant_integration.status` as the schema defines it. Parsed, not cast: a
 * value nobody planned for must not be written back verbatim by an update that
 * only meant to touch the config blob.
 */
const IntegrationStatusSchema = z.enum(["active", "disabled", "error"]);

export interface GoogleOAuthRepoDeps {
  box: SecretBox;
  logger: Logger;
}

export class DrizzleGoogleOAuthRepo implements GoogleOAuthRepo {
  constructor(
    private readonly db: Database,
    private readonly deps: GoogleOAuthRepoDeps,
  ) {}

  async findConnection(tenantId: string): Promise<GoogleOAuthConnection | null> {
    const scope = forTenant(this.db, tenantId);
    const row = await this.readRow(scope);
    if (!row) return null;

    const stored = this.parseOAuth(scope.tenantId, row.config);
    if (!stored) return null;

    return {
      email: stored.email,
      scopes: stored.scopes,
      connectedAt: stored.connectedAt,
      connectedByUserId: stored.connectedByUserId ?? null,
      // `disabled` is an administrative switch, not a dead token; the screen
      // treats anything that is not `error` as a live connection.
      status: row.status === "error" ? "error" : "active",
      // Read from the row, never re-probed here: this method answers a screen
      // that polls, and a Drive call per poll would burn quota (docs B1).
      sourceAccess: stored.sourceAccess ?? null,
    };
  }

  /** SECRET. The only place an envelope becomes a usable refresh token. */
  async findRefreshToken(tenantId: string): Promise<string | null> {
    const scope = forTenant(this.db, tenantId);
    const row = await this.readRow(scope);
    if (!row) return null;

    const stored = this.parseOAuth(scope.tenantId, row.config);
    if (!stored) return null;

    // Throws on a wrong/rotated key rather than falling back to the Service
    // Account: silently reading the tenant's catalog as somebody else is worse
    // than a loud failure naming the encryption key.
    return this.deps.box.openSecret(stored.refreshToken, {
      tenantId: scope.tenantId,
      provider: GOOGLE_PROVIDER,
      field: "oauth.refreshToken",
    });
  }

  async saveConnection(input: SaveGoogleConnectionInput): Promise<void> {
    // --- Edge cases first ----------------------------------------------------
    const scope = forTenant(this.db, input?.tenantId ?? "");
    const refreshToken = str(input?.refreshToken);
    const email = str(input?.email);
    const connectedAt = str(input?.connectedAt);
    if (refreshToken.length === 0 || email.length === 0 || connectedAt.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "saveConnection requires a refresh token, an e-mail and a timestamp",
        userMessage: "Thiếu thông tin kết nối Google.",
        context: {
          tenant_id: scope.tenantId,
          // Field NAMES only — never the token, not even its length.
          missing: [
            refreshToken.length === 0 ? "refreshToken" : null,
            email.length === 0 ? "email" : null,
            connectedAt.length === 0 ? "connectedAt" : null,
          ].filter(Boolean),
        },
      });
    }

    const scopes = Array.isArray(input?.scopes)
      ? Array.from(new Set(input.scopes.map(str).filter((s) => s.length > 0)))
      : [];

    // ALWAYS sealed, never "sealed unless it already LOOKS sealed": the input of
    // this method comes from Google's token endpoint, so letting its shape
    // decide whether we encrypt is trusting outside data with a secret
    // (technical rule 2). A value shaped like an envelope is refused by the box
    // (ALREADY_SEALED) — a loud failure, which beats storing a Google token in
    // clear because it happened to start with the envelope prefix.
    const sealed = this.deps.box.sealSecret(refreshToken);

    try {
      await scope.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        await lockIntegrationRow(txScope, GOOGLE_PROVIDER);

        const existing = await txScope.db
          .select({ config: tenantIntegrations.config })
          .from(tenantIntegrations)
          .where(txScope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)))
          .limit(1)
          .for("update");

        const currentConfig = existing[0]?.config ?? {};
        const previous = this.parseOAuth(txScope.tenantId, currentConfig);
        // Every other key of the blob survives: the source coordinates live in
        // the same row and a connect must not wipe them.
        const mergedConfig = {
          ...currentConfig,
          [OAUTH_KEY]: {
            refreshToken: sealed,
            email,
            scopes,
            connectedAt,
            connectedByUserId: input?.actorUserId ?? null,
          },
        };

        await txScope.db
          .insert(tenantIntegrations)
          .values(
            txScope.row({
              provider: GOOGLE_PROVIDER,
              config: mergedConfig,
              status: "active" as const,
            }),
          )
          .onConflictDoUpdate({
            target: [tenantIntegrations.tenantId, tenantIntegrations.provider],
            set: {
              config: mergedConfig,
              // A fresh consent is exactly the action an `error` row asked for.
              status: "active" as const,
              updatedAt: new Date(),
            },
          });

        await txScope.db.insert(auditLogs).values(
          txScope.row({
            actorUserId: input?.actorUserId ?? null,
            action: "google_oauth.connected",
            entityType: "tenant_integration",
            entityId: GOOGLE_PROVIDER,
            payload: {
              old: previous ? { email: previous.email, connected_at: previous.connectedAt } : null,
              new: { email, scopes, connected_at: connectedAt },
              actor_email: input?.actorEmail ?? null,
            },
          }),
        );
      });
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "oauth",
        operation: "googleOAuth.save",
        provider: GOOGLE_PROVIDER,
      });
    }
  }

  async deleteConnection(
    input: DeleteGoogleConnectionInput,
  ): Promise<{ readonly removed: boolean }> {
    const scope = forTenant(this.db, input?.tenantId ?? "");

    try {
      return await scope.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        await lockIntegrationRow(txScope, GOOGLE_PROVIDER);

        const existing = await txScope.db
          .select({ config: tenantIntegrations.config, status: tenantIntegrations.status })
          .from(tenantIntegrations)
          .where(txScope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)))
          .limit(1)
          .for("update");

        const row = existing[0];
        // Nothing to remove is a valid outcome, not an error: pressing "Ngắt
        // kết nối" twice must leave the same state as pressing it once.
        if (!row) return { removed: false };

        const currentConfig = row.config ?? {};
        const previous = this.parseOAuth(txScope.tenantId, currentConfig);
        const hadOAuth = Object.prototype.hasOwnProperty.call(currentConfig, OAUTH_KEY);
        if (!hadOAuth) return { removed: false };

        const nextConfig = { ...currentConfig };
        delete nextConfig[OAUTH_KEY];

        await txScope.db
          .update(tenantIntegrations)
          .set({
            config: nextConfig,
            // The `error` marker belonged to the connection being removed; a
            // row without a connection is simply "not connected". Everything
            // else is PARSED, not cast: a value the enum does not know must not
            // be written back by an update that only meant to drop a key.
            status: this.nextStatusAfterDisconnect(txScope.tenantId, row.status),
            updatedAt: new Date(),
          })
          .where(
            txScope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)),
          );

        await txScope.db.insert(auditLogs).values(
          txScope.row({
            actorUserId: input?.actorUserId ?? null,
            action: "google_oauth.disconnected",
            entityType: "tenant_integration",
            entityId: GOOGLE_PROVIDER,
            payload: {
              old: previous ? { email: previous.email, connected_at: previous.connectedAt } : null,
              new: null,
              actor_email: input?.actorEmail ?? null,
            },
          }),
        );

        return { removed: true };
      });
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "oauth",
        operation: "googleOAuth.delete",
        provider: GOOGLE_PROVIDER,
      });
    }
  }

  async markConnectionExpired(tenantId: string, reason: string): Promise<void> {
    const scope = forTenant(this.db, tenantId);
    const row = await this.readRow(scope);
    // Nothing to park. Writing `status='error'` on a row whose oauth blob is
    // already gone would flag a tenant that is simply NOT CONNECTED (the screen
    // would say "kết nối lại" to somebody who never has to), and it would put a
    // Service Account tenant into `error` for a failure that is not theirs.
    if (!row || !this.parseOAuth(scope.tenantId, row.config)) {
      this.deps.logger.debug("Skipped parking the Google integration — no connection on the row", {
        tenant_id: scope.tenantId,
        provider: GOOGLE_PROVIDER,
        reason,
        skipped: "NO_OAUTH_BLOB",
      });
      return;
    }

    try {
      await scope.db
        .update(tenantIntegrations)
        .set({ status: "error" as const, updatedAt: new Date() })
        .where(scope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)));
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "status",
        operation: "googleOAuth.markExpired",
        provider: GOOGLE_PROVIDER,
        reason,
      });
    }

    this.deps.logger.warn("Google integration parked in `error` — the tenant must reconnect", {
      tenant_id: scope.tenantId,
      provider: GOOGLE_PROVIDER,
      error_code: "GOOGLE_AUTH_EXPIRED",
      reason,
    });
  }

  /**
   * Writes `config.oauth.sourceAccess`, keeping every other key of the blob.
   *
   * Locked like every other writer of this row (a connect and a source save can
   * land at the same second), and a NO-OP when the tenant has no connection: the
   * key describes a connected account, and a Service Account tenant must not get
   * a warning about an account they never linked.
   */
  async saveSourceAccess(input: SaveGoogleSourceAccessInput): Promise<void> {
    const scope = forTenant(this.db, input?.tenantId ?? "");
    const parsed = SourceAccessSchema.safeParse({
      state: input?.state,
      checkedAt: input?.checkedAt,
    });
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "saveSourceAccess requires a known state and a timestamp",
        userMessage: "Không ghi nhận được kết quả kiểm tra quyền truy cập nguồn.",
        context: {
          tenant_id: scope.tenantId,
          provider: GOOGLE_PROVIDER,
          issues: parsed.error.issues.map((issue) => issue.path.join(".")),
        },
      });
    }

    try {
      await scope.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        await lockIntegrationRow(txScope, GOOGLE_PROVIDER);

        const existing = await txScope.db
          .select({ config: tenantIntegrations.config })
          .from(tenantIntegrations)
          .where(txScope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)))
          .limit(1)
          .for("update");

        const currentConfig = existing[0]?.config ?? {};
        const stored = this.parseOAuth(txScope.tenantId, currentConfig);
        if (!stored) {
          this.deps.logger.debug("No Google connection to attach a source-access result to", {
            tenant_id: txScope.tenantId,
            provider: GOOGLE_PROVIDER,
            source_access: parsed.data.state,
            skipped: "NO_OAUTH_BLOB",
          });
          return;
        }

        const currentOAuth = (currentConfig as Record<string, unknown>)[OAUTH_KEY];
        const nextConfig = {
          ...currentConfig,
          [OAUTH_KEY]: {
            ...(typeof currentOAuth === "object" && currentOAuth !== null ? currentOAuth : {}),
            sourceAccess: { state: parsed.data.state, checkedAt: parsed.data.checkedAt },
          },
        };

        await txScope.db
          .update(tenantIntegrations)
          .set({ config: nextConfig, updatedAt: new Date() })
          .where(
            txScope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)),
          );
      });
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "oauth.sourceAccess",
        operation: "googleOAuth.saveSourceAccess",
        provider: GOOGLE_PROVIDER,
      });
    }

    this.deps.logger.info("Recorded whether the connected Google account can read the source", {
      tenant_id: scope.tenantId,
      provider: GOOGLE_PROVIDER,
      source_access: parsed.data.state,
      checked_at: parsed.data.checkedAt,
    });
  }

  // --- internals ------------------------------------------------------------

  /** `error` belonged to the connection being removed; anything unknown to the
   * enum falls back to `active` with a warning, because the alternative is
   * writing a value the column cannot hold. */
  private nextStatusAfterDisconnect(
    tenantId: string,
    raw: string,
  ): "active" | "disabled" {
    const parsed = IntegrationStatusSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.logger.warn("tenant_integration.status holds a value the schema does not know", {
        tenant_id: tenantId,
        provider: GOOGLE_PROVIDER,
        reason: "STATUS_UNKNOWN",
      });
      return "active";
    }
    return parsed.data === "disabled" ? "disabled" : "active";
  }

  private async readRow(
    scope: TenantScopedDb<DbExecutor>,
  ): Promise<{ config: Record<string, unknown>; status: string } | null> {
    try {
      const rows = await scope.db
        .select({ config: tenantIntegrations.config, status: tenantIntegrations.status })
        .from(tenantIntegrations)
        .where(scope.where(tenantIntegrations, eq(tenantIntegrations.provider, GOOGLE_PROVIDER)))
        .limit(1);
      return rows[0] ?? null;
    } catch (error) {
      // A driver failure is NOT "not connected": answering null here would send
      // the whole tenant back to the Service Account without anybody noticing.
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "tenantId",
        operation: "googleOAuth.read",
        provider: GOOGLE_PROVIDER,
      });
    }
  }

  /**
   * Null = no usable connection. A blob that exists but does not validate is
   * logged as such (names only) — it means someone hand-edited the row, and the
   * screen showing "chưa kết nối" is the honest answer to an unusable one.
   */
  private parseOAuth(
    tenantId: string,
    config: unknown,
  ): z.infer<typeof StoredOAuthSchema> | null {
    if (typeof config !== "object" || config === null) return null;
    const raw = (config as Record<string, unknown>)[OAUTH_KEY];
    if (raw === undefined || raw === null) return null;

    const parsed = StoredOAuthSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.logger.warn("tenant_integration.config.oauth is unusable — treated as unconnected", {
        tenant_id: tenantId,
        provider: GOOGLE_PROVIDER,
        reason: "OAUTH_BLOB_INVALID",
        issues: parsed.error.issues.map((issue) => issue.path.join(".")),
      });
      return null;
    }

    if (!isSealedSecret(parsed.data.refreshToken)) {
      // Readable, but it must not stay invisible (same contract as secret-box).
      this.deps.logger.warn("Google refresh token is stored WITHOUT encryption", {
        tenant_id: tenantId,
        provider: GOOGLE_PROVIDER,
        reason: "PLAINTEXT_LEGACY",
        field: "oauth.refreshToken",
      });
    }
    return parsed.data;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
