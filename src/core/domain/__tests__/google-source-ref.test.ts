import { describe, expect, it } from "vitest";

import { AppError } from "../errors";
import {
  parseDriveFolderRef,
  parseDriveMediaRefs,
  parseSpreadsheetRef,
  requireGoogleRef,
  type GoogleRefRejection,
} from "../google-source-ref";

/** The two real ids of docs/05 — the strings an operator actually pastes. */
const FOLDER_ID = "1bA48sjugz9BczcoR0-zOc-VNlIYikp4v";
const SHEET_ID = "1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs";

function rejection(result: ReturnType<typeof parseDriveFolderRef>): GoogleRefRejection | "ok" {
  return result.ok ? "ok" : result.reason;
}

describe("parseDriveFolderRef — edge cases first", () => {
  it("rejects empty, whitespace and non-strings", () => {
    for (const value of ["", "   ", null, undefined, 42, {}, []]) {
      expect(rejection(parseDriveFolderRef(value))).toBe("EMPTY");
    }
  });

  it("rejects a URL from another host, however folder-shaped its path is", () => {
    expect(rejection(parseDriveFolderRef(`https://drive.evil.com/drive/folders/${FOLDER_ID}`))).toBe(
      "WRONG_HOST",
    );
    expect(rejection(parseDriveFolderRef(`http://dropbox.com/drive/folders/${FOLDER_ID}`))).toBe(
      "WRONG_HOST",
    );
  });

  it("rejects a Google URL that is not a folder", () => {
    expect(rejection(parseDriveFolderRef("https://drive.google.com/drive/my-drive"))).toBe(
      "WRONG_PATH",
    );
  });

  it("rejects a scheme that is not http(s), and an unparsable URL", () => {
    expect(rejection(parseDriveFolderRef(`ftp://drive.google.com/drive/folders/${FOLDER_ID}`))).toBe(
      "NOT_A_URL_OR_ID",
    );
    expect(rejection(parseDriveFolderRef("https://"))).toBe("NOT_A_URL_OR_ID");
  });

  it("rejects junk and ids that are too short to be real", () => {
    expect(rejection(parseDriveFolderRef("khong phai link"))).toBe("MALFORMED_ID");
    expect(rejection(parseDriveFolderRef("abc123"))).toBe("MALFORMED_ID");
    expect(rejection(parseDriveFolderRef("<script>alert(1)</script>"))).toBe("MALFORMED_ID");
    expect(rejection(parseDriveFolderRef(`${FOLDER_ID}/../../etc/passwd`))).toBe("MALFORMED_ID");
  });

  it("rejects a folder URL with an empty id segment", () => {
    expect(rejection(parseDriveFolderRef("https://drive.google.com/drive/folders/"))).toBe(
      "WRONG_PATH",
    );
  });

  // --- happy paths ---------------------------------------------------------
  it("takes the id out of the link an operator copies, query and fragment included", () => {
    for (const url of [
      `https://drive.google.com/drive/folders/${FOLDER_ID}`,
      `https://drive.google.com/drive/folders/${FOLDER_ID}?usp=sharing`,
      `https://drive.google.com/drive/folders/${FOLDER_ID}?usp=drive_link#anchor`,
      `https://drive.google.com/drive/u/0/folders/${FOLDER_ID}`,
      `https://drive.google.com/open?id=${FOLDER_ID}`,
      `  https://drive.google.com/drive/folders/${FOLDER_ID}  `,
    ]) {
      expect(parseDriveFolderRef(url)).toEqual({ ok: true, id: FOLDER_ID });
    }
  });

  it("accepts a bare id", () => {
    expect(parseDriveFolderRef(FOLDER_ID)).toEqual({ ok: true, id: FOLDER_ID });
    expect(parseDriveFolderRef(`  ${FOLDER_ID} `)).toEqual({ ok: true, id: FOLDER_ID });
  });
});

