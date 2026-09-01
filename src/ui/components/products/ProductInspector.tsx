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

import { StockCheckSkippedBanner } from "@/ui/components/inventory/StockCheckSkippedBanner";
import { stockLabel } from "@/ui/components/inventory/stock-check";
import type {
  InspectorRecoveryAction,
  ProductInspectorState,
} from "@/ui/components/products/product-inspector-state";
import { productStatus } from "@/ui/components/products/product-status";
import {
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

export function ProductInspector({
  state,
  /**
   * 2 in the panel, where this body is the first heading under the page title.
   * 3 in the drawer, where DialogHeader's title already took h2 — two peer
   * headings would tell a screen-reader user the box holds two sections.
   */
  headingLevel = 2,
  /** The button offered when the selected code is not on screen. */
  recovery = null,
  /**
   * Astryx's own rule: "start" for short values, "top" for long ones. In the
   * 380px panel the labels sit beside the values; in a drawer on a split-screen
   * phone (195px measured) a 120px label column leaves ~75px for the value and
   * "Xuân hè 2026" breaks one character per line.
   */
  labelPosition = "start",
}: {
  state: ProductInspectorState;
  headingLevel?: 2 | 3;
  recovery?: InspectorRecoveryAction | null;
  labelPosition?: "start" | "top";
}) {
  const router = useRouter();

  // --- Nothing asked for ---------------------------------------------------
  if (state.kind === "none") {
    return (
      <EmptyState
        isCompact
        headingLevel={headingLevel}
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
        headingLevel={headingLevel}
        title={`Không thấy mã ${state.code} trong danh sách`}
        // Each case names ITS own cause. One sentence covering all three would
        // tell an operator with no filter on that their filter might be to blame.
        description={
          recovery === null
            ? "Danh sách đã tải hết và không có mã này. Kiểm tra lại mã, hoặc chạy đồng bộ nếu Sheet vừa thêm mã mới."
            : recovery.kind === "clear-filter"
              ? "Bộ lọc đang bật có thể đang loại mã này ra khỏi danh sách."
              : "Danh sách mới tải một phần — mã này có thể nằm ở những trang chưa tải."
        }
        // The action lives INSIDE the modal. Pointing at a control on the page
        // behind is pointing at something the dialog has made inert.
        actions={
          recovery ? (
            // `isLoading`, not a swapped label: the fetch it starts changes
            // nothing else in this box — the title still reads "Không thấy mã
            // …" until the row lands — so the button is the only thing that can
            // say the press was heard. It also disables while pending, which is
            // what stops a second press queuing a second page.
            <Button
              variant="secondary"
              label={recovery.label}
              isLoading={recovery.isBusy}
              onClick={recovery.onPress}
            />
          ) : undefined
        }
      />
    );
  }

  const { product } = state;
  const status = productStatus(product);
  const { inventory } = product;
  const stock = stockLabel(inventory);

  // The domain often writes the SAME sentence into both fields ("… đã hết hàng
  // — không đăng"). The block banner below is the louder of the two, so the
  // standalone note only earns its place when it says something different.
  const blockedMessage = product.composable ? null : blockedBannerText(product);
  const showOperatorNote =
    inventory.operatorMessage !== null && inventory.operatorMessage !== blockedMessage;

  return (
    // No scroll container here: the frame around this body owns overflow
    // (LayoutPanel above 1024px, LayoutContent inside the drawer). Two nested
    // scrollers is how the drawer ended up with a body that could not move.
    <Stack direction="vertical" gap={4} padding={4}>
      <Stack direction="vertical" gap={1}>
        <Stack direction="horizontal" gap={2} align="center">
          <StatusDot variant={status.variant} label={status.label} />
          <Heading level={headingLevel}>{product.code}</Heading>
        </Stack>
        <Text type="supporting">
          {product.name.trim().length > 0 ? product.name : "(tên trống trên Sheet)"}
        </Text>
      </Stack>

      <Divider />

      <MetadataList
        label={labelPosition === "top" ? { position: "top" } : { position: "start", width: 120 }}
      >
        <MetadataListItem label="Chủng loại">{product.category ?? "—"}</MetadataListItem>
        <MetadataListItem label="Mùa vụ">{product.season ?? "—"}</MetadataListItem>
        {/* `stockLabel` reads `stockCheckSkipped` BEFORE `status`: a tenant with
            the stock gate off keeps `status: "in_stock"`, and printing "Còn
            hàng" for a code nobody counted is a business-rule failure, not a
            wording one. The raw number stays visible next to it — it is what is
            written on the Sheet, and the label says what it is worth. */}
        <MetadataListItem label="Tồn kho">
          {stock.label}
          {inventory.stock !== null ? ` · ${formatCount(inventory.stock)}` : ""}
        </MetadataListItem>
        <MetadataListItem label="Ảnh / video">
          {formatMediaCounts(product.mediaImageCount, product.mediaVideoCount)}
        </MetadataListItem>
      </MetadataList>

      {/* Above the numbers, not under them: an operator who reads "62" first has
          already drawn the wrong conclusion. */}
      {stock.isSkipped ? (
        <StockCheckSkippedBanner reason={inventory.stockCheckSkippedReason} />
      ) : null}

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
