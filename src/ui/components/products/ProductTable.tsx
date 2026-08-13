"use client";

import Link from "next/link";

import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import {
  INVENTORY_STATUS_LABELS,
  INVENTORY_STATUS_TONES,
  blockedReasonLabel,
  formatCount,
  formatMediaCounts,
  type CatalogProduct,
} from "@/ui/schemas/catalog.schema";

/**
 * The catalog as the operator sees it: which codes can be posted, and for the
 * rest, WHY not (business rule 5 — nothing is silently skipped).
 *
 * `composable` is decided by the SERVER. The UI never re-derives it from stock +
 * photo counts: the day the rule changes (a video-only code, a new block), a
 * client-side guess would offer a "Soạn bài" button that dies on the next
 * screen with the real reason.
 *
 * Business rule 2: stock and block reasons are INTERNAL. They live in this
 * table and in the compose screen's internal block — never inside a caption.
 */
export function ProductTable({ items }: { items: readonly CatalogProduct[] }) {
  return (
    <div
      className="overflow-x-auto rounded-xl border"
      tabIndex={0}
      role="region"
      aria-label="Bảng sản phẩm, cuộn ngang được"
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Danh sách sản phẩm: mã, tên, chủng loại, tồn kho, số ảnh/video và trạng thái đăng bài
        </caption>
        <colgroup>
          <col className="w-[14%]" />
          <col className="w-[24%]" />
          <col className="w-[12%]" />
          <col className="w-[18%]" />
          <col className="w-[14%]" />
          <col className="w-[18%]" />
        </colgroup>
        <thead className="bg-muted/50">
          <tr className="text-left">
            <th scope="col" className="px-3 py-2 font-medium">
              Mã SP
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Tên sản phẩm
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Chủng loại
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Tồn kho
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Ảnh / video
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Đăng bài
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.code} className="border-t align-top">
              <td className="px-3 py-2">
                <span className="font-mono text-xs break-all">{item.code}</span>
              </td>
              <td className="px-3 py-2">
                <span className={item.name.trim().length > 0 ? "" : "text-muted-foreground italic"}>
                  {item.name.trim().length > 0 ? item.name : "(trống trên Sheet)"}
                </span>
                {item.season ? (
                  <span className="text-muted-foreground block text-xs">Mùa vụ: {item.season}</span>
                ) : null}
              </td>
              <td className="text-muted-foreground px-3 py-2">{item.category ?? "—"}</td>
              <td className="px-3 py-2">
                <StockCell product={item} />
              </td>
              <td className="px-3 py-2">
                <span className="tabular-nums">
                  {formatMediaCounts(item.mediaImageCount, item.mediaVideoCount)}
                </span>
              </td>
              <td className="px-3 py-2">
                <PublishCell product={item} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Badge + the domain's own Vietnamese sentence (never re-worded here). */
function StockCell({ product }: { product: CatalogProduct }) {
  const { inventory } = product;

  return (
    <div className="space-y-1">
      <Badge tone={INVENTORY_STATUS_TONES[inventory.status]}>
        {INVENTORY_STATUS_LABELS[inventory.status]}
        {inventory.stock !== null ? ` x${formatCount(inventory.stock)}` : ""}
      </Badge>
      {inventory.stock === null ? (
        <p className="text-muted-foreground text-xs">Ô tồn trống hoặc không phải số</p>
      ) : null}
      {inventory.operatorMessage ? (
        <p className="text-muted-foreground text-xs">{inventory.operatorMessage}</p>
      ) : null}
    </div>
  );
}

function PublishCell({ product }: { product: CatalogProduct }) {
  if (product.composable) {
    return (
      <div className="space-y-1">
        <Button asChild variant="outline">
          {/* The code travels in the URL; the wizard looks it up again and
              re-runs the stock gate — this is a shortcut, not a bypass. */}
          <Link href={`/compose?code=${encodeURIComponent(product.code)}`}>Soạn bài</Link>
        </Button>
        {product.hasConflict ? (
          <p className="text-warning-foreground text-xs">
            Sheet có nhiều dòng cho mã này — kiểm tra lại trước khi đăng
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Badge tone="danger">
        {product.blockedReason ? blockedReasonLabel(product.blockedReason.code) : "Không đăng được"}
      </Badge>
      <p className="text-muted-foreground text-xs">
        {product.blockedReason?.userMessage ??
          "Mã này chưa đăng được. Mở màn Đồng bộ dữ liệu để xem chi tiết."}
      </p>
    </div>
  );
}
