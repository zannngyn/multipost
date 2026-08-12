import { eq } from "drizzle-orm";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import {
  DEFAULT_PUBLISH_SETTINGS,
  type ChannelConfig,
  type ChannelConfigRepo,
  type PublishSettings,
} from "@/core/ports/publisher";

import type { Database } from "./client";
import { tenantIntegrations } from "./schema";
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
 * SECURITY NOTE — carried to the orchestrator: `accessToken` sits in this JSONB
 * because there is no secret store yet, which contradicts the comment on
 * schema/tenant-integration.ts ("do NOT put raw tokens here"). It is never
 * logged or returned by this repo beyond the ChannelConfig the publisher needs.
 * E5.1 (token refresh) must move it to an encrypted column/vault.
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

export class DrizzleChannelConfigRepo implements ChannelConfigRepo {
  constructor(private readonly db: Database) {}

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
      throw AppError.from(error, "DB_ERROR", {
        tenant_id: scope.tenantId,
        provider: META_PROVIDER,
        operation: "channelConfig.read",
      });
    }
  }

  private parse(tenantId: string, raw: unknown): MetaConfig {
    const parsed = MetaConfigSchema.safeParse(raw ?? {});
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
