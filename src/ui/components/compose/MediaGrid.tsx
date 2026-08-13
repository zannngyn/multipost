import { Badge } from "@/ui/components/ui/badge";
import type { MediaAsset } from "@/ui/schemas/compose.schema";

/**
 * The album that will be posted, in publish order. Index 0 is the cover.
 *
 * There is no <img> on purpose: the browser has no access to Drive and there is
 * no thumbnail endpoint yet, so the grid shows the file identity instead of
 * pretending to show a picture. A fake placeholder would let an operator
 * "approve" photos they never saw.
 */
export function MediaGrid({ media }: { media: readonly MediaAsset[] }) {
  // A video post carries exactly one clip, so "ảnh bìa"/"thứ tự đăng" would be
  // nonsense there — the words follow the kind that was actually composed.
  const isVideo = media[0]?.kind === "video";

  return (
    <section aria-labelledby="media-heading" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="media-heading" className="text-base font-semibold">
          {isVideo ? "Clip sẽ đăng" : "Ảnh sẽ đăng"} ({media.length})
        </h3>
        <p className="text-muted-foreground text-xs">
          {isVideo
            ? "Một bài video chỉ dùng đúng một clip."
            : "Thứ tự bên dưới là thứ tự đăng. Ảnh đầu tiên là ảnh bìa."}
        </p>
      </div>

      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {media.map((asset, index) => (
          <li
            key={asset.driveFileId}
            className="bg-card flex flex-col gap-1.5 rounded-lg border p-3"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground text-xs tabular-nums">#{index + 1}</span>
              {index === 0 && !isVideo ? <Badge tone="success">Ảnh bìa</Badge> : null}
              {asset.color ? <Badge tone="info">{asset.color}</Badge> : null}
              {asset.needsReview ? <Badge tone="warning">Cần rà soát</Badge> : null}
            </div>

            <p className="font-mono text-xs break-all">{asset.fileName}</p>

            {asset.warnings.length > 0 ? (
              <ul className="text-warning-foreground list-disc space-y-0.5 pl-4 text-xs">
                {asset.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground text-xs">
        {isVideo
          ? "Chưa xem trước được clip trên màn hình này — chưa có đường tải video từ Drive về trình duyệt. Kiểm tra bằng tên file và bảng thông số, hoặc mở thư mục Drive tương ứng."
          : "Chưa xem được ảnh trực tiếp trên màn hình này — Phase 1 chưa có đường tải ảnh từ Drive về trình duyệt. Kiểm tra bằng tên file, hoặc mở thư mục Drive tương ứng."}
      </p>
    </section>
  );
}
