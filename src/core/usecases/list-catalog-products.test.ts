import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type {
  CatalogProductPage,
  CatalogProductRow,
  CatalogReadRepo,
  CatalogSignalGroup,
  ListCatalogProductsQuery,
} from "@/core/ports/product-repo";

import { makeListCatalogProducts } from "./list-catalog-products";

const TENANT = "00000000-0000-0000-0000-000000000001";

function makeLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function row(overrides: Partial<CatalogProductRow> & { code: string }): CatalogProductRow {
  return {
    name: `Tên ${overrides.code}`,
    category: "Áo cộc tay",
    season: "Xuân hè 2026",
    stockRaw: "10",
    noteRaw: "",
    hasConflict: false,
    mediaImageCount: 3,
    mediaVideoCount: 0,
    ...overrides,
  };
}

/**
 * Fake repo over an in-memory catalog. It implements the SAME contract the
 * Drizzle repo does — search, keyset, limit+1 — so the paging logic under test
 * is exercised for real instead of against a stub that always says "no more".
 */
function makeCatalog(rows: readonly CatalogProductRow[]): CatalogReadRepo & { calls: number } {
  const sorted = [...rows].sort((a, b) => a.code.localeCompare(b.code));
  const matches = (item: CatalogProductRow, search?: string): boolean => {
    if (!search) return true;
    const needle = search.toLowerCase();
    return (
      item.code.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle)
    );
  };

  const repo = {
    calls: 0,
    async listCatalog(query: ListCatalogProductsQuery): Promise<CatalogProductPage> {
      repo.calls += 1;
      const filtered = sorted.filter(
        (item) =>
          matches(item, query.search) &&
          (query.afterCode === undefined || item.code > query.afterCode),
      );
      const page = filtered.slice(0, query.limit);
      const hasMore = filtered.length > query.limit;
      return {
        items: page,
        nextAfterCode: hasMore ? (page[page.length - 1]?.code ?? null) : null,
      };
    },
    async aggregateCatalog(query: {
      tenantId: string;
      search?: string;
    }): Promise<readonly CatalogSignalGroup[]> {
      const buckets = new Map<string, CatalogSignalGroup>();
      for (const item of sorted) {
        if (!matches(item, query.search)) continue;
        const hasMedia = item.mediaImageCount + item.mediaVideoCount > 0;
        const key = `${item.stockRaw}|${item.noteRaw}|${item.hasConflict}|${hasMedia}`;
        const existing = buckets.get(key);
        buckets.set(key, {
          stockRaw: item.stockRaw,
          noteRaw: item.noteRaw,
          hasConflict: item.hasConflict,
          hasMedia,
          count: (existing?.count ?? 0) + 1,
        });
      }
      return [...buckets.values()];
    },
  };
  return repo;
}

/** One of each verdict the screen has to show. */
const CATALOG: readonly CatalogProductRow[] = [
  row({ code: "MG0AC0001", stockRaw: "104" }), // ok
  row({ code: "MG0AC0002", stockRaw: "2" }), // ok, low stock
  row({ code: "MR0AC6080", stockRaw: "0", noteRaw: "HẾT HÀNG" }), // blocked: sold out
  row({ code: "MR0AC6081", stockRaw: "" }), // blocked: empty stock
  row({ code: "MR0AC6082", stockRaw: "vài cái" }), // blocked: not a number
  row({ code: "MRKSQ6066", stockRaw: "39", hasConflict: true }), // blocked: conflict
  row({ code: "MR0QD6101", stockRaw: "5", mediaImageCount: 0, mediaVideoCount: 0 }), // no media
];

