"use client";

import { AlbumArranger } from "@/ui/components/compose/AlbumArranger";
import { Badge } from "@/ui/components/ui/badge";
import type { MediaAsset } from "@/ui/schemas/compose.schema";

/**
 * The album that will be posted, in publish order. Index 0 is the cover.
 *
 * Arrangeable when the caller passes `onReorder` (step 1, where the operator
 * decides), read-only otherwise (step 3, which confirms rather than edits).
 * Both modes share `AlbumArranger`: a Drive album and an uploaded one are the
 * same list once gathered, so they get the same gesture and the same wording.
 *
 * The order lives in the POST, not in `media_asset`: that table belongs to the
 * Drive sync, which rewrites it on every run. `createPostBatch` already takes
 * the album in caller order, so nothing downstream needs to change.
 *
 * There is no <img> on purpose: the browser has no access to Drive and there is
 * no thumbnail endpoint yet, so the list shows file identity instead of
 * pretending to show a picture. A fake placeholder would let an operator
 * "approve" photos they never saw.
 */
export function MediaGrid({
  media,
  onReorder,
  disabled,
}: {
  media: readonly MediaAsset[];
  /** Absent = read-only. */
  onReorder?: (next: MediaAsset[]) => void;
  disabled?: boolean;
}) {
  // A video post carries exactly one clip, so "ảnh bìa"/"thứ tự đăng" would be
  // nonsense there — the words follow the kind that was actually composed.
  const isVideo = media[0]?.kind === "video";
  // Nothing to arrange with one item, and a lone drag handle only adds noise.
  const arrangeable = Boolean(onReorder) && !isVideo && media.length > 1;

  return (
    <section aria-labelledby="media-heading" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="media-heading" className="text-base font-semibold">
          {isVideo ? "Clip sẽ đăng" : "Ảnh sẽ đăng"} ({media.length})
        </h3>
        <p className="text-muted-foreground text-xs">
          {isVideo
            ? "Một bài video chỉ dùng đúng một clip."
            : arrangeable
              ? "Kéo từng dòng để đổi thứ tự đăng. Ảnh đầu tiên là ảnh bìa."
              : "Thứ tự bên dưới là thứ tự đăng. Ảnh đầu tiên là ảnh bìa."}
        </p>
      </div>

      <AlbumArranger
        items={media.map(toEntry)}
        onChange={(next) => onReorder?.(next.map((entry) => entry.asset))}
        disabled={disabled}
        readOnly={!arrangeable}
        coverLabel={isVideo ? "Clip" : "Ảnh bìa"}
        itemName={(entry) => entry.asset.fileName}
        renderContent={(entry) => <AssetLine asset={entry.asset} />}
      />

      <p className="text-muted-foreground text-xs">
        {isVideo
          ? "Chưa xem trước được clip trên màn hình này — chưa có đường tải video từ Drive về trình duyệt. Kiểm tra bằng tên file và bảng thông số, hoặc mở thư mục Drive tương ứng."
          : "Chưa xem được ảnh trực tiếp trên màn hình này — Phase 1 chưa có đường tải ảnh từ Drive về trình duyệt. Kiểm tra bằng tên file, hoặc mở thư mục Drive tương ứng."}
      </p>
    </section>
  );
}

/**
 * `AlbumArranger` keys rows by `id`; the asset's identity is its file id, which
 * is unique per tenant and stable across a reorder.
 */
interface AssetEntry {
  readonly id: string;
  readonly asset: MediaAsset;
}

function toEntry(asset: MediaAsset): AssetEntry {
  return { id: asset.driveFileId, asset };
}

function AssetLine({ asset }: { asset: MediaAsset }) {
  return (
    <>
      <span className="block font-mono text-xs break-all">{asset.fileName}</span>
      <span className="mt-1 flex flex-wrap items-center gap-1.5">
        {asset.color ? <Badge tone="info">{asset.color}</Badge> : null}
        {asset.needsReview ? <Badge tone="warning">Cần rà soát</Badge> : null}
      </span>
      {asset.warnings.length > 0 ? (
        <ul className="text-warning-foreground mt-1 list-disc space-y-0.5 pl-4 text-xs">
          {asset.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
