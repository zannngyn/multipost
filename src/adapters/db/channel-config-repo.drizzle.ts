import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { MAX_SPACING_MS, MIN_SPACING_MS } from "@/core/domain/publish-spacing";
import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import {
  DEFAULT_PUBLISH_SETTINGS,
  type ChannelConfig,
  type ChannelConfigRepo,
  type ChannelUpsert,
  type PublishSettings,
  type RemoveChannelInput,
  type SetChannelStatusInput,
  type UpsertChannelsInput,
  type UpsertChannelsResult,
} from "@/core/ports/publisher";

import type { Database, DbExecutor } from "./client";
import { wrapDbError } from "./db-errors";
import { lockIntegrationRow } from "./integration-lock";
import { auditLogs, tenantIntegrations } from "./schema";
import {
  findPlaintextSecretFields,
  openConfigSecrets,
  sealConfigSecrets,
  type SecretBox,
} from "./secret-box";
import { forTenant, type TenantScopedDb } from "./tenant-scope";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Reads the tenant's publishing channels from `tenant_integration`
 * (business rule 7: page ids, tokens and spacing are per tenant, never in env,
 * never hardcoded). Same shape as catalog-config-repo, provider = 'meta'.
 *
 * The JSONB blob is hand-edited data — it goes through a schema before it is
 * trusted (technical rule 2), and a malformed row raises
 * CHANNEL_NOT_CONFIGURED instead of publishing with half a configuration.
 *
 * SECRETS: `accessToken` lives inside this JSONB, but SEALED — every read runs
 * `openConfigSecrets` (adapters/db/secret-box), so what sits in the database is
 * `enc:v1:<iv>:<tag>:<ciphertext>` and what the publisher receives is the token.
 * Rows written before the box (plaintext) still open, with a warning naming the
 * FIELD PATHS only — that is how the remaining ones stay visible instead of
 * silently permanent. The opened token is never logged and never enters an
 * AppError context (see redactToken in core/ports/publisher).
 */

export const META_PROVIDER = "meta";
export const TIKTOK_PROVIDER = "tiktok";
/** Providers that carry publishing channels, in priority order for settings. */
export const CHANNEL_PROVIDERS = [META_PROVIDER, TIKTOK_PROVIDER] as const;

/**
 * TikTok-only block (E6). `privacyLevel` must be one of the values TikTok
 * reports for that creator; `isAigc` defaults to TRUE because every caption in
 * this product is written by an LLM and TikTok requires the disclosure.
 */
const TikTokOptionsSchema = z.object({
  privacyLevel: z
    .enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"])
    .default("SELF_ONLY"),
  isAigc: z.coerce.boolean().default(true),
  openId: z.string().trim().min(1).nullish(),
  disableDuet: z.coerce.boolean().optional(),
  disableStitch: z.coerce.boolean().optional(),
  disableComment: z.coerce.boolean().optional(),
});

const ChannelSchema = z.object({
  channelId: z.string().trim().min(1),
  platform: z.enum(["facebook", "tiktok"]).default("facebook"),
  name: z.string().trim().min(1),
  /** Facebook Page id, or the TikTok creator open id. */
  externalId: z.string().trim().min(1),
  accessToken: z.string().trim().min(1),
  /** TikTok hands one out; sealed by name like every other credential. */
  refreshToken: z.string().trim().min(1).nullish(),
  status: z.enum(["active", "disabled"]).default("active"),
  /** ISO-8601; absent when the platform gave no expiry (system user tokens). */
  tokenExpiresAt: z.iso.datetime({ offset: true }).nullish(),
  tiktok: TikTokOptionsSchema.optional(),
});

