import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * The authorisation and transport boundary of `POST /api/catalog/file`
 * (onboarding phase 3 — the tenant hands us their product table as a CSV).
 *
 * What is proved here is only what this route decides. It deliberately does NOT
 * judge the file: the usecase reads the bytes through the same adapter the next
 * sync uses and refuses with its own Vietnamese sentence, so an `.xlsx` test
 * belongs there, not here. Duplicating it would be a second opinion free to
 * drift from the first.
 *
 * What this route DOES owe: admin/tier S before a single byte is read (it
 * replaces the source the next sync deletes rows against), a multipart body, a
 * file part, a transport size ceiling, and the actor's e-mail from the SESSION.
 */

const uploadCatalogFile = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { uploadCatalogFile, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { POST } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

/** Captured so a test can assert WHICH claim the route made (tier + minRole). */
let claim: { tier?: string; minRole?: string } = {};

function grantRole(role: OperatorRole): void {
  requireTenant.mockImplementation(
    (
      _session: unknown,
      _cookieTenantId: string | null,
      options: { tier: string; minRole?: OperatorRole },
    ) => {
      claim = { tier: options.tier, ...(options.minRole ? { minRole: options.minRole } : {}) };
      if (options.minRole && !roleAtLeast(role, options.minRole)) {
        throw new AppError("FORBIDDEN", { context: { required_role: options.minRole } });
      }
      return Promise.resolve({ tenantId: TENANT, role, membershipVersion: 1 });
    },
  );
}

function upload(form: FormData): Request {
  const headers = new Headers({ cookie: `${ACTIVE_TENANT_COOKIE}=${TENANT}` });
  return new Request("http://localhost/api/catalog/file", { method: "POST", headers, body: form });
}

function csvForm(overrides: { name?: string; type?: string; size?: number } = {}): FormData {
  const bytes = new Uint8Array(overrides.size ?? 64);
  const form = new FormData();
  form.set(
    "file",
    new File([bytes], overrides.name ?? "bang-gia-2026.csv", {
      type: overrides.type ?? "text/csv",
    }),
  );
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  claim = {};
  getOperatorSession.mockResolvedValue({ email: "boss@shop.vn", accountId: "acc-1" });
  uploadCatalogFile.mockResolvedValue({ source: {}, preview: {}, replaced: null });
  grantRole("admin");
});

describe("POST /api/catalog/file — refusals first", () => {
  it("403s an editor: replacing the product source is admin work", async () => {
    grantRole("editor");

    const response = await POST(upload(csvForm()));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    // Not one byte of the body was read.
    expect(uploadCatalogFile).not.toHaveBeenCalled();
  });

  it("claims tier S + admin — the membership is never served from a cache", async () => {
    await POST(upload(csvForm()));

    expect(claim).toEqual({ tier: "S", minRole: "admin" });
  });

  it("400s a body that is not multipart, without touching the usecase", async () => {
    const request = new Request("http://localhost/api/catalog/file", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${ACTIVE_TENANT_COOKIE}=${TENANT}` },
      body: JSON.stringify({ file: "not-a-file" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(uploadCatalogFile).not.toHaveBeenCalled();
  });

  it("400s a multipart body carrying no file part", async () => {
    const form = new FormData();
    form.set("delimiter", ";");

    const response = await POST(upload(form));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_INPUT" });
    expect(uploadCatalogFile).not.toHaveBeenCalled();
  });

  it("400s a file over the transport ceiling BEFORE buffering it", async () => {
    const response = await POST(upload(csvForm({ size: 9 * 1024 * 1024 })));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    // Names the actual size, not just "quá lớn" (core-file-upload).
    expect(body.message).toMatch(/9,0 MB/);
    expect(uploadCatalogFile).not.toHaveBeenCalled();
  });

  it("400s a delimiter override nobody could mean, instead of trimming it to fit", async () => {
    const form = csvForm();
    form.set("delimiter", ";;;;;;;;");

    const response = await POST(upload(form));

    expect(response.status).toBe(400);
    expect(uploadCatalogFile).not.toHaveBeenCalled();
  });
});

describe("POST /api/catalog/file — the write", () => {
  it("hands over the bytes, the name and the SESSION e-mail", async () => {
    await POST(upload(csvForm()));

    expect(uploadCatalogFile).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        fileName: "bang-gia-2026.csv",
        contentType: "text/csv",
        // From the session — a caller must not be able to write somebody else's
        // name into the audit trail.
        actorEmail: "boss@shop.vn",
      }),
    );
    const [input] = uploadCatalogFile.mock.calls[0] as [{ bytes: Uint8Array }];
    expect(input.bytes).toBeInstanceOf(Uint8Array);
    expect(input.bytes.length).toBe(64);
  });

  it("omits the delimiter entirely when none was pinned — absent means 'detect it'", async () => {
    await POST(upload(csvForm()));

    const [input] = uploadCatalogFile.mock.calls[0] as [Record<string, unknown>];
    expect("delimiter" in input).toBe(false);
  });

  it("forwards a pinned delimiter", async () => {
    const form = csvForm();
    form.set("delimiter", ";");

    await POST(upload(form));

    expect(uploadCatalogFile).toHaveBeenCalledWith(expect.objectContaining({ delimiter: ";" }));
  });

  /**
   * The declared type is a HINT and the route says so by forwarding it as one:
   * the bytes decide inside the usecase, so an .xlsx renamed to .csv is caught
   * there and explained there.
   */
  it("passes the browser's type through without acting on it", async () => {
    await POST(upload(csvForm({ name: "gian-lan.csv", type: "application/vnd.ms-excel" })));

    expect(uploadCatalogFile).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "application/vnd.ms-excel" }),
    );
  });

  it("returns the usecase's answer unchanged — preview and all", async () => {
    uploadCatalogFile.mockResolvedValue({
      source: { spreadsheetId: "", textSource: { kind: "file", fileName: "x.csv" } },
      preview: { columns: ["Mã"], rowCount: 3 },
      replaced: null,
    });

    const response = await POST(upload(csvForm()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      preview: { rowCount: 3 },
      source: { textSource: { kind: "file" } },
    });
  });

  it("maps a usecase refusal to its HTTP code and keeps its sentence", async () => {
    uploadCatalogFile.mockRejectedValue(
      new AppError("INVALID_INPUT", {
        message: "workbook",
        userMessage: "File này là bảng tính Excel, hệ thống chỉ đọc được CSV.",
      }),
    );

    const response = await POST(upload(csvForm({ name: "bang-gia.xlsx" })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_INPUT",
      message: "File này là bảng tính Excel, hệ thống chỉ đọc được CSV.",
    });
  });
});
