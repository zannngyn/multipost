import { AppError } from "@/core/domain/errors";
import { normalizeTenantId } from "@/core/domain/tenant-context";
import type { VideoSpec } from "@/core/domain/video-spec";
import type { DriveSource } from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";
import type { MediaProbe, ProbeVideoAssetInput, VideoAssetProbe } from "@/core/ports/media-probe";

/**
 * VideoAssetProbe = "download the asset, then ffprobe it" (E3, Phase 2).
 *
 * It exists so `composePost` can ask "what is inside this video?" without
 * knowing about Drive, bytes or temp files. Both halves arrive as ports, so this
 * file imports no other adapter (the one-way law, docs/07 section 2).
 *
 * LIMITATION — DriveSource.download buffers the whole file in memory (its own
 * doc comment says "revisit when Phase 2 streams video"). Until it streams, a
 * clip above MAX_PROBE_DOWNLOAD_BYTES is refused with a named reason instead of
 * being pulled into RAM. Facebook accepts up to 10GB, so a legitimate large
 * video can hit this: it must be reported to the operator, never posted
 * unchecked. Open item handed to the orchestrator.
 */

/** 512MB — comfortably above every clip in the real Drive folder (docs/05). */
export const MAX_PROBE_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export interface DriveVideoProbeDeps {
  drive: DriveSource;
  probe: MediaProbe;
  logger: Logger;
  maxDownloadBytes?: number;
}

export function makeDriveVideoProbe(deps: DriveVideoProbeDeps): VideoAssetProbe {
  const maxDownloadBytes =
    typeof deps?.maxDownloadBytes === "number" && deps.maxDownloadBytes > 0
      ? deps.maxDownloadBytes
      : MAX_PROBE_DOWNLOAD_BYTES;

  return {
    async probeAsset(input: ProbeVideoAssetInput): Promise<VideoSpec> {
      // --- Edge cases first --------------------------------------------------
      const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
      const asset = input?.asset;
      if (rawTenantId.length === 0 || !asset || typeof asset.driveFileId !== "string") {
        throw new AppError("INVALID_INPUT", {
          message: "probeAsset requires a tenant id and a media asset with a Drive file id",
          context: { reason: "PROBE_INPUT_INVALID", tenant_id: rawTenantId || null },
        });
      }
      const tenantId = normalizeTenantId(input.tenantId);

      const log = deps.logger.child({
        tenant_id: tenantId,
        product_code: asset.productCode,
      });

      // Known-too-big is answered before the download, not after buffering it.
      if (typeof asset.sizeBytes === "number" && asset.sizeBytes > maxDownloadBytes) {
        throw new AppError("INVALID_INPUT", {
          message: `Video is too large to probe in-process (${asset.sizeBytes} bytes)`,
          userMessage: `Video "${asset.fileName}" quá lớn để kiểm tra thông số tự động — cần kiểm tra thủ công trước khi đăng.`,
          context: {
            reason: "VIDEO_TOO_LARGE_TO_PROBE",
            drive_file_id: asset.driveFileId,
            size_bytes: asset.sizeBytes,
            max_bytes: maxDownloadBytes,
          },
        });
      }

      const content = await deps.drive.download({
        tenantId,
        fileId: asset.driveFileId,
        maxBytes: maxDownloadBytes,
      });

      const spec = await deps.probe.probeVideo({
        kind: "bytes",
        bytes: content.bytes,
        fileName: asset.fileName,
      });

      log.debug("Video probed", {
        drive_file_id: asset.driveFileId,
        file_name: asset.fileName,
        container: spec.container,
        video_codec: spec.videoCodec,
        width: spec.width,
        height: spec.height,
        duration_sec: spec.durationSec,
        size_bytes: spec.sizeBytes,
        fps: spec.fps,
        rotation_degrees: spec.rotationDegrees ?? 0,
      });

      return spec;
    },
  };
}
