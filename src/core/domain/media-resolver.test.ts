import { describe, expect, it } from "vitest";

import { codeFromFolderName, resolveMedia, type MediaSourceFile } from "./media-resolver";
import type { MediaProfile } from "./media-profile";

/**
 * The strategy selector (phase 2). Every case here is a shape a real customer
 * folder has: one folder per code, free file names, a link column, and the
 * mixtures in between.
 */

const CODES = ["MGKVX6310", "MG0VS6111", "MR0AC6080"];

function file(partial: Partial<MediaSourceFile> & { id: string; name: string }): MediaSourceFile {
  return {
    mimeType: "image/jpeg",
    sizeBytes: 1000,
    modifiedTime: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

describe("resolveMedia — edge cases first", () => {
  it("returns an empty result for an empty, missing or malformed file list", () => {
    for (const files of [[], undefined, null, "nope"]) {
      const result = resolveMedia({ files: files as unknown as MediaSourceFile[] });
      expect(result.assets).toEqual([]);
      expect(result.rejected).toEqual([]);
      expect(result.profileKind).toBe("code-color-seq");
    }
  });

  it("drops entries without an id or a name instead of building half an asset", () => {
    const result = resolveMedia({
      files: [
        { id: "", name: "MG0VS6111-KEM (6).png" },
        { id: "f2", name: "" },
        file({ id: "f3", name: "MG0VS6111-KEM (7).png" }),
      ] as MediaSourceFile[],
    });
    expect(result.assets.map((asset) => asset.driveFileId)).toEqual(["f3"]);
  });

  it("an unknown profile kind falls back to the internal convention", () => {
    const result = resolveMedia({
      profile: { kind: "drive-magic" } as unknown as MediaProfile,
      files: [file({ id: "f1", name: "MG0VS6111-KEM (6).png" })],
    });
    expect(result.profileKind).toBe("code-color-seq");
    expect(result.assets).toHaveLength(1);
  });
});

describe("code-color-seq (default) — unchanged behaviour", () => {
  it("builds an asset per file and reports the ones it drops", () => {
    const result = resolveMedia({
      files: [
        file({ id: "f1", name: "MR0AC6080-TRẮNG TIÊU-AI (1).jpg" }),
        file({ id: "f2", name: "IMG_1664.JPG" }),
      ],
    });

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      driveFileId: "f1",
      productCode: "MR0AC6080",
      color: "TRẮNG TIÊU",
      sequence: 1,
      kind: "image",
      needsReview: false,
    });
    expect(result.rejected).toEqual([
      expect.objectContaining({ reason: "NO_PRODUCT_CODE", ref: "IMG_1664.JPG" }),
    ]);
  });

  it("keeps an outfit-set photo and puts it on the review list", () => {
    const result = resolveMedia({
      files: [file({ id: "f1", name: "MG0AD6051-MR0CV6068-AI (2).jpg" })],
    });
    expect(result.assets[0].productCode).toBe("MG0AD6051");
    expect(result.reviews[0]).toMatchObject({ reason: "MULTIPLE_PRODUCT_CODES" });
  });

  it("falls back to the Drive mime type when the name has no extension", () => {
    const result = resolveMedia({
      files: [file({ id: "f1", name: "MGKVX6310-KEM-AI", mimeType: "video/mp4" })],
    });
    expect(result.assets[0].kind).toBe("video");
    expect(result.assets[0].needsReview).toBe(true);
  });
});

