import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/ui/services/api-error";
import { confirmUpload, requestUploadTickets } from "@/ui/services/upload.api";

/**
 * Stage 1/3 of the direct-to-storage upload path (I1 fix). Two things under
 * test:
 *   - the edge-case guards each function runs BEFORE ever touching the
 *     network (CLAUDE.md rule 1);
 *   - the wire contract itself: a ticket response carrying one rejection
 *     alongside N accepted files parses and comes back with that rejection
 *     intact — this is the shape `useDirectUpload.test.ts` then proves
 *     actually reaches the operator.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestUploadTickets — edge cases first", () => {
  it("throws without touching the network when productCode is blank", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(() =>
      requestUploadTickets({ productCode: "  ", files: [{ fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10 }] }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws without touching the network when there are no files", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(() => requestUploadTickets({ productCode: "MG0AD6112", files: [] })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("I1: a response carrying one rejection plus N accepted files parses with the rejection intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          issued: [1, 2, 3, 4].map((sourceIndex) => ({
            assetId: `asset_${sourceIndex}`,
            fileName: `photo-${sourceIndex}.jpg`,
            sourceIndex,
            postUrl: "https://minio.local/upload",
            formFields: { key: `staging/tenant/asset_${sourceIndex}` },
            expiresAt: new Date().toISOString(),
          })),
          rejected: [
            {
              fileName: "virus.jpg",
              reason: "UNSUPPORTED_TYPE",
              userMessage: 'Nội dung file "virus.jpg" không khớp định dạng khai báo — file bị từ chối.',
            },
          ],
        }),
      ),
    );

    const result = await requestUploadTickets({
      productCode: "MG0AD6112",
      files: [
        { fileName: "virus.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
        { fileName: "photo-1.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
        { fileName: "photo-2.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
        { fileName: "photo-3.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
        { fileName: "photo-4.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
      ],
    });

    expect(result.issued).toHaveLength(4);
    expect(result.rejected).toEqual([
      expect.objectContaining({ fileName: "virus.jpg", reason: "UNSUPPORTED_TYPE" }),
    ]);
  });

  it("raises MALFORMED_RESPONSE when the server drops the rejected field entirely", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { issued: [] })));

    await expect(
      requestUploadTickets({ productCode: "MG0AD6112", files: [{ fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10 }] }),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });
});

describe("confirmUpload — edge cases first", () => {
  it("throws without touching the network when productCode is blank", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(() => confirmUpload({ productCode: "", assets: [{ assetId: "a1" }] })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws without touching the network when there are no assets", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(() => confirmUpload({ productCode: "MG0AD6112", assets: [] })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces the server's rejected list unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          accepted: [{ assetId: "a1", fileName: "a.jpg", kind: "image", sequence: 1, sizeBytes: 10 }],
          rejected: [{ fileName: "b.jpg", reason: "UNSUPPORTED_TYPE", userMessage: "Nội dung không khớp." }],
          warnings: [],
        }),
      ),
    );

    const result = await confirmUpload({
      productCode: "MG0AD6112",
      assets: [{ assetId: "a1" }, { assetId: "a2" }],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([
      expect.objectContaining({ fileName: "b.jpg", reason: "UNSUPPORTED_TYPE" }),
    ]);
  });

  it("maps a server 4xx into an ApiError carrying the Vietnamese message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, { code: "INVALID_INPUT", message: "Chưa có file nào để xác nhận." }),
      ),
    );

    const error = await confirmUpload({ productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }).catch(
      (e: unknown) => e,
    );

    expect(ApiError.is(error)).toBe(true);
    expect((error as ApiError).userMessage).toBe("Chưa có file nào để xác nhận.");
  });
});
