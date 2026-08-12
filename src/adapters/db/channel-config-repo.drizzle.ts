import { eq } from "drizzle-orm";
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

const ChannelSchema = z.object({
  channelId: z.string().trim().min(1),
  platform: z.enum(["facebook", "tiktok"]).default("facebook"),
  name: z.string().trim().min(1),
  /** Facebook Page id. */
  externalId: z.string().trim().min(1),
  accessToken: z.string().trim().min(1),
  status: z.enum(["active", "disabled"]).default("active"),
  /** ISO-8601; absent when the platform gave no expiry (system user tokens). */
  tokenExpiresAt: z.iso.datetime({ offset: true }).nullish(),
});

const MetaConfigSchema = z.object({
  /** PENDING(E1): spacing between posts of the SAME channel. Brief §6: 1–3'. */
  spacingMs: z.coerce.number().int().min(0).max(24 * 60 * 60_000).default(DEFAULT_PUBLISH_SETTINGS.spacingMs),
  retryBackoffMs: z.coerce.number().int().min(0).max(60 * 60_000).default(DEFAULT_PUBLISH_SETTINGS.retryBackoffMs),
  maxAttempts: z.coerce.number().int().min(1).max(5).default(DEFAULT_PUBLISH_SETTINGS.maxAttempts),
  channels: z.array(ChannelSchema).default([]),
});

type MetaConfig = z.infer<typeof MetaConfigSchema>;

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

  async listChannels(tenantId: string): Promise<readonly ChannelConfig[]> {
    const row = await this.readRow(tenantId);
    if (!row) return [];
    const config = this.parse(tenantId, row.config);
    // A disabled integration disables every channel under it, and says so
    // (the usecase's message must not claim the channel is missing).
    const integrationActive = row.status === "active";
    return config.channels.map((channel) => ({
      channelId: channel.channelId,
      platform: channel.platform,
      name: channel.name,
      externalId: channel.externalId,
      accessToken: channel.accessToken,
      status: integrationActive ? channel.status : ("disabled" as const),
      tokenExpiresAt: channel.tokenExpiresAt ? new Date(channel.tokenExpiresAt) : null,
    }));
  }

  async getPublishSettings(tenantId: string): Promise<PublishSettings> {
    const row = await this.readRow(tenantId);
    if (!row) return DEFAULT_PUBLISH_SETTINGS;
    const config = this.parse(tenantId, row.config);
    return {
      spacingMs: config.spacingMs,
      retryBackoffMs: config.retryBackoffMs,
      maxAttempts: config.maxAttempts,
    };
  }

  private async readRow(
    tenantId: string,
  ): Promise<{ config: Record<string, unknown>; status: string } | null> {
    const scope = forTenant(this.db, tenantId);
    try {
      const rows = await scope.db
        .select({ config: tenantIntegrations.config, status: tenantIntegrations.status })
        .from(tenantIntegrations)
        .where(scope.where(tenantIntegrations, eq(tenantIntegrations.provider, META_PROVIDER)))
        .limit(1);
      return rows[0] ?? null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "channelConfig.read",
        tenant_id: scope.tenantId,
        provider: META_PROVIDER,
        field: "tenantId",
      });
    }
  }

  /**
   * Opens the sealed fields, then validates. Order matters: the schema demands a
   * non-empty accessToken, and an envelope only becomes a token after opening.
   */
  private parse(tenantId: string, raw: unknown): MetaConfig {
    const plaintextSecrets = findPlaintextSecretFields(raw);
    if (plaintextSecrets.length > 0) {
      // Field NAMES only — a warning that leaks the token defeats its purpose.
      this.deps.logger.warn("tenant_integration.config (meta) holds unencrypted secrets", {
        scope: "secrets",
        reason: "PLAINTEXT_LEGACY",
        tenant_id: tenantId,
        provider: META_PROVIDER,
        fields: plaintextSecrets,
      });
    }

    let opened: unknown;
    try {
      opened = openConfigSecrets(raw ?? {}, this.deps.box, {
        tenantId,
        provider: META_PROVIDER,
      });
    } catch (error) {
      // Wrong key or tampered ciphertext. Publishing with a half-read config is
      // how a post lands on the wrong Page — refuse instead.
      throw new AppError("CHANNEL_NOT_CONFIGURED", {
        message: "Could not decrypt the credentials in tenant_integration.config (meta)",
        userMessage:
          "Không giải mã được token của kênh Facebook — kiểm tra khoá mã hoá của hệ thống.",
        context: { tenant_id: tenantId, provider: META_PROVIDER, reason: "SECRET_UNREADABLE" },
        cause: error,
      });
    }

    const parsed = MetaConfigSchema.safeParse(opened);
    if (parsed.success) return parsed.data;

    // Never fall back to defaults for channels: publishing with a half-read
    // configuration is how a post lands on the wrong Page.
    throw new AppError("CHANNEL_NOT_CONFIGURED", {
      message: "tenant_integration.config (meta) failed schema validation",
      userMessage:
        "Cấu hình kênh Facebook của đơn vị không hợp lệ — kiểm tra lại phần quản lý kênh.",
      context: {
        tenant_id: tenantId,
        provider: META_PROVIDER,
        // Paths only: a value could be a token.
        issues: parsed.error.issues.map((issue) => issue.path.join(".")),
      },
    });
  }
}