describe("folder-per-code", () => {
  const profile: MediaProfile = { kind: "folder-per-code" };

  it("takes the code from the folder and the colour from the name", () => {
    const result = resolveMedia({
      profile,
      knownCodes: CODES,
      files: [
        file({ id: "f1", name: "KEM (6).png", folderPath: ["MG0VS6111"], parentFolderId: "d1" }),
        file({ id: "f2", name: "IMG_1664.JPG", folderPath: ["MG0VS6111"], parentFolderId: "d1" }),
      ],
    });

    expect(result.assets).toHaveLength(2);
    expect(result.assets[0]).toMatchObject({ productCode: "MG0VS6111", color: "KEM", sequence: 6 });
    // The second file says nothing — still imported, simply without a colour.
    expect(result.assets[1]).toMatchObject({ productCode: "MG0VS6111", color: null });
    expect(result.rejected).toEqual([]);
  });

  it("uses the FIRST path segment, so a grouping sub-folder does not rename the product", () => {
    const result = resolveMedia({
      profile,
      knownCodes: CODES,
      files: [
        file({ id: "f1", name: "1.jpg", folderPath: ["MGKVX6310", "ảnh thực tế"] }),
      ],
    });
    expect(result.assets[0].productCode).toBe("MGKVX6310");
  });

  it("finds the code inside a longer folder name", () => {
    const result = resolveMedia({
      profile,
      knownCodes: CODES,
      files: [file({ id: "f1", name: "a.jpg", folderPath: ["MGKVX6310 - Váy hoa nhí"] })],
    });
    expect(result.assets[0].productCode).toBe("MGKVX6310");
    expect(result.reviews).toEqual([]);
  });

  it("rejects a file sitting in the root, where no folder can name it", () => {
    const result = resolveMedia({
      profile,
      knownCodes: CODES,
      files: [file({ id: "f1", name: "a.jpg", folderPath: [] }), file({ id: "f2", name: "b.jpg" })],
    });
    expect(result.assets).toEqual([]);
    expect(result.rejected.map((issue) => issue.reason)).toEqual([
      "NO_FOLDER_CODE",
      "NO_FOLDER_CODE",
    ]);
    expect(result.rejected[0].detail).toContain("thư mục gốc");
  });

  it("uses an unknown folder name as the code but says so ONCE per folder", () => {
    const result = resolveMedia({
      profile,
      knownCodes: CODES,
      files: [
        file({ id: "f1", name: "a.jpg", folderPath: ["VAY-HOA-2026"] }),
        file({ id: "f2", name: "b.jpg", folderPath: ["VAY-HOA-2026"] }),
      ],
    });
    expect(result.assets.map((asset) => asset.productCode)).toEqual(["VAY-HOA-2026", "VAY-HOA-2026"]);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]).toMatchObject({ reason: "CODE_FROM_FOLDER_NAME", ref: "VAY-HOA-2026" });
  });

  it("refuses a folder name that is a sentence, not a code", () => {
    const long = "Ảnh chụp bộ sưu tập xuân hè 2026 của cửa hàng số 1 tại Hà Nội và các tỉnh";
    const result = resolveMedia({
      profile,
      knownCodes: CODES,
      files: [file({ id: "f1", name: "a.jpg", folderPath: [long] })],
    });
    expect(result.assets).toEqual([]);
    expect(result.rejected[0].reason).toBe("NO_FOLDER_CODE");
  });
});

describe("codeFromFolderName", () => {
  const known = new Set(CODES);

  it("returns null for an empty name", () => {
    expect(codeFromFolderName("   ", known)).toBeNull();
  });

  it("prefers a known code, then the internal pattern, then the folder name", () => {
    expect(codeFromFolderName("mgkvx6310", known)).toEqual({
      code: "MGKVX6310",
      source: "known",
    });
    expect(codeFromFolderName("MMAC546 (mới)", new Set())).toEqual({
      code: "MMAC546",
      source: "pattern",
    });
    expect(codeFromFolderName("Tu-Go-01", new Set())).toEqual({
      code: "TU-GO-01",
      source: "folder-name",
    });
  });
});