const ChannelProviderConfigSchema = z.object({
  /** PENDING(E1): spacing between posts of the SAME channel. Brief §6: 1–3'. */
  spacingMs: z.coerce
    .number()
    .int()
    .min(MIN_SPACING_MS)
    // Same ceiling as the per-run gap on post_batch, from the same constant: a
    // tenant and a run that disagreed on the bound would be a silent trap.
    .max(MAX_SPACING_MS)
    .default(DEFAULT_PUBLISH_SETTINGS.spacingMs),
  retryBackoffMs: z.coerce.number().int().min(0).max(60 * 60_000).default(DEFAULT_PUBLISH_SETTINGS.retryBackoffMs),
  maxAttempts: z.coerce.number().int().min(1).max(5).default(DEFAULT_PUBLISH_SETTINGS.maxAttempts),
  channels: z.array(ChannelSchema).default([]),
  /**
   * E5.1 — the Facebook USER token that listed these Pages, kept so "làm mới
   * danh sách" needs no second paste. Sealed like every other credential (the
   * secret box keys off the field NAME), and it never leaves the server.
   */
  userAccessToken: z.string().trim().min(1).nullish(),
});

type ChannelProviderConfig = z.infer<typeof ChannelProviderConfigSchema>;

/**
 * Seals the credentials of a meta config blob before it is written. There is no
 * write path in this repo yet (E5.1 owns "connect a channel"), but seeding and
 * scripts must not invent their own envelope: one seal helper, one contract.
 */
export function sealMetaConfig<T>(config: T, box: SecretBox): T {
  return sealConfigSecrets(config, box);
}


export interface ChannelConfigRepoDeps {
  /** Same box (same key + envelope) as every other repo touching this blob. */
  box: SecretBox;
  logger: Logger;
}

export class DrizzleChannelConfigRepo implements ChannelConfigRepo {
  constructor(
    private readonly db: Database,
    private readonly deps: ChannelConfigRepoDeps,
  ) {}

  async findChannel(tenantId: TenantId, channelId: string): Promise<ChannelConfig | null> {
    const wanted = typeof channelId === "string" ? channelId.trim() : "";
    if (wanted.length === 0) return null;
    const channels = await this.listChannels(tenantId);
    return channels.find((channel) => channel.channelId === wanted) ?? null;
  }

  /**
   * Every publishing channel of the tenant, ACROSS providers (E6): the meta row
   * carries Facebook Pages, the tiktok row carries TikTok accounts, and the
   * caller only ever sees one flat list keyed by channelId. A duplicate
   * channelId across providers is refused rather than silently shadowed.
   */
  async listChannels(tenantId: TenantId): Promise<readonly ChannelConfig[]> {
    const rows = await this.readRows(tenantId);
    const result: ChannelConfig[] = [];
    const seen = new Map<string, string>();

    for (const row of rows) {
      const config = this.parse(tenantId, row.provider, row.config);
      // A disabled integration disables every channel under it, and says so
      // (the usecase's message must not claim the channel is missing).
      const integrationActive = row.status === "active";
      for (const channel of config.channels) {
        const previous = seen.get(channel.channelId);
        if (previous) {
          throw new AppError("CHANNEL_NOT_CONFIGURED", {
            message: `Channel id ${channel.channelId} is declared by two providers`,
            userMessage: `Mã kênh "${channel.channelId}" bị khai báo trùng ở hai nơi — sửa lại cấu hình kênh.`,
            context: {
              tenant_id: tenantId,
              channel: channel.channelId,
              providers: [previous, row.provider],
              reason: "DUPLICATE_CHANNEL_ID",
            },
          });
        }
        seen.set(channel.channelId, row.provider);
        result.push({
          channelId: channel.channelId,
          // The provider row is the source of truth for the platform: a tiktok
          // row holding platform:"facebook" is a config mistake, not a Page.
          platform: row.provider === TIKTOK_PROVIDER ? "tiktok" : channel.platform,
          name: channel.name,
          externalId: channel.externalId,
          accessToken: channel.accessToken,
          status: integrationActive ? channel.status : ("disabled" as const),
          tokenExpiresAt: channel.tokenExpiresAt ? new Date(channel.tokenExpiresAt) : null,
          ...(channel.tiktok
            ? {
                tiktok: {
                  privacyLevel: channel.tiktok.privacyLevel,
                  isAigc: channel.tiktok.isAigc,
                  openId: channel.tiktok.openId ?? channel.externalId,
                  ...(channel.tiktok.disableDuet === undefined
                    ? {}
                    : { disableDuet: channel.tiktok.disableDuet }),
                  ...(channel.tiktok.disableStitch === undefined
                    ? {}
                    : { disableStitch: channel.tiktok.disableStitch }),
                  ...(channel.tiktok.disableComment === undefined
                    ? {}
                    : { disableComment: channel.tiktok.disableComment }),
                },
              }
            : {}),
        });
      }
    }
    return result;
  }

