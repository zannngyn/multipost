"use client";

import {
  Banner,
  Button,
  Divider,
  EmptyState,
  Heading,
  MetadataList,
  MetadataListItem,
  Spinner,
  Stack,
  StatusDot,
  Text,
} from "@astryxdesign/core";
import { useRouter } from "next/navigation";

import type { ProductInspectorState } from "@/ui/components/products/product-inspector-state";
import { productStatus } from "@/ui/components/products/product-status";
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
 * The same body renders in two frames: the LayoutPanel above 1024px, and the
 * modal drawer below it (ProductInspectorDrawer) — one component, so "Soạn bài"
 * cannot exist on one viewport and be missing on the other.
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

export function ProductInspector({ state }: { state: ProductInspectorState }) {
  const router = useRouter();

  // --- Nothing asked for ---------------------------------------------------
  if (state.kind === "none") {
    return (
      <EmptyState
        isCompact
        headingLevel={2}
        title="Chưa chọn sản phẩm nào"
        description="Bấm vào mã sản phẩm trong bảng để xem tồn kho, ảnh và lý do bị chặn."
      />
    );
  }

  // --- Asked for, answer not back yet --------------------------------------
  if (state.kind === "loading") {
    return (
      <Stack direction="vertical" gap={2} padding={4} align="start" role="status">
        <Spinner size="sm" label={`Đang mở mã ${state.code}…`} />
      </Stack>
    );
  }

  // --- Asked for, but not on screen ----------------------------------------
  // A link to `?chon=MGKVX9999` while the filter hides that code used to land on
  // "Chưa chọn sản phẩm nào", which reads as "you clicked nothing". Naming the
  // code and both ways back is the honest answer (business rule 5).
  if (state.kind === "missing") {
    return (
      <EmptyState
        isCompact
        headingLevel={2}
        title={`Không thấy mã ${state.code} trong danh sách`}
        description="Mã này không nằm trong phần danh sách đã tải: có thể bộ lọc đang loại nó ra, hoặc chưa cuộn tới trang chứa nó. Bỏ bộ lọc rồi bấm “Tải thêm” để tìm."
      />
    );
  }

  const { product } = state;
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
          // The code travels in the URL; the wizard looks it up again and re-runs
          // the stock gate — this is a shortcut, not a bypass.
          onClick={() => router.push(`/compose?code=${encodeURIComponent(product.code)}`)}
        />
      ) : (
        <Banner status="error" title={status.label} description={blockedBannerText(product)} />
      )}
    </Stack>
  );
}
