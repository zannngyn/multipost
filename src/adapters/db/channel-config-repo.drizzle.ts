import { inArray } from "drizzle-orm";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import {
  DEFAULT_PUBLISH_SETTINGS,
  type ChannelConfig,
  type ChannelConfigRepo,
  type PublishSettings,
} from "@/core/ports/publisher";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { tenantIntegrations } from "./schema";
import {
  findPlaintextSecretFields,
  openConfigSecrets,
  sealConfigSecrets,
  type SecretBox,
} from "./secret-box";
import { forTenant } from "./tenant-scope";

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
  spacingMs: z.coerce.number().int().min(0).max(24 * 60 * 60_000).default(DEFAULT_PUBLISH_SETTINGS.spacingMs),
  retryBackoffMs: z.coerce.number().int().min(0).max(60 * 60_000).default(DEFAULT_PUBLISH_SETTINGS.retryBackoffMs),
  maxAttempts: z.coerce.number().int().min(1).max(5).default(DEFAULT_PUBLISH_SETTINGS.maxAttempts),
  channels: z.array(ChannelSchema).default([]),
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

  async findChannel(tenantId: string, channelId: string): Promise<ChannelConfig | null> {
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
  async listChannels(tenantId: string): Promise<readonly ChannelConfig[]> {
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
  async getPublishSettings(tenantId: string): Promise<PublishSettings> {
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

  private async readRows(
    tenantId: string,
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
  private parse(tenantId: string, provider: string, raw: unknown): ChannelProviderConfig {
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
