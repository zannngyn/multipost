"use client";

import {
  Button,
  EmptyState,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  LayoutPanel,
  SegmentedControl,
  SegmentedControlItem,
  Stack,
  StackItem,
  Text,
  TextInput,
  useMediaQuery,
} from "@astryxdesign/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import {
  inspectorRecovery,
  isInspectorDrawerOpen,
  productInspectorState,
} from "@/ui/components/products/product-inspector-state";
import { matchingTotal } from "@/ui/components/products/product-totals";
import { ProductInspector } from "@/ui/components/products/ProductInspector";
import { ProductInspectorDrawer } from "@/ui/components/products/ProductInspectorDrawer";
import { ProductStatusLegend } from "@/ui/components/products/ProductStatusLegend";
import { ProductTable } from "@/ui/components/products/ProductTable";
import { ProductTableSkeleton } from "@/ui/components/products/ProductTableSkeleton";
import { useCatalogProducts } from "@/ui/hooks/useCatalogProducts";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import {
  formatCount,
  parseProductFilter,
  productSearchParams,
  type CatalogProduct,
  type ProductFilter,
  type ProductFilterStatus,
} from "@/ui/schemas/catalog.schema";

/**
 * "Sản phẩm" (E10): the list an operator checks before composing anything —
 * which codes are publishable, and for the rest, why not.
 *
 * Frame (web-layout-shell): header holds the filters, the rows run edge-to-edge
 * in the content region, and the selected code opens an inspector panel instead
 * of navigating away — the tracker archetype from `astryx docs layout`.
 *
 * The filter lives in the URL (core-data-list-query rule 1): `/products?status=
 * blocked&q=MGK` is shareable, survives F5 and makes Back behave. One builder
 * writes it, one parser reads it, and the query key is derived from the same
 * object — no second source of truth. The selected row rides in `?chon=` which
 * is deliberately NOT part of ProductFilter: selecting a row must not refetch.
 *
 * Responsive contract (`astryx docs layout` asks for this at the frame root):
 *   > 1024px  content | inspector LayoutPanel 380
 *   <= 1024px inspector becomes a modal drawer pinned to the inline end, so
 *             selecting a code still leads somewhere and "Soạn bài" is reachable
 *   <= 1024px filter cluster stacks: search on its own row, status below it
 *
 * The four mandatory states:
 *   loading — skeleton with the real columns, delayed 300ms
 *   data    — rows + "Tải thêm" (cursor, so no page numbers)
 *   empty   — told apart: "chưa đồng bộ lần nào" (the catalog is empty) vs
 *             "không khớp bộ lọc" (data exists, this filter finds none). One
 *             box for both would make an operator think the data was lost
 *   error   — 4xx (sửa bộ lọc) vs 5xx (thử lại), via `presentApiError`
 */

/** Typing is applied after a pause, not per keystroke (core-data-list-query). */
const SEARCH_DEBOUNCE_MS = 300;

/** Selected-row param. Separate from ProductFilter so it never refetches. */
const SELECTED_PARAM = "chon";

