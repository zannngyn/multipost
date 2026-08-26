import { describe, expect, it, vi } from "vitest";

import { runDirectUpload, type DirectUploadServices } from "@/ui/hooks/useDirectUpload";
import type { TicketsResponse } from "@/ui/services/upload.api";
import type { UploadResponse } from "@/ui/schemas/compose.schema";

/**
 * I1 — `useDirectUpload` cannot be rendered outside React (no DOM/testing
 * library wired up here), so the ticket -> upload -> confirm orchestration is
 * exercised through `runDirectUpload`, the plain function the hook delegates
 * to. Its only job under test: BOTH stages' `rejected` lists must reach the
 * caller merged into one, never just the confirm stage's.
 */

function fakeFile(name: string, size = 10, type = "image/jpeg"): File {
  return { name, size, type } as File;
}

function noopProgress(): void {
  // Progress reporting is covered by direct-upload-queue.test.ts (nextProgress).
}

function fakeServices(overrides: Partial<DirectUploadServices> = {}): DirectUploadServices {
  return {
    requestUploadTickets: vi.fn(async () => ({ issued: [], rejected: [] }) satisfies TicketsResponse),
    postFileToStorage: vi.fn(async () => undefined),
    confirmUpload: vi.fn(
      async () => ({ accepted: [], rejected: [], warnings: [] }) satisfies UploadResponse,
    ),
    ...overrides,
  };
}

describe("runDirectUpload — I1 rejection merge", () => {
  it("surfaces a ticket-stage rejection alongside the accepted files, not silently", async () => {
    // 5 files dropped, one (an .exe renamed .jpg) refused before signing;
    // the other four get tickets, upload, and confirm cleanly.
    const files = [fakeFile("virus.jpg"), fakeFile("a.jpg"), fakeFile("b.jpg"), fakeFile("c.jpg"), fakeFile("d.jpg")];
    const tickets: TicketsResponse = {
      issued: [1, 2, 3, 4].map((sourceIndex) => ({
        assetId: `asset_${sourceIndex}`,
        fileName: files[sourceIndex].name,
        sourceIndex,
        postUrl: "https://minio.local/upload",
        formFields: {},
        expiresAt: new Date().toISOString(),
      })),
      rejected: [
        {
          fileName: "virus.jpg",
          reason: "UNSUPPORTED_TYPE",
          userMessage: 'Nội dung file "virus.jpg" không khớp định dạng khai báo — file bị từ chối.',
        },
      ],
    };
    const confirmed: UploadResponse = {
      accepted: [1, 2, 3, 4].map((sourceIndex) => ({
        assetId: `asset_${sourceIndex}`,
        fileName: files[sourceIndex].name,
        kind: "image" as const,
        sequence: sourceIndex,
        sizeBytes: 10,
      })),
      rejected: [],
      warnings: [],
    };
    const services = fakeServices({
      requestUploadTickets: vi.fn(async () => tickets),
      confirmUpload: vi.fn(async () => confirmed),
    });

    const result = await runDirectUpload(
      { productCode: "MG0AD6112", files },
      noopProgress,
      new AbortController(),
      services,
    );

    // This is the assertion that fails without the I1 fix: before it, the
    // hook returned ONLY `confirmed.rejected` ([]), losing "virus.jpg" with
    // no message reaching the operator at all.
    expect(result.rejected).toEqual([
      expect.objectContaining({ fileName: "virus.jpg", reason: "UNSUPPORTED_TYPE" }),
    ]);
    expect(result.accepted).toHaveLength(4);
  });

  it("keeps both stages' rejections, ticket stage first", async () => {
    const files = [fakeFile("ok.jpg"), fakeFile("bad-ext.exe")];
    const tickets: TicketsResponse = {
      issued: [
        {
          assetId: "asset_0",
          fileName: "ok.jpg",
          sourceIndex: 0,
          postUrl: "https://minio.local/upload",
          formFields: {},
          expiresAt: new Date().toISOString(),
        },
      ],
      rejected: [{ fileName: "bad-ext.exe", reason: "UNSUPPORTED_TYPE", userMessage: "Định dạng không được hỗ trợ." }],
    };
    const confirmed: UploadResponse = {
      accepted: [],
      rejected: [{ fileName: "ok.jpg", reason: "UNSUPPORTED_TYPE", userMessage: "Nội dung không khớp định dạng." }],
      warnings: [],
    };
    const services = fakeServices({
      requestUploadTickets: vi.fn(async () => tickets),
      confirmUpload: vi.fn(async () => confirmed),
    });

    const result = await runDirectUpload(
      { productCode: "MG0AD6112", files },
      noopProgress,
      new AbortController(),
      services,
    );

    expect(result.rejected.map((r) => r.fileName)).toEqual(["bad-ext.exe", "ok.jpg"]);
  });

  it("does not call confirmUpload when every file was refused at the ticket stage", async () => {
    const files = [fakeFile("virus.exe")];
    const tickets: TicketsResponse = {
      issued: [],
      rejected: [{ fileName: "virus.exe", reason: "UNSUPPORTED_TYPE", userMessage: "Định dạng không được hỗ trợ." }],
    };
    const confirmUpload = vi.fn(async () => {
      throw new Error("confirmUpload must not be called with an empty album");
    });
    const services = fakeServices({
      requestUploadTickets: vi.fn(async () => tickets),
      confirmUpload,
    });

    const result = await runDirectUpload(
      { productCode: "MG0AD6112", files },
      noopProgress,
      new AbortController(),
      services,
    );

    expect(confirmUpload).not.toHaveBeenCalled();
    expect(result).toEqual({
      accepted: [],
      rejected: [{ fileName: "virus.exe", reason: "UNSUPPORTED_TYPE", userMessage: "Định dạng không được hỗ trợ." }],
      warnings: [],
    });
  });

  it("aborts the remaining uploads and rethrows the real cause when one POST fails", async () => {
    const files = [fakeFile("a.jpg"), fakeFile("b.jpg")];
    const tickets: TicketsResponse = {
      issued: [0, 1].map((sourceIndex) => ({
        assetId: `asset_${sourceIndex}`,
        fileName: files[sourceIndex].name,
        sourceIndex,
        postUrl: "https://minio.local/upload",
        formFields: {},
        expiresAt: new Date().toISOString(),
      })),
      rejected: [],
    };
    const postFailure = new Error("network down");
    const services = fakeServices({
      requestUploadTickets: vi.fn(async () => tickets),
      postFileToStorage: vi.fn(async () => {
        throw postFailure;
      }),
    });
    const controller = new AbortController();

    await expect(
      runDirectUpload({ productCode: "MG0AD6112", files }, noopProgress, controller, services),
    ).rejects.toBe(postFailure);
    expect(controller.signal.aborted).toBe(true);
    expect(services.confirmUpload).not.toHaveBeenCalled();
  });
});
