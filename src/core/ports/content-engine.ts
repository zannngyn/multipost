/**
 * ContentEngine — the ONLY AI surface business usecases are allowed to touch
 * (ADR-001, docs/ai/architecture.md §2–3). Callers pass a `task`; they never
 * pass, see, or store a model string.
 */

import type { CaptionContent, CaptionInput, CaptionCoverImage } from "@/core/domain/caption";
import type { AIProviderName, AITask, AITier } from "@/core/ports/ai";

export type ContentPlatform = "facebook" | "tiktok" | "instagram" | "shopee" | "lazada" | "taobao";
export type ContentType = "photo_post" | "video_post" | "reel";

/** docs/ai/architecture.md §4 — MVP always sends exactly the cover image. */
export type VisionInput =
  | { mode: "none" }
  | { mode: "single"; image: CaptionCoverImage }
  | { mode: "multi"; images: CaptionCoverImage[] };

export interface ContentConstraints {
  hashtagMin: number;
  hashtagMax: number;
  /** Soft cap fed to the prompt; validation stage 2 enforces it. */
  maxBodyChars?: number;
  /** Tenant word blacklist, checked by validation stage 4. */
  forbiddenWords?: readonly string[];
}

export interface ContentGenerationRequest {
  /** Multi-tenant from day one — every log line and budget check needs it. */
  tenantId: string;
  task: AITask;
  /** Whitelisted product facts only — the type makes leaking impossible. */
  product: CaptionInput;
  platform: ContentPlatform;
  contentType: ContentType;
  vision: VisionInput;
  language: "vi";
  constraints: ContentConstraints;
  /** Optional voice override on top of the prompt template. */
  brandVoice?: string;
  /** Captions already accepted for OTHER channels of the same post (D1 check). */
  existingCaptions?: readonly string[];
  requestId?: string;
  postJobId?: string;
  channelId?: string;
  /** Log-only context (ai_generation): never rendered into a prompt. */
  batchId?: string;
  productCode?: string;
}

export interface ContentGenerationAttemptInfo {
  attemptNo: number;
  provider: AIProviderName;
  model: string;
  tier: AITier;
  fallbackUsed: boolean;
  escalationFrom: number | null;
  success: boolean;
  validationPassed: boolean;
  estimatedCostUsd: number;
  latencyMs: number;
}

export interface ContentGenerationResult {
  generationId: string;
  /** Structured, already through all four validation stages. */
  content: CaptionContent;
  metadata: {
    task: AITask;
    provider: AIProviderName;
    model: string;
    tier: AITier;
    attempts: number;
    escalations: number;
    fallbackUsed: boolean;
    totalCostUsd: number;
    totalLatencyMs: number;
    promptTemplateId: string;
    promptVersion: number;
    inputHash: string;
    attemptTrail: ContentGenerationAttemptInfo[];
  };
}

export interface ContentEngine {
  generate(request: ContentGenerationRequest): Promise<ContentGenerationResult>;
}
