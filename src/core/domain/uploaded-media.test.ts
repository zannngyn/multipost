import { describe, expect, it } from "vitest";

import {
  MAX_UPLOADS_PER_POST,
  MAX_UPLOAD_BYTES,
  applyUploadOrder,
  validateUpload,
  type UploadCandidate,
} from "@/core/domain/uploaded-media";

function candidate(patch: Partial<UploadCandidate> = {}): UploadCandidate {
  return { fileName: "anh.jpg", mimeType: "image/jpeg", sizeBytes: 1024, ...patch };
}

describe("validateUpload — edge cases", () => {
  it("rejects a missing file name", () => {
    const verdict = validateUpload(candidate({ fileName: "   " }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejection.reason).toBe("EMPTY_FILE_NAME");
  });

  it("rejects a zero-byte file", () => {
    const verdict = validateUpload(candidate({ sizeBytes: 0 }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejection.reason).toBe("EMPTY_FILE");
  });

  it("rejects a negative or non-finite size", () => {
    for (const sizeBytes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const verdict = validateUpload(candidate({ sizeBytes }));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.rejection.reason).toBe("EMPTY_FILE");
    }
  });

  it("rejects a type the platforms do not accept", () => {
    for (const mimeType of ["application/pdf", "text/html", "image/svg+xml", ""]) {
      const verdict = validateUpload(candidate({ mimeType }));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.rejection.reason).toBe("UNSUPPORTED_TYPE");
    }
  });

  it("rejects a file bigger than the signed media bridge can serve", () => {
    const verdict = validateUpload(candidate({ sizeBytes: MAX_UPLOAD_BYTES + 1 }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.rejection.reason).toBe("TOO_LARGE");
      // Business rule 5: the operator must be able to act on the message.
      expect(verdict.rejection.userMessage).toMatch(/MB/);
    }
  });

  it("accepts a file exactly at the limit", () => {
    expect(validateUpload(candidate({ sizeBytes: MAX_UPLOAD_BYTES })).ok).toBe(true);
  });

  it("does not trust the extension over the declared type", () => {
    // A .jpg carrying video/mp4 is a video, not an image: the album kind drives
    // the whole publish path, so it must come from one source only.
    const verdict = validateUpload(candidate({ fileName: "clip.jpg", mimeType: "video/mp4" }));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.kind).toBe("video");
  });
});

describe("validateUpload — accepted types", () => {
  it("accepts the image types both platforms take", () => {
    for (const mimeType of ["image/jpeg", "image/png", "image/webp"]) {
      const verdict = validateUpload(candidate({ mimeType }));
      expect(verdict.ok).toBe(true);
      if (verdict.ok) expect(verdict.kind).toBe("image");
    }
  });

  it("accepts mp4 and quicktime video", () => {
    for (const mimeType of ["video/mp4", "video/quicktime"]) {
      const verdict = validateUpload(candidate({ mimeType }));
      expect(verdict.ok).toBe(true);
      if (verdict.ok) expect(verdict.kind).toBe("video");
    }
  });

  it("ignores charset parameters and casing on the mime type", () => {
    const verdict = validateUpload(candidate({ mimeType: "IMAGE/JPEG; charset=binary" }));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.kind).toBe("image");
  });
});

describe("applyUploadOrder", () => {
  const items = ["a", "b", "c"];

  it("reorders by the given index list — index 0 is the cover", () => {
    expect(applyUploadOrder(items, [2, 0, 1])).toEqual(["c", "a", "b"]);
  });

  it("keeps the original order when no order is given", () => {
    expect(applyUploadOrder(items, undefined)).toEqual(["a", "b", "c"]);
  });

  it("rejects an order that is not a permutation", () => {
    // Dropping or duplicating an entry would silently publish a different album
    // than the operator arranged — business rule 5.
    expect(() => applyUploadOrder(items, [0, 1])).toThrow();
    expect(() => applyUploadOrder(items, [0, 1, 1])).toThrow();
    expect(() => applyUploadOrder(items, [0, 1, 3])).toThrow();
    expect(() => applyUploadOrder(items, [-1, 0, 1])).toThrow();
  });

  it("rejects an empty album", () => {
    expect(() => applyUploadOrder([], [])).toThrow();
  });

  it("rejects more files than one post may carry", () => {
    const many = Array.from({ length: MAX_UPLOADS_PER_POST + 1 }, (_, index) => String(index));
    expect(() => applyUploadOrder(many, undefined)).toThrow();
  });
});
