/**
 * generate-captions — one caption per channel for one product (brief §7.2).
 *
 * Position in the invariant order (CLAUDE.md business rule 1): this runs AFTER
 * the inventory gate. It never reads the sheet and never touches stock; the
 * caller hands over already-whitelisted product facts.
 *
 * Channels are generated sequentially on purpose: each accepted caption becomes
 * an input to the next one so the D1 cross-channel duplication check has
 * something to compare against.
 */

import { buildCaptionText, captionInputSchema, type CaptionResult } from "@/core/domain/caption";
import { AppError, isErrorCode, type ErrorCode } from "@/core/domain/errors";
import type { AITask } from "@/core/ports/ai";
import type {
  ContentConstraints,
  ContentEngine,
  ContentGenerationRequest,
  ContentPlatform,
  ContentType,
  VisionInput,
} from "@/core/ports/content-engine";
import type { Logger } from "@/core/ports/infra";
import { HASHTAG_MAX, HASHTAG_MIN } from "@/core/domain/caption";
import { DEFAULT_CAPTION_TONE, isCaptionTone, type CaptionTone } from "@/shared/caption-tone";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

export interface CaptionChannelRequest {
  channelId: string;
  platform: ContentPlatform;
  contentType: ContentType;
  /** Defaults to the platform's generation task when omitted. */
  task?: AITask;
}

export interface GenerateCaptionsInput {
  tenantId: TenantId;
  /** Whitelisted product facts — validated here, at the usecase boundary. */
  product: unknown;
  channels: readonly CaptionChannelRequest[];
  vision: VisionInput;
  constraints?: Partial<ContentConstraints>;
  /**
   * Tone key from the compose form. Validated here even though the route parses
   * it too: a worker payload is an equally untrusted boundary, and an unknown
   * key must fail loudly instead of quietly generating the default tone.
   */
  tone?: unknown;
  brandVoice?: string;
  requestId?: string;
  postJobId?: string;
  /** Log-only context written to `ai_generation`; never enters a prompt. */
  batchId?: string;
  productCode?: string;
}

export interface GeneratedChannelCaption {
  channelId: string;
  platform: ContentPlatform;
  caption: CaptionResult;
  generationId: string;
  provider: string;
  model: string;
  tier: string;
  attempts: number;
  escalations: number;
  fallbackUsed: boolean;
  costUsd: number;
  latencyMs: number;
  promptTemplateId: string;
  promptVersion: number;
}

export interface FailedChannelCaption {
  channelId: string;
  platform: ContentPlatform;
  code: string;
  /** Vietnamese reason shown to the operator — always populated. */
  reason: string;
  failures: unknown;
}

export interface GenerateCaptionsResult {
  generated: GeneratedChannelCaption[];
  failed: FailedChannelCaption[];
  totalCostUsd: number;
}

export interface GenerateCaptionsDeps {
  contentEngine: ContentEngine;
  logger: Logger;
}

const DEFAULT_TASK_BY_PLATFORM: Partial<Record<ContentPlatform, AITask>> = {
  facebook: "facebook_content",
};

