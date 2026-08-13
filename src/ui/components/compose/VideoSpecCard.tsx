"use client";

import { Badge } from "@/ui/components/ui/badge";
import {
  VIDEO_TARGET_HINTS,
  VIDEO_TARGET_LABELS,
  formatCodecs,
  formatDurationSec,
  formatFileSize,
  formatFps,
  formatResolution,
  type ComposeVideo,
  type MediaAsset,
} from "@/ui/schemas/compose.schema";

/**
 * Video posts only (E10.1 Phase 2): which clip goes out, where it goes, and
 * what the checker measured.
 *
 * INTERNAL operator information, like the stock block: it sits outside the
 * caption area and nothing here ever reaches a caption (business rule 2).
 *
 * Two honest outcomes, never merged into one:
 *  - `spec` present  -> the numbers ffprobe read, so the operator can see WHY a
 *    clip passed or would fail;
 *  - `spec === null` -> nothing was measured in this process. That is not a
 *    pass: the worker owns ffprobe and re-checks before uploading a byte, the
 *    same two-pass rule the stock gate follows.
 */
export function VideoSpecCard({
  video,
  clip,
}: {
  video: ComposeVideo;
  /** The single clip `composePost` selected; absent only if compose was blocked. */
  clip?: MediaAsset;
}) {
  const { spec } = video;

  return (
    <section
      aria-labelledby="video-spec-heading"
      className="bg-card space-y-3 rounded-xl border p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="video-spec-heading" className="text-base font-semibold">
          Video sẽ đăng
        </h3>
        <Badge tone="info">{VIDEO_TARGET_LABELS[video.target]}</Badge>
      </div>

      <p className="text-muted-foreground text-xs">{VIDEO_TARGET_HINTS[video.target]}</p>

      <p className="text-sm">
        <span className="text-muted-foreground">Tệp clip:</span>{" "}
        <span className="font-mono text-xs break-all">{clip?.fileName ?? "(chưa xác định)"}</span>
      </p>

      {spec ? (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <SpecRow label="Thời lượng" value={formatDurationSec(spec.durationSec)} />
          <SpecRow label="Độ phân giải" value={formatResolution(spec.width, spec.height)} />
          <SpecRow label="Codec" value={formatCodecs(spec.videoCodec, spec.audioCodec)} />
          <SpecRow label="Tốc độ khung hình" value={formatFps(spec.fps)} />
          <SpecRow label="Dung lượng" value={formatFileSize(spec.sizeBytes)} />
          <SpecRow label="Định dạng file" value={spec.container.toUpperCase()} />
        </dl>
      ) : (
        <p
          role="status"
          className="border-warning/40 bg-warning/10 text-warning-foreground rounded-lg border px-3 py-2 text-sm"
        >
          Chưa kiểm được thông số video ở bước soạn bài — hệ thống sẽ kiểm lại trước khi đăng. Nếu
          clip không đạt, bài sẽ bị chặn ở bước đăng kèm lý do trong nhật ký.
        </p>
      )}
    </section>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
