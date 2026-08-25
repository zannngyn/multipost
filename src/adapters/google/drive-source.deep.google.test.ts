import { beforeEach, describe, expect, it, vi } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { Logger } from "@/core/ports/infra";

/**
 * `listFilesDeep` (phase 2) — the recursive Drive listing.
 *
 * What is tested is the boundary contract, not googleapis: the batched query
 * (one request for several parents, which is the whole quota argument), the
 * folder path each file carries, and — above all — that every cap it hits
 * comes back in `limitsHit`. A truncated listing that looks complete would make
 * the sync delete photos that are still on Drive.
 */

const listMock = vi.fn();
const getMock = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    drive: () => ({ files: { list: listMock, get: getMock } }),
    sheets: () => ({ spreadsheets: { values: { get: vi.fn() } } }),
    auth: { JWT: class {}, OAuth2: class {} },
  },
}));

const { makeGoogleDriveSource, PARENTS_PER_QUERY } = await import("./drive-source.google");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const FOLDER_MIME = "application/vnd.google-apps.folder";

function makeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message: string) => void warnings.push(message),
    error: vi.fn(),
    warnings,
  } as unknown as Logger & { warnings: string[] };
  return logger;
}

const reportAuthFailure = vi.fn(async () => null);
const auth = {
  forTenant: async () => ({}) as never,
  reportAuthFailure,
  invalidate: () => {},
} as never;

function build(logger: Logger = makeLogger()) {
  return makeGoogleDriveSource({ auth, logger });
}

/** A Drive v3 entry for a file, with the `parents` the deep listing asks for. */
function entry(id: string, name: string, parent: string, isFolder = false) {
  return {
    id,
    name,
    mimeType: isFolder ? FOLDER_MIME : "image/jpeg",
    size: "1000",
    modifiedTime: "2026-08-01T00:00:00.000Z",
    parents: [parent],
  };
}

beforeEach(() => {
  listMock.mockReset();
  reportAuthFailure.mockReset();
  reportAuthFailure.mockResolvedValue(null);
});