describe("parseSpreadsheetRef — edge cases first", () => {
  it("rejects empty and wrong host", () => {
    expect(rejection(parseSpreadsheetRef(""))).toBe("EMPTY");
    expect(rejection(parseSpreadsheetRef(`https://docs.evil.com/spreadsheets/d/${SHEET_ID}`))).toBe(
      "WRONG_HOST",
    );
  });

  it("rejects a docs.google.com URL that is not a spreadsheet", () => {
    expect(rejection(parseSpreadsheetRef("https://docs.google.com/document/d/abc123def456"))).toBe(
      "WRONG_PATH",
    );
  });

  it("rejects the published-to-web link: that token is not the spreadsheet id", () => {
    expect(
      rejection(
        parseSpreadsheetRef("https://docs.google.com/spreadsheets/d/e/2PACX-1vABCDEF/pubhtml"),
      ),
    ).toBe("PUBLISHED_LINK");
  });

  it("rejects a drive folder link pasted into the sheet field", () => {
    expect(rejection(parseSpreadsheetRef(`https://drive.google.com/drive/folders/${FOLDER_ID}`))).toBe(
      "WRONG_HOST",
    );
  });

  // --- happy paths ---------------------------------------------------------
  it("takes the id out of the link, with /edit, gid fragment or query", () => {
    for (const url of [
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}`,
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`,
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing#gid=123456`,
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/view`,
    ]) {
      expect(parseSpreadsheetRef(url)).toEqual({ ok: true, id: SHEET_ID });
    }
  });

  it("accepts a bare id", () => {
    expect(parseSpreadsheetRef(SHEET_ID)).toEqual({ ok: true, id: SHEET_ID });
  });
});

describe("requireGoogleRef", () => {
  it("returns the id on success", () => {
    expect(requireGoogleRef("drive_folder", "driveFolder", FOLDER_ID)).toBe(FOLDER_ID);
    expect(
      requireGoogleRef("spreadsheet", "spreadsheet", `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`),
    ).toBe(SHEET_ID);
  });

  it("throws INVALID_INPUT naming the field, with the Vietnamese hint", () => {
    try {
      requireGoogleRef("drive_folder", "driveFolder", "https://dropbox.com/x");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      const appError = error as AppError;
      expect(appError.code).toBe("INVALID_INPUT");
      expect(appError.context.field).toBe("driveFolder");
      expect(appError.context.reason).toBe("WRONG_HOST");
      expect(appError.userMessage).toContain("Dán link folder Google Drive hoặc ID của nó");
    }
  });

  it("names the spreadsheet field for a spreadsheet mistake", () => {
    try {
      requireGoogleRef("spreadsheet", "spreadsheet", "rac");
      expect.unreachable("should have thrown");
    } catch (error) {
      const appError = error as AppError;
      expect(appError.context.field).toBe("spreadsheet");
      expect(appError.userMessage).toContain("Dán link Google Sheet hoặc ID của nó");
    }
  });
});

/**
 * The LENIENT half (onboarding phase 2): the same links, but read out of a
 * spreadsheet cell nobody will clean up for us. It returns values, never
 * throws, and takes what it recognises.
 */
describe("parseDriveMediaRefs — a sheet cell, not a paste box", () => {
  it("returns [] for everything unusable instead of throwing", () => {
    for (const raw of ["", "   ", null, undefined, 42, "chưa có ảnh", "https://dropbox.com/x"]) {
      expect(parseDriveMediaRefs(raw)).toEqual([]);
    }
  });

  it("reads a file link, a folder link and the legacy open?id= form", () => {
    expect(
      parseDriveMediaRefs("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing"),
    ).toEqual([{ id: "1AbCdEfGhIjKlMnOp", kind: "file" }]);
    expect(parseDriveMediaRefs("https://drive.google.com/drive/folders/1FolderIdAbCdEfGh")).toEqual([
      { id: "1FolderIdAbCdEfGh", kind: "folder" },
    ]);
    expect(parseDriveMediaRefs("https://drive.google.com/open?id=1OpenIdAbCdEfGhIj")).toEqual([
      { id: "1OpenIdAbCdEfGhIj", kind: "unknown" },
    ]);
  });

  it("takes a bare id, and ignores a string too short to be one", () => {
    expect(parseDriveMediaRefs("1AbCdEfGhIjKlMnOp")).toEqual([
      { id: "1AbCdEfGhIjKlMnOp", kind: "unknown" },
    ]);
    expect(parseDriveMediaRefs("abc")).toEqual([]);
  });

  it("reads several links from one cell, de-duplicated, order kept", () => {
    const refs = parseDriveMediaRefs(
      "https://drive.google.com/file/d/1AaaaaaaaaaaaaaaA/view\n" +
        "https://drive.google.com/file/d/1BbbbbbbbbbbbbbbB/view ; " +
        "https://drive.google.com/file/d/1AaaaaaaaaaaaaaaA/view",
    );
    expect(refs.map((ref) => ref.id)).toEqual(["1AaaaaaaaaaaaaaaA", "1BbbbbbbbbbbbbbbB"]);
  });

  it("ignores the noise around a link instead of failing the cell", () => {
    expect(
      parseDriveMediaRefs("ảnh: https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view (chụp 12/8)"),
    ).toEqual([{ id: "1AbCdEfGhIjKlMnOp", kind: "file" }]);
  });

  it("does not mistake a published-sheet token for a media file", () => {
    expect(
      parseDriveMediaRefs("https://docs.google.com/spreadsheets/d/e/2PACX-1vTokenHere/pubhtml"),
    ).toEqual([]);
  });
});

describe("requireGoogleRef — unchanged", () => {
  it("still names the spreadsheet field for a spreadsheet mistake", () => {
    try {
      requireGoogleRef("spreadsheet", "spreadsheet", "rac");
      expect.unreachable("should have thrown");
    } catch (error) {
      const appError = error as AppError;
      expect(appError.context.field).toBe("spreadsheet");
      expect(appError.userMessage).toContain("Dán link Google Sheet hoặc ID của nó");
    }
  });
});
