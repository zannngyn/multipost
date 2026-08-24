"use client";

import { Button, HStack, Stack, StatusDot, Table, Text, pixel, proportional } from "@astryxdesign/core";
import type { TableColumn } from "@astryxdesign/core";

import { productStatus } from "@/ui/components/products/product-status";
import { formatCount, formatMediaCounts, type CatalogProduct } from "@/ui/schemas/catalog.schema";

/**
 * The catalog as the operator sees it: which codes can be posted, and for the
 * rest, WHY not (business rule 5 — nothing is silently skipped).
 *
 * The "why" is deliberately NOT in the table. The shadcn version repeated the
 * same domain sentence in both the stock and the publish column, which cost half
 * the row width and made every row three lines tall. The reason now lives once,
 * in the inspector panel, and the row carries only what an operator scans:
 * status, code, name, category, stock, media count.
 *
 * `composable` is decided by the SERVER. The UI never re-derives it from stock +
 * photo counts: the day the rule changes (a video-only code, a new block), a
 * client-side guess would offer a "Soạn bài" button that dies on the next screen
 * with the real reason.
 *
 * Business rule 2: stock and block reasons are INTERNAL. They live in this table
 * and in the inspector — never inside a caption.
 */

/** Table's generic needs an index signature; the fields stay CatalogProduct's. */
type ProductRow = CatalogProduct & Record<string, unknown>;

export function ProductTable({
  items,
  selectedCode,
  onSelect,
}: {
  items: readonly CatalogProduct[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
}) {
  const columns: TableColumn<ProductRow>[] = [
    {
      key: "code",
      header: "Mã SP",
      width: pixel(210),
      renderCell: (product) => {
        const status = productStatus(product);
        const isSelected = selectedCode === product.code;
        return (
          <HStack gap={2} align="center">
            {/* The dot's colour is decoded by ProductStatusLegend above the
                table — words that are always on screen, not only on hover
                (Named Status Rule). The label/tooltip here name THIS row's own
                reason ("Hết hàng", "Thiếu ảnh"), which the legend cannot. */}
            <StatusDot variant={status.variant} label={status.label} tooltip={status.label} />
            {/* The code is the row's interactive element: one tab stop per row,
                and a real button rather than a click handler on the <tr>.
                The filled variant marks the row the inspector is showing —
                aria-pressed alone would leave sighted users guessing. */}
            <Button
              variant={isSelected ? "secondary" : "ghost"}
              size="sm"
              label={product.code}
              aria-pressed={isSelected}
              onClick={() => onSelect(product.code)}
            />
          </HStack>
        );
      },
    },
    {
      key: "name",
      header: "Tên sản phẩm",
      width: proportional(2),
      renderCell: (product) =>
        product.name.trim().length > 0 ? (
          <Text>{product.name}</Text>
        ) : (
          <Text color="placeholder">(trống trên Sheet)</Text>
        ),
    },
    {
      key: "category",
      header: "Chủng loại",
      width: proportional(1),
      renderCell: (product) => <Text color="secondary">{product.category ?? "—"}</Text>,
    },
    {
      key: "stock",
      header: "Tồn kho",
      width: pixel(120),
      align: "end",
      renderCell: (product) =>
        product.inventory.stock === null ? (
          <Text color="placeholder">—</Text>
        ) : (
          <Text>{formatCount(product.inventory.stock)}</Text>
        ),
    },
    {
      key: "media",
      header: "Ảnh / video",
      width: pixel(140),
      renderCell: (product) => (
        <Text color="secondary">
          {formatMediaCounts(product.mediaImageCount, product.mediaVideoCount)}
        </Text>
      ),
    },
  ];

  return (
    <Stack direction="vertical" isScrollable height="100%">
      <Table
        data={items as ProductRow[]}
        columns={columns}
        idKey="code"
        density="compact"
        hasHover
        textOverflow="truncate"
        rowCount={items.length}
      />
    </Stack>
  );
}