describe("listFilesDeep — edge cases first", () => {
  it("refuses an empty folder id without calling Drive", async () => {
    await expect(
      build().listFilesDeep!({ tenantId: TENANT, folderId: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(listMock).not.toHaveBeenCalled();
  });

  it("maps a transport failure to DRIVE_ERROR with the folder and the depth", async () => {
    listMock.mockRejectedValueOnce(new Error("boom"));
    await expect(
      build().listFilesDeep!({ tenantId: TENANT, folderId: "root" }),
    ).rejects.toMatchObject({
      code: "DRIVE_ERROR",
      context: expect.objectContaining({ folder_id: "root", operation: "drive.files.list" }),
    });
  });

  it("rejects a payload that is not shaped like a Drive answer", async () => {
    listMock.mockResolvedValueOnce({ data: { files: "not-an-array" } });
    await expect(
      build().listFilesDeep!({ tenantId: TENANT, folderId: "root" }),
    ).rejects.toMatchObject({ code: "DRIVE_ERROR" });
  });

  it("returns an empty, complete listing for an empty folder", async () => {
    listMock.mockResolvedValueOnce({ data: { files: [] } });
    const listing = await build().listFilesDeep!({ tenantId: TENANT, folderId: "root" });
    expect(listing).toEqual({ files: [], foldersVisited: 0, depthReached: 0, limitsHit: [] });
  });
});

describe("listFilesDeep — the walk", () => {
  it("asks for folders AND files in one query and follows sub-folders", async () => {
    listMock
      .mockResolvedValueOnce({
        data: {
          files: [
            entry("d1", "MGKVX6310", "root", true),
            entry("f0", "readme.jpg", "root"),
          ],
        },
      })
      .mockResolvedValueOnce({ data: { files: [entry("f1", "KEM (6).png", "d1")] } });

    const listing = await build().listFilesDeep!({ tenantId: TENANT, folderId: "root" });

    expect(listMock.mock.calls[0][0].q).toBe("('root' in parents) and trashed = false");
    expect(listMock.mock.calls[0][0].fields).toContain("parents");
    expect(listMock.mock.calls[1][0].q).toBe("('d1' in parents) and trashed = false");

    expect(listing.files).toEqual([
      expect.objectContaining({ id: "f0", parentFolderId: "root", folderPath: [] }),
      expect.objectContaining({
        id: "f1",
        name: "KEM (6).png",
        parentFolderId: "d1",
        folderPath: ["MGKVX6310"],
        sizeBytes: 1000,
      }),
    ]);
    expect(listing).toMatchObject({ foldersVisited: 1, depthReached: 1, limitsHit: [] });
  });

  it("batches several parents into ONE query instead of one request per folder", async () => {
    const folders = Array.from({ length: 3 }, (_, index) =>
      entry(`d${index}`, `CODE${index}`, "root", true),
    );
    listMock
      .mockResolvedValueOnce({ data: { files: folders } })
      .mockResolvedValueOnce({ data: { files: [entry("f1", "a.jpg", "d2")] } });

    const listing = await build().listFilesDeep!({ tenantId: TENANT, folderId: "root" });

    // Level 0 + ONE query for the three children — not three.
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listMock.mock.calls[1][0].q).toBe(
      "('d0' in parents or 'd1' in parents or 'd2' in parents) and trashed = false",
    );
    expect(listing.files[0]).toMatchObject({ parentFolderId: "d2", folderPath: ["CODE2"] });
    expect(PARENTS_PER_QUERY).toBeGreaterThan(1);
  });

  it("pages through a level before descending", async () => {
    listMock
      .mockResolvedValueOnce({
        data: { files: [entry("f1", "a.jpg", "root")], nextPageToken: "p2" },
      })
      .mockResolvedValueOnce({ data: { files: [entry("f2", "b.jpg", "root")] } });

    const listing = await build().listFilesDeep!({ tenantId: TENANT, folderId: "root" });
    expect(listMock.mock.calls[1][0].pageToken).toBe("p2");
    expect(listing.files.map((file) => file.id)).toEqual(["f1", "f2"]);
  });

  it("returns a file with two parents ONCE", async () => {
    listMock
      .mockResolvedValueOnce({
        data: {
          files: [entry("d1", "A", "root", true), entry("d2", "B", "root", true)],
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [
            { ...entry("f1", "a.jpg", "d1"), parents: ["d1", "d2"] },
            { ...entry("f1", "a.jpg", "d2"), parents: ["d1", "d2"] },
          ],
        },
      });

    const listing = await build().listFilesDeep!({ tenantId: TENANT, folderId: "root" });
    expect(listing.files).toHaveLength(1);
    expect(listing.files[0].folderPath).toEqual(["A"]);
  });

  it("skips entries without an id or a name and warns once", async () => {
    const logger = makeLogger();
    listMock.mockResolvedValueOnce({
      data: { files: [{ name: "no-id.jpg" }, entry("f1", "a.jpg", "root")] },
    });

    const listing = await build(logger).listFilesDeep!({ tenantId: TENANT, folderId: "root" });
    expect(listing.files.map((file) => file.id)).toEqual(["f1"]);
    expect(logger.warnings.join(" ")).toContain("without an id or a name");
  });
});

describe("listFilesDeep — the caps are reported, never silent", () => {
  it("stops at maxFiles and says MAX_FILES", async () => {
    const logger = makeLogger();
    listMock.mockResolvedValueOnce({
      data: {
        files: [
          entry("f1", "a.jpg", "root"),
          entry("f2", "b.jpg", "root"),
          entry("f3", "c.jpg", "root"),
        ],
        nextPageToken: "p2",
      },
    });

    const listing = await build(logger).listFilesDeep!({
      tenantId: TENANT,
      folderId: "root",
      maxFiles: 2,
    });

    expect(listing.files).toHaveLength(2);
    expect(listing.limitsHit).toEqual(["MAX_FILES"]);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(logger.warnings.join(" ")).toContain("PARTIAL");
  });

  it("does not descend past maxDepth and says MAX_DEPTH", async () => {
    listMock
      .mockResolvedValueOnce({ data: { files: [entry("d1", "A", "root", true)] } })
      .mockResolvedValueOnce({
        data: { files: [entry("d2", "B", "d1", true), entry("f1", "a.jpg", "d1")] },
      });

    const listing = await build().listFilesDeep!({
      tenantId: TENANT,
      folderId: "root",
      maxDepth: 1,
    });

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listing.files.map((file) => file.id)).toEqual(["f1"]);
    expect(listing.limitsHit).toEqual(["MAX_DEPTH"]);
    expect(listing.depthReached).toBe(1);
  });

  it("maxDepth 0 is a flat listing that still reports the folders it skipped", async () => {
    listMock.mockResolvedValueOnce({
      data: { files: [entry("d1", "A", "root", true), entry("f1", "a.jpg", "root")] },
    });

    const listing = await build().listFilesDeep!({
      tenantId: TENANT,
      folderId: "root",
      maxDepth: 0,
    });

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listing.files.map((file) => file.id)).toEqual(["f1"]);
    expect(listing.limitsHit).toEqual(["MAX_DEPTH"]);
  });

  it("stops visiting folders at maxFolders and says MAX_FOLDERS", async () => {
    listMock
      .mockResolvedValueOnce({
        data: {
          files: [
            entry("d1", "A", "root", true),
            entry("d2", "B", "root", true),
            entry("d3", "C", "root", true),
          ],
        },
      })
      .mockResolvedValueOnce({ data: { files: [entry("f1", "a.jpg", "d1")] } });

    const listing = await build().listFilesDeep!({
      tenantId: TENANT,
      folderId: "root",
      maxFolders: 1,
    });

    expect(listing.foldersVisited).toBe(1);
    expect(listing.limitsHit).toEqual(["MAX_FOLDERS"]);
    expect(listing.files.map((file) => file.id)).toEqual(["f1"]);
  });

  it("keeps the flat listFiles untouched: no parentFolderId, folders excluded", async () => {
    listMock.mockResolvedValueOnce({
      data: { files: [{ id: "f1", name: "a.jpg", mimeType: "image/jpeg" }] },
    });

    const files = await build().listFiles({ tenantId: TENANT, folderId: "root" });
    expect(files[0]).toEqual({
      id: "f1",
      name: "a.jpg",
      mimeType: "image/jpeg",
      sizeBytes: null,
      modifiedTime: null,
    });
    expect(listMock.mock.calls[0][0].q).toContain(`mimeType != '${FOLDER_MIME}'`);
  });
});
