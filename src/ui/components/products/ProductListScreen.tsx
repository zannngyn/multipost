"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { ProductTable } from "@/ui/components/products/ProductTable";
import { ProductTableSkeleton } from "@/ui/components/products/ProductTableSkeleton";
import { ProductTotalsBar } from "@/ui/components/products/ProductTotalsBar";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { useCatalogProducts } from "@/ui/hooks/useCatalogProducts";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import {
  formatCount,
  parseProductFilter,
  productSearchParams,
  type ProductFilter,
  type ProductFilterStatus,
} from "@/ui/schemas/catalog.schema";
import { DEMO_TENANT_ID } from "@/ui/schemas/tenant-health.schema";

/**
 * "Sản phẩm" (E10): the list an operator checks before composing anything —
 * which codes are publishable, and for the rest, why not.
 *
 * The filter lives in the URL (core-data-list-query rule 1): `/products?status=
 * blocked&q=MGK` is shareable, survives F5 and makes Back behave. One builder
 * writes it, one parser reads it, and the query key is derived from the same
 * object — no second source of truth.
 *
 * The four mandatory states:
 *   loading — skeleton with the real 6 columns, delayed 300ms
 *   data    — totals + table + "Tải thêm" (cursor, so no page numbers)
 *   empty   — told apart: "chưa đồng bộ lần nào" (the catalog is empty) vs
 *             "không khớp bộ lọc" (data exists, this filter finds none). One
 *             box for both would make an operator think the data was lost
 *   error   — 4xx (sửa bộ lọc) vs 5xx (thử lại), via `presentApiError`
 */

/** Typing is applied after a pause, not per keystroke (core-data-list-query). */
const SEARCH_DEBOUNCE_MS = 300;

export function ProductListScreen() {
  // Phase 1 is single-tenant in the UI; E10.4 will read it from the session.
  const tenantId = DEMO_TENANT_ID;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchId = useId();

  const filter = useMemo(
    () => parseProductFilter(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const products = useCatalogProducts(tenantId, filter);
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

  const applyFilter = useCallback(
    (next: ProductFilter) => {
      const query = productSearchParams(next).toString();
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
      applyFilter({ status: filter.status, q: trimmed.length > 0 ? trimmed : null });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, filter.q, filter.status, applyFilter]);

  function clearFilters() {
    lastApplied.current = "";
    setDraft("");
    router.replace(pathname, { scroll: false });
  }

  function selectStatus(status: ProductFilterStatus | null) {
    applyFilter({ status, q: filter.q });
  }

  return (
    <section className="space-y-6" aria-labelledby="products-heading">
      <header className="space-y-1">
        <h1 id="products-heading" className="text-2xl font-semibold tracking-tight">
          Sản phẩm
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Dữ liệu của lần đồng bộ gần nhất: mã nào đăng được, mã nào bị chặn và vì sao. Tồn kho ở
          đây là thông tin nội bộ — không bao giờ đi vào caption.
        </p>
      </header>

      <ProductTotalsBar
        totals={totals}
        active={filter.status}
        onSelect={selectStatus}
        disabled={isFirstLoad}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-80 space-y-1.5">
          <label htmlFor={searchId} className="text-sm font-medium">
            Tìm theo mã hoặc tên
          </label>
          <Input
            id={searchId}
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="MGKVX6310 hoặc Giannal"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${searchId}-hint`}
          />
          <p id={`${searchId}-hint`} className="text-muted-foreground text-xs">
            Gõ xong đợi một nhịp là danh sách tự lọc. Bộ lọc nằm trong địa chỉ trang nên gửi link
            được.
          </p>
        </div>

        {hasFilter ? (
          <Button type="button" variant="ghost" onClick={clearFilters}>
            Bỏ bộ lọc
          </Button>
        ) : null}

        <Button
          type="button"
          variant="outline"
          onClick={() => void products.refetch()}
          disabled={products.isFetching}
        >
          {products.isFetching ? "Đang tải…" : "Tải lại"}
        </Button>
      </div>

      {isFirstLoad ? (showSkeleton ? <ProductTableSkeleton /> : null) : null}

      {products.isError && items.length === 0 ? (
        <ApiErrorNotice error={products.error} onRetry={() => void products.refetch()} />
      ) : null}

      {!isFirstLoad && !products.isError && items.length === 0 ? (
        hasFilter ? (
          <EmptyState
            kind="no-result"
            title="Không có sản phẩm nào khớp bộ lọc"
            description="Dữ liệu vẫn còn nguyên — chỉ là không có mã nào khớp từ khoá hoặc trạng thái đang chọn. Bỏ bộ lọc để xem toàn bộ danh sách."
            action={
              <Button type="button" variant="outline" onClick={clearFilters}>
                Bỏ bộ lọc
              </Button>
            }
          />
        ) : (
          <EmptyState
            kind="first-run"
            title="Chưa có sản phẩm nào trong hệ thống"
            description="Đơn vị này chưa đồng bộ lần nào, hoặc lần đồng bộ gần nhất không đọc được mã nào. Mở màn Đồng bộ dữ liệu, kiểm tra nguồn Drive/Sheet rồi chạy đồng bộ."
            action={
              <Button asChild>
                <Link href="/sync">Mở màn Đồng bộ dữ liệu</Link>
              </Button>
            }
          />
        )
      ) : null}

      {items.length > 0 ? (
        <>
          <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
            Đang hiển thị {formatCount(items.length)} / {formatCount(totals.total)} sản phẩm
            {filter.q ? ` khớp “${filter.q}”` : ""}.
          </p>

          <ProductTable items={items} />

          {products.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => void products.fetchNextPage()}
                disabled={products.isFetchingNextPage}
              >
                {products.isFetchingNextPage ? "Đang tải…" : "Tải thêm"}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-center text-sm">Đã hết danh sách.</p>
          )}
        </>
      ) : null}
    </section>
  );
}