describe("listCatalogProducts — edge cases first", () => {
  it.each([undefined, null, "", "   ", "nope", 7])(
    "rejects a malformed tenant id (%p)",
    async (tenantId) => {
      const list = makeListCatalogProducts({ catalog: makeCatalog([]), logger: makeLogger() });
      await expect(list({ tenantId: tenantId as unknown as string })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    },
  );

  it("rejects an unknown status filter instead of silently returning everything", async () => {
    const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });
    await expect(
      list({ tenantId: TENANT, filter: { status: "OK" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "status" } });
    await expect(
      list({ tenantId: TENANT, filter: { status: "everything" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it.each([0, -1, 1.5, "20", Number.NaN])("rejects a bad limit (%p)", async (limit) => {
    const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });
    await expect(
      list({ tenantId: TENANT, filter: { limit: limit as unknown as number } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "limit" } });
  });

  it("caps the limit at 100 rather than trusting the caller", async () => {
    const catalog = makeCatalog(CATALOG);
    const list = makeListCatalogProducts({ catalog, logger: makeLogger() });
    const spy = vi.spyOn(catalog, "listCatalog");
    await list({ tenantId: TENANT, filter: { limit: 5000 } });
    expect(spy.mock.calls[0]?.[0].limit).toBeLessThanOrEqual(200);
  });

  it.each(["", "   ", null, undefined])(
    "treats an empty cursor (%p) as 'first page'",
    async (cursor) => {
      const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });
      const result = await list({ tenantId: TENANT, filter: { cursor } });
      expect(result.items[0]?.code).toBe("MG0AC0001");
    },
  );

  it.each(["a b", "'; drop table product; --", "x".repeat(65), "MG0AC0001%", "../etc"])(
    "rejects a junk cursor (%p) instead of restarting the list",
    async (cursor) => {
      const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });
      await expect(list({ tenantId: TENANT, filter: { cursor } })).rejects.toMatchObject({
        code: "INVALID_INPUT",
        context: { field: "cursor" },
      });
    },
  );

  it("returns an empty page and zero totals when the tenant has no products", async () => {
    const list = makeListCatalogProducts({ catalog: makeCatalog([]), logger: makeLogger() });
    await expect(list({ tenantId: TENANT })).resolves.toEqual({
      items: [],
      nextCursor: null,
      totals: { total: 0, ok: 0, blocked: 0 },
    });
  });

  it("lets a repository failure through with its own code", async () => {
    const catalog = makeCatalog(CATALOG);
    vi.spyOn(catalog, "aggregateCatalog").mockRejectedValueOnce(
      new AppError("DB_ERROR", { message: "connection lost" }),
    );
    const list = makeListCatalogProducts({ catalog, logger: makeLogger() });
    await expect(list({ tenantId: TENANT })).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("survives rows with missing/odd fields instead of throwing on one bad product", async () => {
    const broken = [
      { code: "MG0AC0009" } as unknown as CatalogProductRow,
      row({ code: "MG0AC0010", mediaImageCount: "4" as unknown as number }),
    ];
    const list = makeListCatalogProducts({ catalog: makeCatalog(broken), logger: makeLogger() });
    const result = await list({ tenantId: TENANT });
    expect(result.items[0]).toMatchObject({
      code: "MG0AC0009",
      name: "",
      composable: false,
      inventory: { status: "blocked", reason: "STOCK_EMPTY" },
    });
    expect(result.items[1]).toMatchObject({ mediaImageCount: 4, composable: true });
  });
});

describe("listCatalogProducts — verdicts", () => {
  it("marks a stocked code with photos as composable and gives no reason", async () => {
    const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });
    const { items } = await list({ tenantId: TENANT });
    const entry = items.find((item) => item.code === "MG0AC0001");
    expect(entry).toMatchObject({
      composable: true,
      blockedReason: null,
      inventory: { status: "in_stock", stock: 104, reason: null },
      mediaImageCount: 3,
      mediaVideoCount: 0,
    });
  });

  it("keeps low stock composable but reports it through the inventory status", async () => {
    const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });
    const { items } = await list({ tenantId: TENANT });
    const entry = items.find((item) => item.code === "MG0AC0002");
    expect(entry?.composable).toBe(true);
    expect(entry?.inventory.status).toBe("low_stock");
    expect(entry?.inventory.operatorMessage).toContain("Tồn thấp");
  });

  it("blocks a conflicting code FIRST, even though its stock reads fine", async () => {
    const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });
    const { items } = await list({ tenantId: TENANT });
    const entry = items.find((item) => item.code === "MRKSQ6066");
    expect(entry).toMatchObject({
      hasConflict: true,
      composable: false,
      blockedReason: {
        code: "SHEET_ROW_INVALID",
        userMessage: "2 dòng Sheet xung đột — sửa Sheet rồi đồng bộ lại",
      },
    });
    expect(entry?.inventory.reason).toBe("SHEET_ROW_CONFLICT");
  });

  it("reports the decision-table reason for each stock block", async () => {
    const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });
    const { items } = await list({ tenantId: TENANT });
    const byCode = new Map(items.map((item) => [item.code, item]));
    expect(byCode.get("MR0AC6080")?.inventory.reason).toBe("NOTE_SOLD_OUT");
    expect(byCode.get("MR0AC6081")?.inventory.reason).toBe("STOCK_EMPTY");
    expect(byCode.get("MR0AC6082")?.inventory.reason).toBe("STOCK_NOT_A_NUMBER");
    for (const code of ["MR0AC6080", "MR0AC6081", "MR0AC6082"]) {
      expect(byCode.get(code)?.blockedReason?.code).toBe("OUT_OF_STOCK");
      expect(byCode.get(code)?.composable).toBe(false);
    }
  });

  it("blocks a stocked code that has no media, with MEDIA_NOT_FOUND", async () => {
    const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });
    const { items } = await list({ tenantId: TENANT });
    const entry = items.find((item) => item.code === "MR0QD6101");
    expect(entry).toMatchObject({
      composable: false,
      inventory: { status: "in_stock" },
      blockedReason: { code: "MEDIA_NOT_FOUND" },
    });
  });

  it("counts a video-only product as having media", async () => {
    const catalog = makeCatalog([
      row({ code: "MG0VD0001", mediaImageCount: 0, mediaVideoCount: 2 }),
    ]);
    const list = makeListCatalogProducts({ catalog, logger: makeLogger() });
    const { items, totals } = await list({ tenantId: TENANT });
    expect(items[0]?.composable).toBe(true);
    expect(totals).toEqual({ total: 1, ok: 1, blocked: 0 });
  });
});