  /**
   * Spacing/retry are per TENANT, not per platform. The meta row wins when both
   * exist so an existing deployment keeps its tuned values; a TikTok-only tenant
   * reads them from its own row.
   */
  async getPublishSettings(tenantId: TenantId): Promise<PublishSettings> {
    const rows = await this.readRows(tenantId);
    if (rows.length === 0) return DEFAULT_PUBLISH_SETTINGS;
    const preferred =
      rows.find((row) => row.provider === META_PROVIDER) ?? rows[0];
    const config = this.parse(tenantId, preferred.provider, preferred.config);
    return {
      spacingMs: config.spacingMs,
      retryBackoffMs: config.retryBackoffMs,
      maxAttempts: config.maxAttempts,
    };
  }

  /**
   * The stored USER token (E5.1). Opened like any other credential, returned to
   * the connect usecase only — it must never reach a log or a response.
   */
  async findUserAccessToken(tenantId: TenantId): Promise<string | null> {
    const rows = await this.readRows(tenantId);
    const meta = rows.find((row) => row.provider === META_PROVIDER);
    if (!meta) return null;
    const config = this.parse(tenantId, META_PROVIDER, meta.config);
    return config.userAccessToken ?? null;
  }

  /**
   * Writes what the connect flow found, in ONE transaction with its audit row.
   *
   * Concurrency: `readForUpdate` takes a per-(tenant, provider) advisory lock
   * FIRST, so two operators connecting at the same moment queue instead of both
   * merging into the same empty snapshot — including on the very first import,
   * when there is no row for `FOR UPDATE` to lock. Channels the platform did not
   * list are kept untouched: a partial listing is not a delete.
   *
   * A channel that already exists keeps its `status`: re-importing must not
   * silently switch a Page an operator turned off back on. A NEW channel is
   * stored active, because channels are picked per post anyway.
   */
  async upsertChannels(input: UpsertChannelsInput): Promise<UpsertChannelsResult> {
    // --- Edge cases first ----------------------------------------------------
    const scope = forTenant(this.db, input.tenantId);
    const incoming = Array.isArray(input?.channels) ? input.channels : [];
    if (incoming.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "upsertChannels requires at least one channel",
        userMessage: "Không có kênh nào để lưu.",
        context: { tenant_id: scope.tenantId, field: "channels", reason: "EMPTY" },
      });
    }

    const seen = new Set<string>();
    const normalised = incoming.map((channel) => {
      const entry = normaliseUpsert(channel, scope.tenantId);
      if (seen.has(entry.channelId)) {
        throw new AppError("INVALID_INPUT", {
          message: `upsertChannels received channel ${entry.channelId} twice`,
          userMessage: `Danh sách kênh gửi lên bị trùng mã "${entry.channelId}".`,
          context: {
            tenant_id: scope.tenantId,
            channel: entry.channelId,
            reason: "DUPLICATE_CHANNEL_ID",
          },
        });
      }
      seen.add(entry.channelId);
      return entry;
    });

    const userAccessToken =
      typeof input?.userAccessToken === "string" ? input.userAccessToken.trim() : "";

    try {
      return await scope.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        const current = await this.readForUpdate(txScope);

        const added: string[] = [];
        const updated: string[] = [];
        const channels = [...current.config.channels];

        for (const entry of normalised) {
          const index = channels.findIndex((channel) => channel.channelId === entry.channelId);
          if (index < 0) {
            channels.push({
              ...entry,
              // New Page: usable immediately (channels are picked per post).
              status: "active",
            });
            added.push(entry.channelId);
            continue;
          }
          channels[index] = {
            ...channels[index],
            platform: entry.platform,
            name: entry.name,
            externalId: entry.externalId,
            accessToken: entry.accessToken,
            tokenExpiresAt: entry.tokenExpiresAt,
            // status deliberately preserved.
          };
          updated.push(entry.channelId);
        }

        const nextConfig = {
          ...current.config,
          channels,
          userAccessToken: userAccessToken.length > 0
            ? userAccessToken
            : (current.config.userAccessToken ?? null),
        };

        /**
         * ONLY a successful import clears an integration parked in `error`: we
         * have just proved the new credentials work. `disabled` is a deliberate
         * operator switch and stays. Every other write path (enable/disable one
         * channel, remove one) keeps the row status untouched — turning off an
         * unrelated Page must not erase a "token is dead" marker.
         */
        const nextStatus = current.status === "error" ? "active" : current.status;
        if (nextStatus !== current.status) {
          this.deps.logger.info("Meta integration re-activated by a successful import", {
            tenant_id: scope.tenantId,
            provider: META_PROVIDER,
            previous_status: current.status,
          });
        }

        await this.writeConfig(txScope, nextConfig, nextStatus);
        await txScope.db.insert(auditLogs).values(
          txScope.row({
            actorUserId: input?.actorUserId ?? null,
            action: "channel.imported",
            entityType: "tenant_integration",
            entityId: META_PROVIDER,
            // Ids and counts only — never a token, never a name of a credential.
            payload: { added, updated, actor_email: input?.actorEmail ?? null },
          }),
        );

        return { added, updated };
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "channelConfig.upsertChannels",
        tenant_id: scope.tenantId,
        provider: META_PROVIDER,
        field: "tenantId",
      });
    }
  }

  /** Null when the tenant has no such channel — the caller says "not found". */
  async setChannelStatus(input: SetChannelStatusInput): Promise<ChannelConfig | null> {
    const scope = forTenant(this.db, input.tenantId);
    const channelId = typeof input?.channelId === "string" ? input.channelId.trim() : "";
    const status = input?.status;
    if (channelId.length === 0 || (status !== "active" && status !== "disabled")) {
      throw new AppError("INVALID_INPUT", {
        message: "setChannelStatus requires a channel id and a valid status",
        userMessage: "Thiếu mã kênh hoặc trạng thái không hợp lệ.",
        context: { tenant_id: scope.tenantId, channel: channelId || null, status: status ?? null },
      });
    }

    let changed = false;
    try {
      changed = await scope.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        const current = await this.readForUpdate(txScope);
        const index = current.config.channels.findIndex(
          (channel) => channel.channelId === channelId,
        );
        if (index < 0) return false;

        const previous = current.config.channels[index].status;
        const channels = [...current.config.channels];
        channels[index] = { ...channels[index], status };

        await this.writeConfig(txScope, { ...current.config, channels }, current.status);
        await txScope.db.insert(auditLogs).values(
          txScope.row({
            actorUserId: input?.actorUserId ?? null,
            action: "channel.status_changed",
            entityType: "tenant_integration",
            entityId: META_PROVIDER,
            payload: {
              channel_id: channelId,
              old: previous,
              new: status,
              actor_email: input?.actorEmail ?? null,
            },
          }),
        );
        return true;
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "channelConfig.setChannelStatus",
        tenant_id: scope.tenantId,
        channel: channelId,
        provider: META_PROVIDER,
        field: "tenantId",
      });
    }

    if (!changed) return null;
    // Read back through the normal path so the caller gets exactly what the
    // publisher would get (opened token, integration status applied).
    return this.findChannel(scope.tenantId, channelId);
  }

  /**
   * Removes one channel from the provider row. Post jobs already created keep
   * their own copy of the channel id: this is "stop offering this Page", not a
   * retroactive delete.
   */
  async removeChannel(input: RemoveChannelInput): Promise<boolean> {
    const scope = forTenant(this.db, input.tenantId);
    const channelId = typeof input?.channelId === "string" ? input.channelId.trim() : "";
    if (channelId.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "removeChannel requires a channel id",
        userMessage: "Thiếu mã kênh.",
        context: { tenant_id: scope.tenantId, field: "channelId" },
      });
    }

    try {
      return await scope.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        const current = await this.readForUpdate(txScope);
        const channels = current.config.channels.filter(
          (channel) => channel.channelId !== channelId,
        );
        if (channels.length === current.config.channels.length) return false;

        await this.writeConfig(txScope, { ...current.config, channels }, current.status);
        await txScope.db.insert(auditLogs).values(
          txScope.row({
            actorUserId: input?.actorUserId ?? null,
            action: "channel.removed",
            entityType: "tenant_integration",
            entityId: META_PROVIDER,
            payload: { channel_id: channelId, actor_email: input?.actorEmail ?? null },
          }),
        );
        return true;
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "channelConfig.removeChannel",
        tenant_id: scope.tenantId,
        channel: channelId,
        provider: META_PROVIDER,
        field: "tenantId",
      });
    }
  }

  /**
   * Serialises writers, then returns the config OPENED — the same
   * interpretation the read path uses.
   *
   * WHY AN ADVISORY LOCK AND NOT ONLY `FOR UPDATE`: on the FIRST import the meta
   * row does not exist yet, and `SELECT ... FOR UPDATE` matching zero rows locks
   * NOTHING (see adapters/db/integration-lock for the full story). `FOR UPDATE`
   * stays as the row-level guard against any writer that skips the advisory one.
   *
   * Opening is not optional here: a sealed row only validates after it is
   * opened. Refusing to rewrite a blob we cannot read is deliberate — merging
   * into a half-read config is how a Page token gets dropped on the floor.
   * `writeConfig` seals everything again.
   */
  private async readForUpdate(
    txScope: TenantScopedDb<DbExecutor>,
  ): Promise<{ config: ChannelProviderConfig; status: string }> {
    await lockIntegrationRow(txScope, META_PROVIDER);

    const rows = await txScope.db
      .select({ config: tenantIntegrations.config, status: tenantIntegrations.status })
      .from(tenantIntegrations)
      .where(txScope.where(tenantIntegrations, eq(tenantIntegrations.provider, META_PROVIDER)))
      .limit(1)
      .for("update");

    const row = rows[0];
    if (!row) {
      // No row yet: schema defaults ARE DEFAULT_PUBLISH_SETTINGS.
      return { config: ChannelProviderConfigSchema.parse({}), status: "active" };
    }

    // The status is returned AS IT IS. Only a successful import may revive an
    // integration parked in `error` (see upsertChannels): switching one channel
    // off must not quietly clear a "token is dead" marker on the whole row.
    const config = this.parse(txScope.tenantId, META_PROVIDER, row.config ?? {});
    return { config, status: row.status };
  }

  /** Seals every credential, then upserts. The ONLY write of this blob. */
  private async writeConfig(
    txScope: TenantScopedDb<DbExecutor>,
    config: ChannelProviderConfig,
    status: string,
  ): Promise<void> {
    const sealed = sealMetaConfig(config, this.deps.box);
    await txScope.db
      .insert(tenantIntegrations)
      .values(
        txScope.row({
          provider: META_PROVIDER,
          config: sealed as unknown as Record<string, unknown>,
          status: status as "active" | "disabled" | "error",
        }),
      )
      .onConflictDoUpdate({
        target: [tenantIntegrations.tenantId, tenantIntegrations.provider],
        set: {
          config: sealed as unknown as Record<string, unknown>,
          status: status as "active" | "disabled" | "error",
          updatedAt: new Date(),
        },
      });
  }

  private async readRows(
    tenantId: TenantId,
  ): Promise<Array<{ provider: string; config: Record<string, unknown>; status: string }>> {
    const scope = forTenant(this.db, tenantId);
    try {
      const rows = await scope.db
        .select({
          provider: tenantIntegrations.provider,
          config: tenantIntegrations.config,
          status: tenantIntegrations.status,
        })
        .from(tenantIntegrations)
        .where(
          scope.where(
            tenantIntegrations,
            inArray(tenantIntegrations.provider, [...CHANNEL_PROVIDERS]),
          ),
        );
      // Stable order: meta first, so getPublishSettings is deterministic.
      return rows.sort((a, b) => a.provider.localeCompare(b.provider));
    } catch (error) {
      throw wrapDbError(error, {
        operation: "channelConfig.read",
        tenant_id: scope.tenantId,
        providers: [...CHANNEL_PROVIDERS],
        field: "tenantId",
      });
    }
  }

  /**
   * Opens the sealed fields, then validates. Order matters: the schema demands a
   * non-empty accessToken, and an envelope only becomes a token after opening.
   */
  private parse(tenantId: TenantId, provider: string, raw: unknown): ChannelProviderConfig {
    const plaintextSecrets = findPlaintextSecretFields(raw);
    if (plaintextSecrets.length > 0) {
      // Field NAMES only — a warning that leaks the token defeats its purpose.
      this.deps.logger.warn("tenant_integration.config holds unencrypted secrets", {
        scope: "secrets",
        reason: "PLAINTEXT_LEGACY",
        tenant_id: tenantId,
        provider,
        fields: plaintextSecrets,
      });
    }

    let opened: unknown;
    try {
      opened = openConfigSecrets(raw ?? {}, this.deps.box, { tenantId, provider });
    } catch (error) {
      // Wrong key or tampered ciphertext. Publishing with a half-read config is
      // how a post lands on the wrong Page — refuse instead.
      throw new AppError("CHANNEL_NOT_CONFIGURED", {
        message: `Could not decrypt the credentials in tenant_integration.config (${provider})`,
        userMessage: "Không giải mã được token của kênh — kiểm tra khoá mã hoá của hệ thống.",
        context: { tenant_id: tenantId, provider, reason: "SECRET_UNREADABLE" },
        cause: error,
      });
    }

    const parsed = ChannelProviderConfigSchema.safeParse(opened);
    if (parsed.success) return parsed.data;

    // Never fall back to defaults for channels: publishing with a half-read
    // configuration is how a post lands on the wrong Page.
    throw new AppError("CHANNEL_NOT_CONFIGURED", {
      message: `tenant_integration.config (${provider}) failed schema validation`,
      userMessage: "Cấu hình kênh của đơn vị không hợp lệ — kiểm tra lại phần quản lý kênh.",
      context: {
        tenant_id: tenantId,
        provider,
        // Paths only: a value could be a token.
        issues: parsed.error.issues.map((issue) => issue.path.join(".")),
      },
    });
  }
}