describe("sheet-column", () => {
  const profile: MediaProfile = { kind: "sheet-column" };

  it("says the column is empty instead of dropping 5,000 files one by one", () => {
    const result = resolveMedia({
      profile,
      files: [file({ id: "f1", name: "a.jpg" })],
      mediaLinks: [],
    });
    expect(result.assets).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("MEDIA_LINK_COLUMN_EMPTY");
  });

  it("attaches a file linked by id, with no file-name parsing at all", () => {
    const result = resolveMedia({
      profile,
      files: [file({ id: "1AbCdEfGhIjKlMnOp", name: "IMG_1664.JPG", parentFolderId: "root" })],
      mediaLinks: [
        {
          code: "sp-001",
          value: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing",
        },
      ],
    });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      productCode: "SP-001",
      driveFileId: "1AbCdEfGhIjKlMnOp",
      color: null,
      needsReview: false,
    });
  });

  it("attaches every file of a linked FOLDER", () => {
    const result = resolveMedia({
      profile,
      files: [
        file({ id: "f1", name: "1.jpg", parentFolderId: "1FolderIdAbCdEfGh" }),
        file({ id: "f2", name: "2.jpg", parentFolderId: "1FolderIdAbCdEfGh" }),
        file({ id: "f3", name: "3.jpg", parentFolderId: "other" }),
      ],
      mediaLinks: [
        { code: "SP-001", value: "https://drive.google.com/drive/folders/1FolderIdAbCdEfGh" },
      ],
    });
    expect(result.assets.map((asset) => asset.driveFileId)).toEqual(["f1", "f2"]);
    // The unused file is reported once, as a count — not as 1 issue per file.
    expect(result.reviews).toEqual([
      expect.objectContaining({ reason: "FILES_NOT_LINKED", ref: "1" }),
    ]);
  });

  it("reports an empty cell and an unreadable cell differently", () => {
    const result = resolveMedia({
      profile,
      files: [file({ id: "f1", name: "1.jpg", parentFolderId: "root" })],
      mediaLinks: [
        { code: "SP-001", value: "   " },
        { code: "SP-002", value: "chưa có ảnh" },
      ],
    });
    expect(result.rejected.map((issue) => issue.reason)).toEqual([
      "MEDIA_LINK_MISSING",
      "MEDIA_LINK_INVALID",
    ]);
  });

  it("reports a link pointing outside the synced folder", () => {
    const result = resolveMedia({
      profile,
      files: [file({ id: "f1", name: "1.jpg", parentFolderId: "root" })],
      mediaLinks: [
        { code: "SP-001", value: "https://drive.google.com/file/d/1SomewhereElse12345/view" },
      ],
    });
    expect(result.assets).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ reason: "MEDIA_LINK_NOT_IN_FOLDER" });
    expect(result.rejected[0].detail).toContain("ngoài thư mục Drive");
  });

  it("gives a file claimed by two codes to the first one and flags it", () => {
    // (tenant, drive_file_id) is unique in the database: two assets would fail
    // on insert, so the conflict has to be resolved here and stay visible.
    const result = resolveMedia({
      profile,
      files: [file({ id: "1AbCdEfGhIjKlMnOp", name: "1.jpg", parentFolderId: "root" })],
      mediaLinks: [
        { code: "SP-001", value: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view" },
        { code: "SP-002", value: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view" },
      ],
    });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].productCode).toBe("SP-001");
    expect(result.reviews[0]).toMatchObject({ reason: "MEDIA_LINK_SHARED" });
  });

  it("reads several links out of one cell", () => {
    const result = resolveMedia({
      profile,
      files: [
        file({ id: "1AaaaaaaaaaaaaaaA", name: "1.jpg" }),
        file({ id: "1BbbbbbbbbbbbbbbB", name: "2.jpg" }),
      ],
      mediaLinks: [
        {
          code: "SP-001",
          value:
            "https://drive.google.com/file/d/1AaaaaaaaaaaaaaaA/view, https://drive.google.com/open?id=1BbbbbbbbbbbbbbbB",
        },
      ],
    });
    expect(result.assets.map((asset) => asset.driveFileId)).toEqual([
      "1AaaaaaaaaaaaaaaA",
      "1BbbbbbbbbbbbbbbB",
    ]);
  });
});

describe("code-in-name", () => {
  const profile: MediaProfile = { kind: "code-in-name" };

  it("matches the tenant's own codes anywhere in the name", () => {
    const result = resolveMedia({
      profile,
      knownCodes: ["SP-001"],
      files: [
        file({ id: "f1", name: "anh chup SP-001 (2).jpg" }),
        file({ id: "f2", name: "IMG_1664.JPG" }),
      ],
    });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ productCode: "SP-001", sequence: 2 });
    expect(result.rejected[0].reason).toBe("NO_PRODUCT_CODE");
  });

  it("keeps one asset when the same Drive file comes back twice", () => {
    const twice = file({ id: "f1", name: "SP-001.jpg" });
    const result = resolveMedia({ profile, knownCodes: ["SP-001"], files: [twice, twice] });
    expect(result.assets).toHaveLength(1);
    expect(result.reviews).toEqual([]);
  });
});
