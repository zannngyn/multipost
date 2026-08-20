"use client";

import { AlbumArranger } from "@/ui/components/compose/AlbumArranger";
import { MediaThumb } from "@/ui/components/compose/MediaThumb";
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
 * The tiles show the REAL photo, fetched through the session-authenticated
 * preview route (`ui/services/media-preview`). Until that route existed this
 * grid deliberately drew labelled empty surfaces rather than pretend pictures —
 * approving photos nobody could see was the thing to avoid, and it still is:
 * a tile whose bytes fail to load says so in words instead of quietly looking
 * like a plain tile.
 */
export function MediaGrid({
  media,
  onReorder,
  onRemove,
  disabled,
}: {
  media: readonly MediaAsset[];
  /** Absent = read-only. */
  onReorder?: (next: MediaAsset[]) => void;
  /** Absent = the album cannot be trimmed here (step 3 confirms, it does not edit). */
  onRemove?: (next: MediaAsset[]) => void;
  disabled?: boolean;
}) {
  // A video post carries exactly one clip, so "ảnh bìa"/"thứ tự đăng" would be
  // nonsense there — the words follow the kind that was actually composed.
  const isVideo = media[0]?.kind === "video";
  // Nothing to arrange with one item, and a lone drag handle only adds noise.
  const arrangeable = Boolean(onReorder) && !isVideo && media.length > 1;
  const reviewNames = media.filter((asset) => asset.needsReview).map((asset) => asset.fileName);

  return (
    <section
      aria-labelledby="media-heading"
      className="bg-card border-border space-y-3.5 rounded-2xl border p-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id="media-heading" className="text-base font-semibold">
          {isVideo ? "Clip sẽ đăng" : "Ảnh sẽ đăng"} ({media.length})
        </h3>
        <p className="text-muted-foreground text-xs">
          {isVideo
            ? "Một bài video chỉ dùng đúng một clip."
            : arrangeable
              ? "Kéo một ô vào ô khác để đổi thứ tự đăng, hoặc dùng ← → trên ô. Ô lớn là ảnh bìa."
              : "Thứ tự bên dưới là thứ tự đăng. Ô lớn là ảnh bìa."}
        </p>
      </div>

      <AlbumArranger
        layout="grid"
        items={media.map(toEntry)}
        onChange={(next) => onReorder?.(next.map((entry) => entry.asset))}
        onRemove={
          onRemove && !isVideo
            ? (index) => onRemove(media.filter((_asset, position) => position !== index))
            : undefined
        }
        disabled={disabled}
        readOnly={!arrangeable}
        coverLabel={isVideo ? "Clip" : "Ảnh bìa"}
        coverNote={isVideo ? "chưa xem trước được clip" : undefined}
        itemName={(entry) => entry.asset.fileName}
        // `alt=""`: the filename is written on the tile right beside it, and a
        // screen reader repeating it twice per tile is noise, not information.
        renderMedia={(entry) => <MediaThumb asset={entry.asset} alt="" />}
        renderContent={(entry) => <CoverLine asset={entry.asset} />}
        renderCompact={(entry) => <TileLine asset={entry.asset} />}
      />

      <p className="border-border text-muted-foreground border-t pt-3 text-xs leading-relaxed">
        {isVideo
          ? "Chưa xem trước được clip trên màn hình này — chưa có đường tải video từ Drive về trình duyệt. Kiểm tra bằng tên file và bảng thông số, hoặc mở thư mục Drive tương ứng."
          : "Ảnh được tải qua máy chủ MYSP nên chỉ người trong đơn vị xem được. Ô nào báo “không tải được ảnh” là file đã bị xoá hoặc hỏng trên Drive — bỏ ô đó ra khỏi bài trước khi đăng."}
        {reviewNames.length > 0
          ? ` Ô có chấm cam là file cần rà soát tên: ${reviewNames.join(", ")}.`
          : ""}
      </p>
    </section>
  );
}

/**
 * `AlbumArranger` keys tiles by `id`; the asset's identity is its file id, which
 * is unique per tenant and stable across a reorder.
 */
interface AssetEntry {
  readonly id: string;
  readonly asset: MediaAsset;
}

function toEntry(asset: MediaAsset): AssetEntry {
  return { id: asset.driveFileId, asset };
}

/** Bottom bar of the cover tile — the one place with room for the full story. */
function CoverLine({ asset }: { asset: MediaAsset }) {
  return (
    <>
      <span className="truncate text-sm font-semibold" title={asset.fileName}>
        {asset.fileName}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {asset.color ? <Badge tone="neutral">{asset.color}</Badge> : null}
        {asset.needsReview ? <Badge tone="warning">Cần rà soát</Badge> : null}
      </span>
      {asset.warnings.length > 0 ? (
        <ul className="text-warning-foreground list-disc space-y-0.5 pl-4 text-xs">
          {asset.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * Bottom bar of a small tile. The review state is a dot for the eye AND a
 * sr-only sentence: colour alone must never be the only carrier of a warning
 * (core-accessibility).
 */
function TileLine({ asset }: { asset: MediaAsset }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="truncate font-mono text-xs" title={asset.fileName}>
        {asset.fileName}
      </span>
      {asset.needsReview ? (
        <>
          <span aria-hidden="true" className="bg-warning size-2 shrink-0 rounded-full" />
          <span className="sr-only">Cần rà soát tên file</span>
        </>
      ) : null}
    </span>
  );
}