export function ProductListScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Read at runtime, not once: a tablet leaving split-screen must get its panel
  // back without a reload (web-multi-device).
  const isNarrow = useMediaQuery("(max-width: 1024px)");

  const filter = useMemo(
    () => parseProductFilter(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const selectedCode = searchParams.get(SELECTED_PARAM);

  const products = useCatalogProducts(filter);
  const isFirstLoad = products.isPending && products.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const items = useMemo(
    () => products.data?.pages.flatMap((page) => page.items) ?? [],
    [products.data],
  );
  // Totals describe the whole catalog under this filter, not the loaded pages;
  // the first page is authoritative and every page repeats it.
  const totals = products.data?.pages[0]?.totals ?? { total: 0, ok: 0, blocked: 0 };
  const hasFilter = filter.status !== null || filter.q !== null;
  // `isFetching` and not `isFirstLoad`: a "Tải lại" that empties the list for a
  // moment must not turn the open inspector into "không thấy mã này".
  const inspector = productInspectorState(selectedCode, items, {
    isLoading: products.isFetching,
  });
  const isDrawerOpen = isInspectorDrawerOpen(isNarrow, inspector);

  /** Writes filter + selection together so neither clobbers the other. */
  const pushUrl = useCallback(
    (next: ProductFilter, selectedNext: string | null) => {
      const params = productSearchParams(next);
      if (selectedNext) params.set(SELECTED_PARAM, selectedNext);
      const query = params.toString();
      // `replace`: changing a filter is not a navigation step to walk back to.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  // --- Search box: local while typing, URL once it settles -----------------
  const [draft, setDraft] = useState(filter.q ?? "");
  /** Last value THIS component wrote to the URL — tells our own echo apart. */
  const lastApplied = useRef(filter.q ?? "");

  useEffect(() => {
    const fromUrl = filter.q ?? "";
    // The URL changed from outside (Back, a shared link): follow it.
    if (fromUrl !== lastApplied.current) {
      lastApplied.current = fromUrl;
      setDraft(fromUrl);
    }
  }, [filter.q]);

  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === (filter.q ?? "")) return;

    const timer = setTimeout(() => {
      lastApplied.current = trimmed;
      pushUrl({ status: filter.status, q: trimmed.length > 0 ? trimmed : null }, selectedCode);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, filter.q, filter.status, selectedCode, pushUrl]);

  function clearFilters() {
    lastApplied.current = "";
    setDraft("");
    pushUrl({ status: null, q: null }, selectedCode);
  }

  function selectStatus(value: string) {
    const status = value === "all" ? null : (value as ProductFilterStatus);
    pushUrl({ status, q: filter.q }, selectedCode);
  }

  // --- Focus, across the drawer's life -------------------------------------
  /**
   * Which element opened the drawer, so closing can hand focus back to it.
   *
   * The native <dialog> restores focus when IT closes — but this drawer closes
   * by unmounting (the selection lives in the URL, and clearing it removes the
   * dialog from the tree), so the browser has nothing to restore to and focus
   * falls to <body>. A keyboard user would then be back at the top of the page
   * with the row they were reading nowhere near the caret (core-accessibility).
   *
   * The row's code button is rendered inside Astryx's Table, so there is no ref
   * to reach for; the element that had focus at the moment of the press is the
   * same element and needs no plumbing through the table.
   */
  const invokerRef = useRef<HTMLElement | null>(null);
  const shouldRestoreFocus = useRef(false);

  useEffect(() => {
    if (isDrawerOpen || !shouldRestoreFocus.current) return;
    shouldRestoreFocus.current = false;

    const invoker = invokerRef.current;
    invokerRef.current = null;
    // The row may have been re-rendered away (a filter change, a refetch).
    // Silently doing nothing is right: there is nothing to go back to.
    if (invoker?.isConnected) invoker.focus();
  }, [isDrawerOpen]);

  function selectProduct(code: string) {
    const active = document.activeElement;
    invokerRef.current = active instanceof HTMLElement ? active : null;
    pushUrl(filter, code);
  }

  function closeDrawer() {
    shouldRestoreFocus.current = true;
    pushUrl(filter, null);
  }

  /**
   * What the drawer offers when the selected code is not among the loaded rows.
   * Clearing the filter KEEPS `?chon=`, so the drawer stays open and fills
   * itself in as the unfiltered page arrives — one press, no re-finding.
   */
  const recoveryPlan = inspectorRecovery({ hasFilter, hasNextPage: products.hasNextPage });
  const recovery =
    recoveryPlan === null
      ? null
      : {
          ...recoveryPlan,
          onPress:
            recoveryPlan.kind === "clear-filter"
              ? clearFilters
              : () => void products.fetchNextPage(),
        };

  /**
   * The status filter. The counts ride in the labels on a wide viewport, where
   * three segments plus two numbers fit; on a narrow one they are dropped —
   * "Đăng đ… 1.2" truncated inside a segment is worse than no number, and the
   * footer already says how many rows the active filter matches.
   */
  const statusFilter = (
    <SegmentedControl
      label="Lọc theo trạng thái đăng bài"
      value={filter.status ?? "all"}
      onChange={selectStatus}
      size="sm"
      layout={isNarrow ? "fill" : "hug"}
    >
      <SegmentedControlItem
        label={isNarrow ? "Tất cả" : `Tất cả ${formatCount(totals.total)}`}
        value="all"
      />
      <SegmentedControlItem
        label={isNarrow ? "Đăng được" : `Đăng được ${formatCount(totals.ok)}`}
        value="ok"
      />
      <SegmentedControlItem
        label={isNarrow ? "Bị chặn" : `Bị chặn ${formatCount(totals.blocked)}`}
        value="blocked"
      />
    </SegmentedControl>
  );

  const searchBox = (
    <TextInput
      label="Tìm theo mã hoặc tên"
      value={draft}
      onChange={setDraft}
      placeholder="MGKVX6310 hoặc Giannal"
      startIcon={Search}
      size="sm"
      // Three lines of help under a full-width field is most of a phone screen
      // (spec §3.4). The placeholder carries the example; the behaviour is
      // discovered by typing.
      description={
        isNarrow
          ? undefined
          : "Gõ xong đợi một nhịp là danh sách tự lọc. Bộ lọc nằm trong địa chỉ trang nên gửi link được."
      }
    />
  );

  const clearButton = hasFilter ? (
    <Button variant="ghost" size="sm" label="Bỏ bộ lọc" onClick={clearFilters} />
  ) : null;

  return (
    <>
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider>
            <Stack direction="vertical" gap={3} padding={4}>
              {/* Title row owns "Tải lại": it acts on the whole screen, not on
                  the filter, and keeping it here is what frees the filter row
                  from wrapping to a third tier on a phone. */}
              <HStack gap={3} align="start">
                <StackItem size="fill">
                  <Stack direction="vertical" gap={1}>
                    <Heading level={1}>Sản phẩm</Heading>
                    <Text type="supporting">
                      Dữ liệu của lần đồng bộ gần nhất: mã nào đăng được, mã nào bị chặn và vì
                      sao. Tồn kho ở đây là thông tin nội bộ — không bao giờ đi vào caption.
                    </Text>
                  </Stack>
                </StackItem>

                <Button
                  variant="secondary"
                  size="sm"
                  label={products.isFetching ? "Đang tải…" : "Tải lại"}
                  isDisabled={products.isFetching}
                  onClick={() => void products.refetch()}
                />
              </HStack>

              {isNarrow ? (
                // Two tiers, always: search, then status. What used to happen
                // here was a single HStack wrapping into three ragged rows.
                <Stack direction="vertical" gap={2}>
                  {searchBox}
                  <HStack gap={2} align="center">
                    <StackItem size="fill">{statusFilter}</StackItem>
                    {clearButton}
                  </HStack>
                </Stack>
              ) : (
                <HStack gap={3} align="end">
                  <StackItem size="fill">{searchBox}</StackItem>
                  {statusFilter}
                  {clearButton}
                </HStack>
              )}
            </Stack>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={0}>
            <ProductListBody
              isFirstLoad={isFirstLoad}
              showSkeleton={showSkeleton}
              products={products}
              items={items}
              totals={totals}
              filter={filter}
              hasFilter={hasFilter}
              selectedCode={selectedCode}
              onSelect={selectProduct}
              onClearFilters={clearFilters}
            />
          </LayoutContent>
        }
        end={
          isNarrow ? undefined : (
            <LayoutPanel width={380} hasDivider label="Chi tiết sản phẩm">
              {/* The panel is not modal, so the header controls stay usable —
                  but one press beats two, here as much as in the drawer. */}
              <ProductInspector state={inspector} recovery={recovery} />
            </LayoutPanel>
          )
        }
      />

      {/* Same inspector, other frame. Closing clears `?chon=` so Back does not
          re-open a drawer the operator just dismissed, and hands focus back to
          the row that opened it. */}
      <ProductInspectorDrawer
        state={inspector}
        isOpen={isDrawerOpen}
        onClose={closeDrawer}
        recovery={recovery}
      />
    </>
  );
}

function ProductListBody({
  isFirstLoad,
  showSkeleton,
  products,
  items,
  totals,
  filter,
  hasFilter,
  selectedCode,
  onSelect,
  onClearFilters,
}: {
  isFirstLoad: boolean;
  showSkeleton: boolean;
  products: ReturnType<typeof useCatalogProducts>;
  items: readonly CatalogProduct[];
  totals: { total: number; ok: number; blocked: number };
  filter: ProductFilter;
  hasFilter: boolean;
  selectedCode: string | null;
  onSelect: (code: string) => void;
  onClearFilters: () => void;
}) {
  const router = useRouter();

  // --- Loading (delayed so a fast answer does not flash) -------------------
  if (isFirstLoad) return showSkeleton ? <ProductTableSkeleton /> : null;

  // --- Error ---------------------------------------------------------------
  if (products.isError && items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        <ApiErrorNotice error={products.error} onRetry={() => void products.refetch()} />
      </Stack>
    );
  }

  // --- Empty: the two cases are told apart on purpose -----------------------
  if (items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        {hasFilter ? (
          <EmptyState
            headingLevel={2}
            title="Không có sản phẩm nào khớp bộ lọc"
            description="Dữ liệu vẫn còn nguyên — chỉ là không có mã nào khớp từ khoá hoặc trạng thái đang chọn. Bỏ bộ lọc để xem toàn bộ danh sách."
            actions={<Button variant="secondary" label="Bỏ bộ lọc" onClick={onClearFilters} />}
          />
        ) : (
          <EmptyState
            headingLevel={2}
            title="Chưa có sản phẩm nào trong hệ thống"
            description="Đơn vị này chưa đồng bộ lần nào, hoặc lần đồng bộ gần nhất không đọc được mã nào. Mở màn Đồng bộ dữ liệu, kiểm tra nguồn Drive/Sheet rồi chạy đồng bộ."
            actions={
              <Button
                variant="primary"
                label="Mở màn Đồng bộ dữ liệu"
                onClick={() => router.push("/sync")}
              />
            }
          />
        )}
      </Stack>
    );
  }

  // --- Data ----------------------------------------------------------------
  return (
    <Stack direction="vertical" height="100%">
      {/* Above the rows, not below: the key has to be read before the dots are,
          and it must survive the table scrolling. */}
      <ProductStatusLegend items={items} />

      <StackItem size="fill">
        <ProductTable items={items} selectedCode={selectedCode} onSelect={onSelect} />
      </StackItem>

      <Stack direction="horizontal" gap={3} padding={3} align="center" justify="center">
        <Text type="supporting" role="status" aria-live="polite">
          Đang hiển thị {formatCount(items.length)} / {formatCount(matchingTotal(totals, filter))}{" "}
          sản phẩm
          {filter.q ? ` khớp “${filter.q}”` : ""}.
        </Text>
        {products.hasNextPage ? (
          <Button
            variant="secondary"
            size="sm"
            label={products.isFetchingNextPage ? "Đang tải…" : "Tải thêm"}
            isDisabled={products.isFetchingNextPage}
            onClick={() => void products.fetchNextPage()}
          />
        ) : null}
      </Stack>
    </Stack>
  );
}