export function makeGenerateCaptions(deps: GenerateCaptionsDeps) {
  return async function generateCaptions(
    input: GenerateCaptionsInput,
  ): Promise<GenerateCaptionsResult> {
    // --- Edge cases first (CLAUDE.md rule 1) -------------------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    if (!rawTenantId) {
      throw new AppError("INVALID_INPUT", {
        message: "generateCaptions requires a tenantId",
        userMessage: "Thiếu mã đơn vị (tenant) khi yêu cầu viết caption.",
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);

    const log = deps.logger.child({
      tenant_id: tenantId,
      job_id: input.postJobId,
      batch_id: input.batchId,
      product_code: input.productCode,
    });

    const channels: readonly CaptionChannelRequest[] = Array.isArray(input.channels)
      ? input.channels
      : [];
    if (channels.length === 0) {
      log.warn("Caption generation rejected: no channel requested", {
        error_code: "INVALID_INPUT",
      });
      throw new AppError("INVALID_INPUT", {
        message: "generateCaptions requires at least one channel",
        userMessage: "Chưa chọn kênh nào để viết caption.",
        context: { tenant_id: tenantId },
      });
    }

    const parsedProduct = captionInputSchema.safeParse(input.product);
    if (!parsedProduct.success) {
      log.warn("Caption generation rejected: product data failed the whitelist schema", {
        error_code: "INVALID_INPUT",
        issues: parsedProduct.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      });
      throw new AppError("INVALID_INPUT", {
        message: "Product data failed caption whitelist schema",
        userMessage: "Dữ liệu sản phẩm thiếu tên/mô tả/chủng loại/mùa vụ — không thể viết caption.",
        context: { tenant_id: tenantId },
      });
    }
    const product = parsedProduct.data;

    const duplicateChannel = findDuplicateChannelId(channels);
    if (duplicateChannel) {
      log.warn("Caption generation rejected: duplicated channel id", {
        error_code: "INVALID_INPUT",
        channel: duplicateChannel,
      });
      throw new AppError("INVALID_INPUT", {
        message: `Channel "${duplicateChannel}" requested twice`,
        userMessage: "Một kênh bị chọn trùng hai lần.",
        context: { tenant_id: tenantId, channel: duplicateChannel },
      });
    }

    // A tone key that is not in the closed list is a caller bug: refuse it
    // instead of silently writing in the default voice (CLAUDE.md rule 2).
    if (input.tone !== undefined && !isCaptionTone(input.tone)) {
      log.warn("Caption generation rejected: unknown tone key", {
        error_code: "INVALID_INPUT",
        tone: String(input.tone),
      });
      throw new AppError("INVALID_INPUT", {
        message: `Unknown caption tone: ${String(input.tone)}`,
        userMessage: "Tông giọng không hợp lệ.",
        context: { tenant_id: tenantId, tone: String(input.tone) },
      });
    }
    const tone: CaptionTone = isCaptionTone(input.tone) ? input.tone : DEFAULT_CAPTION_TONE;

    const constraints: ContentConstraints = {
      hashtagMin: input.constraints?.hashtagMin ?? HASHTAG_MIN,
      hashtagMax: input.constraints?.hashtagMax ?? HASHTAG_MAX,
      maxBodyChars: input.constraints?.maxBodyChars,
      forbiddenWords: input.constraints?.forbiddenWords,
    };

    // --- Happy path --------------------------------------------------------
    const generated: GeneratedChannelCaption[] = [];
    const failed: FailedChannelCaption[] = [];
    const acceptedCaptions: string[] = [];
    let totalCostUsd = 0;

    for (const channel of channels) {
      const task = channel.task ?? DEFAULT_TASK_BY_PLATFORM[channel.platform];
      const channelLog = log.child({ channel: channel.channelId });

      if (!task) {
        channelLog.error("No AI task configured for platform", {
          error_code: "MODEL_NOT_CONFIGURED",
          platform: channel.platform,
        });
        failed.push({
          channelId: channel.channelId,
          platform: channel.platform,
          code: "MODEL_NOT_CONFIGURED",
          reason: `Chưa cấu hình tác vụ AI cho nền tảng ${channel.platform}.`,
          failures: null,
        });
        continue;
      }

      const request: ContentGenerationRequest = {
        tenantId,
        task,
        product,
        platform: channel.platform,
        contentType: channel.contentType,
        vision: input.vision,
        language: "vi",
        constraints,
        tone,
        brandVoice: input.brandVoice,
        existingCaptions: [...acceptedCaptions],
        requestId: input.requestId,
        postJobId: input.postJobId,
        channelId: channel.channelId,
        batchId: input.batchId,
        productCode: input.productCode,
      };

      try {
        const result = await deps.contentEngine.generate(request);
        const caption: CaptionResult = {
          text: buildCaptionText(product.name, result.content),
          content: result.content,
        };

        acceptedCaptions.push(caption.text);
        totalCostUsd = Number((totalCostUsd + result.metadata.totalCostUsd).toFixed(6));
        generated.push({
          channelId: channel.channelId,
          platform: channel.platform,
          caption,
          generationId: result.generationId,
          provider: result.metadata.provider,
          model: result.metadata.model,
          tier: result.metadata.tier,
          attempts: result.metadata.attempts,
          escalations: result.metadata.escalations,
          fallbackUsed: result.metadata.fallbackUsed,
          costUsd: result.metadata.totalCostUsd,
          latencyMs: result.metadata.totalLatencyMs,
          promptTemplateId: result.metadata.promptTemplateId,
          promptVersion: result.metadata.promptVersion,
        });

        channelLog.info("Caption generated", {
          generation_id: result.generationId,
          tone,
          provider: result.metadata.provider,
          model: result.metadata.model,
          tier: result.metadata.tier,
          attempts: result.metadata.attempts,
          cost_usd: result.metadata.totalCostUsd,
        });
      } catch (error) {
        // One channel failing must not stop the others (business rule 6), but it
        // is never swallowed: logged with its code and returned in `failed`.
        const appError = AppError.from(error, "AI_PROVIDER_ERROR", {
          tenant_id: tenantId,
          channel: channel.channelId,
          platform: channel.platform,
          task,
        });
        channelLog.error("Caption generation failed for channel", {
          error_code: appError.code,
          err: appError,
        });
        failed.push({
          channelId: channel.channelId,
          platform: channel.platform,
          code: appError.code,
          reason: appError.userMessage,
          failures: appError.context.failures ?? null,
        });
      }
    }

    if (generated.length === 0) {
      const codes = [...new Set(failed.map((item) => item.code))];
      const everyFailureIsValidation = codes.every(
        (code) => code === "CAPTION_VALIDATION_FAILED" || code === "AI_RESPONSE_INVALID",
      );
      // Keep the real reason (rate limit vs validation) instead of flattening it.
      const aggregateCode: ErrorCode = everyFailureIsValidation
        ? "CAPTION_VALIDATION_FAILED"
        : isErrorCode(codes[0])
          ? codes[0]
          : "AI_PROVIDER_ERROR";
      log.error("No channel produced a usable caption", { error_code: aggregateCode, codes });
      throw new AppError(aggregateCode, {
        message: "No channel produced a usable caption",
        context: {
          tenant_id: tenantId,
          post_job_id: input.postJobId,
          channels: failed.map((item) => ({
            channel: item.channelId,
            code: item.code,
            reason: item.reason,
            failures: item.failures,
          })),
        },
      });
    }

    return { generated, failed, totalCostUsd };
  };
}

function findDuplicateChannelId(channels: readonly CaptionChannelRequest[]): string | null {
  const seen = new Set<string>();
  for (const channel of channels) {
    if (seen.has(channel.channelId)) return channel.channelId;
    seen.add(channel.channelId);
  }
  return null;
}

export type GenerateCaptions = ReturnType<typeof makeGenerateCaptions>;
