"use client";

import {
  Banner,
  Button,
  Divider,
  EmptyState,
  Heading,
  MetadataList,
  MetadataListItem,
  Stack,
  StatusDot,
  Text,
} from "@astryxdesign/core";

import { productStatus } from "@/ui/components/products/ProductTable";
import {
  INVENTORY_STATUS_LABELS,
  formatCount,
  formatMediaCounts,
  type CatalogProduct,
} from "@/ui/schemas/catalog.schema";

/**
 * Detail panel for the selected product. Everything the old table repeated in
 * two prose columns lives here once, plus the single action a row can lead to.
 *
 * Business rule 2: stock and the block reason are INTERNAL — this panel is where
 * an operator reads them, and they never travel into a caption.
 */
/** The sentence the block banner shows. One source, so nothing repeats it. */
function blockedBannerText(product: CatalogProduct): string {
  return (
    product.blockedReason?.userMessage ??
    "Mã này chưa đăng được. Mở màn Đồng bộ dữ liệu để xem chi tiết."
  );
}

export function ProductInspector({ product }: { product: CatalogProduct | null }) {
  if (!product) {
    return (
      <EmptyState
        isCompact
        headingLevel={2}
        title="Chưa chọn sản phẩm nào"
        description="Bấm vào mã sản phẩm ở bảng bên trái để xem tồn kho, ảnh và lý do bị chặn."
      />
    );
  }

  const status = productStatus(product);
  const { inventory } = product;

  // The domain often writes the SAME sentence into both fields ("… đã hết hàng
  // — không đăng"). The block banner below is the louder of the two, so the
  // standalone note only earns its place when it says something different.
  const blockedMessage = product.composable ? null : blockedBannerText(product);
  const showOperatorNote =
    inventory.operatorMessage !== null && inventory.operatorMessage !== blockedMessage;

  return (
    <Stack direction="vertical" gap={4} padding={4} isScrollable height="100%">
      <Stack direction="vertical" gap={1}>
        <Stack direction="horizontal" gap={2} align="center">
          <StatusDot variant={status.variant} label={status.label} />
          <Heading level={2}>{product.code}</Heading>
        </Stack>
        <Text type="supporting">
          {product.name.trim().length > 0 ? product.name : "(tên trống trên Sheet)"}
        </Text>
      </Stack>

      <Divider />

      <MetadataList label={{ position: "start", width: 120 }}>
        <MetadataListItem label="Chủng loại">{product.category ?? "—"}</MetadataListItem>
        <MetadataListItem label="Mùa vụ">{product.season ?? "—"}</MetadataListItem>
        <MetadataListItem label="Tồn kho">
          {INVENTORY_STATUS_LABELS[inventory.status]}
          {inventory.stock !== null ? ` · ${formatCount(inventory.stock)}` : ""}
        </MetadataListItem>
        <MetadataListItem label="Ảnh / video">
          {formatMediaCounts(product.mediaImageCount, product.mediaVideoCount)}
        </MetadataListItem>
      </MetadataList>

      {inventory.stock === null ? (
        <Text type="supporting" color="secondary">
          Ô tồn trên Sheet đang trống hoặc không phải số — không phải bằng 0.
        </Text>
      ) : null}

      {showOperatorNote ? (
        <Text type="supporting" color="secondary">
          {inventory.operatorMessage}
        </Text>
      ) : null}

      {product.hasConflict ? (
        <Banner
          status="warning"
          title="Sheet có nhiều dòng cho mã này"
          description="Kiểm tra lại trên Sheet trước khi đăng — hai dòng đang mang giá trị khác nhau."
        />
      ) : null}

      {product.composable ? (
        <Button
          variant="primary"
          label="Soạn bài"
          // A real link, not a click handler: this is navigation, so Ctrl+click,
          // middle-click and "mở tab mới" all have to work. The code travels in
          // the URL; the wizard looks it up again and re-runs the stock gate —
          // a shortcut, not a bypass.
          href={`/compose?code=${encodeURIComponent(product.code)}`}
        />
      ) : (
        <Banner status="error" title={status.label} description={blockedBannerText(product)} />
      )}
    </Stack>
  );
}