// --- helpers ----------------------------------------------------------------

type StoredChannel = z.infer<typeof ChannelSchema>;

/**
 * Validates one channel coming from the connect flow BEFORE it can touch the
 * blob, and converts it to the stored shape (dates as ISO strings). A missing
 * token here would be written as a channel that cannot publish, discovered only
 * at the first post.
 */
function normaliseUpsert(
  raw: ChannelUpsert,
  tenantId: TenantId,
): Omit<StoredChannel, "status" | "tokenExpiresAt"> & { tokenExpiresAt: string | null } {
  const channelId = str(raw?.channelId);
  const name = str(raw?.name);
  const externalId = str(raw?.externalId);
  const accessToken = typeof raw?.accessToken === "string" ? raw.accessToken.trim() : "";
  const platform = raw?.platform === "tiktok" ? "tiktok" : "facebook";

  const missing = [
    channelId.length === 0 ? "channelId" : null,
    name.length === 0 ? "name" : null,
    externalId.length === 0 ? "externalId" : null,
    accessToken.length === 0 ? "accessToken" : null,
  ].filter((field): field is string => field !== null);

  if (missing.length > 0) {
    throw new AppError("INVALID_INPUT", {
      message: `A channel to upsert is missing ${missing.join(", ")}`,
      userMessage: "Dữ liệu kênh nhận từ Facebook không đầy đủ — không lưu kênh này.",
      // Field NAMES only: one of them is a token.
      context: { tenant_id: tenantId, channel: channelId || null, missing },
    });
  }

  const expiresAt = raw?.tokenExpiresAt ?? null;
  const tokenExpiresAt =
    expiresAt instanceof Date && Number.isFinite(expiresAt.getTime())
      ? expiresAt.toISOString()
      : null;

  return { channelId, platform, name, externalId, accessToken, tokenExpiresAt };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
