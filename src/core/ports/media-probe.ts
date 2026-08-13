/**
 * Media probe ports (E3, Phase 2 — video spec check).
 * Types only, no runtime import (docs/07 section 2).
 *
 * Two ports on purpose, because there are two different questions:
 *
 *   MediaProbe      — "what is inside THIS file?" Implemented by adapters/media
 *                     over the ffprobe binary. Knows nothing about tenants,
 *                     Drive or products.
 *   VideoAssetProbe — "what is inside THIS synced asset?" The usecase-facing
 *                     port: composition combines a DriveSource download with a
 *                     MediaProbe so `composePost` never learns about bytes,
 *                     temp files or Google. Optional in every usecase that uses
 *                     it: a web process without an ffprobe binary must still
 *                     compose (with a warning), and the worker — which does have
 *                     ffmpeg in its image — performs the real check before
 *                     uploading a single byte (docs/02 section 5.4).
 *
 * Error contract for implementers (never let a raw spawn/JSON error escape):
 *   - file missing / no longer on Drive        -> AppError('MEDIA_NOT_FOUND')
 *   - not a video, corrupt, unparsable output  -> AppError('INVALID_INPUT')
 *                                                 context.reason = NOT_A_VIDEO |
 *                                                 FFPROBE_EXIT_NONZERO |
 *                                                 FFPROBE_OUTPUT_INVALID |
 *                                                 MISSING_DURATION
 *   - ffprobe absent / timed out / killed      -> AppError('INTERNAL')
 *                                                 context.reason = FFPROBE_NOT_AVAILABLE |
 *                                                 FFPROBE_TIMEOUT | FFPROBE_SPAWN_FAILED
 *
 * PENDING(error-code): the codes above are the closest existing ones. The
 * honest pair would be VIDEO_PROBE_FAILED + VIDEO_SPEC_INVALID in
 * core/domain/errors.ts — requested from the orchestrator, `context.reason`
 * carries the detail until they exist.
 */

import type { MediaAsset } from "@/core/domain/product";
import type { VideoSpec } from "@/core/domain/video-spec";

/**
 * Where the bytes are. A path avoids buffering a multi-GB file; `bytes` exists
 * because Drive downloads land in memory today (see DriveFileContent) and the
 * adapter spills them to a temp file it also deletes.
 */
export type ProbeSource =
  | { readonly kind: "path"; readonly path: string }
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      /** Original name — only used to give the temp file a plausible extension. */
      readonly fileName?: string;
    };

export interface MediaProbe {
  probeVideo(source: ProbeSource): Promise<VideoSpec>;
}

export interface ProbeVideoAssetInput {
  readonly tenantId: string;
  readonly asset: MediaAsset;
}

export interface VideoAssetProbe {
  probeAsset(input: ProbeVideoAssetInput): Promise<VideoSpec>;
}