describe("listCatalogProducts — filters, totals and paging", () => {
  it("counts totals over the whole search result, not over the page", async () => {
    const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });
    const result = await list({ tenantId: TENANT, filter: { limit: 2 } });
    expect(result.items).toHaveLength(2);
    expect(result.totals).toEqual({ total: 7, ok: 2, blocked: 5 });
  });

  it("status=ok returns only composable products", async () => {
    const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });
    const result = await list({ tenantId: TENANT, filter: { status: "ok" } });
    expect(result.items.map((item) => item.code)).toEqual(["MG0AC0001", "MG0AC0002"]);
    expect(result.items.every((item) => item.composable)).toBe(true);
    // Totals describe the catalog, so the counters stay stable while filtering.
    expect(result.totals).toEqual({ total: 7, ok: 2, blocked: 5 });
  });

  it("status=blocked returns exactly the complement", async () => {
    const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });
    const result = await list({ tenantId: TENANT, filter: { status: "blocked" } });
    expect(result.items.map((item) => item.code)).toEqual([
      "MR0AC6080",
      "MR0AC6081",
      "MR0AC6082",
      "MR0QD6101",
      "MRKSQ6066",
    ]);
    expect(result.items.every((item) => item.blockedReason !== null)).toBe(true);
  });

  it("searches code and name, and passes the raw text to the repository", async () => {
    const catalog = makeCatalog(CATALOG);
    const spy = vi.spyOn(catalog, "listCatalog");
    const list = makeListCatalogProducts({ catalog, logger: makeLogger() });

    const byCode = await list({ tenantId: TENANT, filter: { q: "  mrkSQ " } });
    expect(byCode.items.map((item) => item.code)).toEqual(["MRKSQ6066"]);
    expect(byCode.totals).toEqual({ total: 1, ok: 0, blocked: 1 });
    // Trimmed but NOT escaped here: escaping is the adapter's job (it knows the
    // dialect), and double-escaping would break the search.
    expect(spy.mock.calls[0]?.[0].search).toBe("mrkSQ");

    const byName = await list({ tenantId: TENANT, filter: { q: "Tên MR0QD6101" } });
    expect(byName.items.map((item) => item.code)).toEqual(["MR0QD6101"]);
  });

  it("passes LIKE metacharacters through untouched for the adapter to escape", async () => {
    const catalog = makeCatalog(CATALOG);
    const spy = vi.spyOn(catalog, "listCatalog");
    const list = makeListCatalogProducts({ catalog, logger: makeLogger() });
    await list({ tenantId: TENANT, filter: { q: "50%_x" } });
    expect(spy.mock.calls[0]?.[0].search).toBe("50%_x");
  });

  it("pages with a keyset cursor and stops with nextCursor=null", async () => {
    const list = makeListCatalogProducts({ catalog: makeCatalog(CATALOG), logger: makeLogger() });

    const first = await list({ tenantId: TENANT, filter: { limit: 3 } });
    expect(first.items.map((item) => item.code)).toEqual([
      "MG0AC0001",
      "MG0AC0002",
      "MR0AC6080",
    ]);
    expect(first.nextCursor).toBe("MR0AC6080");

    const second = await list({
      tenantId: TENANT,
      filter: { limit: 3, cursor: first.nextCursor },
    });
    expect(second.items.map((item) => item.code)).toEqual([
      "MR0AC6081",
      "MR0AC6082",
      "MR0QD6101",
    ]);

    const third = await list({
      tenantId: TENANT,
      filter: { limit: 3, cursor: second.nextCursor },
    });
    expect(third.items.map((item) => item.code)).toEqual(["MRKSQ6066"]);
    expect(third.nextCursor).toBeNull();
  });

  it("never repeats or skips a product when a filter empties whole pages", async () => {
    const many: CatalogProductRow[] = [];
    for (let index = 0; index < 120; index += 1) {
      const code = `MG0AC${String(index).padStart(4, "0")}`;
      // Only every 20th product is composable: the status filter has to scan
      // several repository pages to fill one page of results.
      many.push(index % 20 === 0 ? row({ code }) : row({ code, stockRaw: "0" }));
    }
    const list = makeListCatalogProducts({ catalog: makeCatalog(many), logger: makeLogger() });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result: Awaited<ReturnType<typeof list>> = await list({
        tenantId: TENANT,
        filter: { status: "ok", limit: 2, cursor },
      });
      seen.push(...result.items.map((item) => item.code));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual([
      "MG0AC0000",
      "MG0AC0020",
      "MG0AC0040",
      "MG0AC0060",
      "MG0AC0080",
      "MG0AC0100",
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("keeps the page short (with a cursor) rather than scanning forever", async () => {
    // 4,000 blocked products and nothing composable: the scan cap must stop it.
    const many = Array.from({ length: 4000 }, (_, index) =>
      row({ code: `MG0AC${String(index).padStart(5, "0")}`, stockRaw: "0" }),
    );
    const catalog = makeCatalog(many);
    const logger = makeLogger();
    const list = makeListCatalogProducts({ catalog, logger });

    const result = await list({ tenantId: TENANT, filter: { status: "ok", limit: 50 } });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).not.toBeNull();
    expect(catalog.calls).toBeLessThanOrEqual(20);
    expect(logger.warn).toHaveBeenCalled();
  });
});
