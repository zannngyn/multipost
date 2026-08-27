import { describe, expect, it } from "vitest";

import {
  describeMove,
  formatBytes,
  indexOfId,
  isPreviewable,
  makeCover,
  moveItem,
  removeAt,
  syncPreviewUrls,
  type QueuedFile,
} from "@/ui/components/compose/upload-queue";

const items = ["a", "b", "c"];

describe("moveItem", () => {
  it("moves an entry down and up", () => {
    expect(moveItem(items, 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(items, 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("clamps a target past either end instead of throwing", () => {
    // The caller is a button at the edge of the list; a no-op beats a crash.
    expect(moveItem(items, 0, -5)).toEqual(items);
    expect(moveItem(items, 2, 99)).toEqual(items);
  });

  it("returns the list unchanged for an out-of-range source", () => {
    expect(moveItem(items, -1, 0)).toEqual(items);
    expect(moveItem(items, 3, 0)).toEqual(items);
    expect(moveItem(items, 1.5, 0)).toEqual(items);
  });

  it("does not mutate the input", () => {
    const original = [...items];
    moveItem(items, 0, 2);
    expect(items).toEqual(original);
  });
});

describe("makeCover", () => {
  it("promotes an entry to index 0", () => {
    expect(makeCover(items, 2)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op on the entry that is already the cover", () => {
    expect(makeCover(items, 0)).toEqual(items);
  });
});

describe("removeAt", () => {
  it("drops the entry at the index", () => {
    expect(removeAt(items, 1)).toEqual(["a", "c"]);
  });

  it("ignores an index outside the list", () => {
    expect(removeAt(items, 9)).toEqual(items);
    expect(removeAt(items, -1)).toEqual(items);
  });
});

describe("indexOfId", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("finds a row by its id", () => {
    expect(indexOfId(rows, "b")).toBe(1);
  });

  it("answers -1 for an id that is not in the list", () => {
    // A drag whose row vanished mid-gesture must be a no-op, not a splice at 0.
    expect(indexOfId(rows, "gone")).toBe(-1);
  });
});

describe("describeMove", () => {
  it("names the cover position explicitly", () => {
    expect(describeMove("a.jpg", 0, 3)).toContain("ảnh bìa");
  });

  it("uses a 1-based position elsewhere", () => {
    expect(describeMove("b.jpg", 1, 3)).toContain("vị trí 2");
  });
});

describe("formatBytes", () => {
  it("uses KB below a megabyte and MB above", () => {
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("never renders a negative or non-finite size", () => {
    expect(formatBytes(-1)).toBe("0 MB");
    expect(formatBytes(Number.NaN)).toBe("0 MB");
  });
});

describe("isPreviewable", () => {
  it("says yes to the image types the album accepts", () => {
    expect(isPreviewable(new File([""], "a.png", { type: "image/png" }))).toBe(true);
    expect(isPreviewable(new File([""], "a.jpg", { type: "image/jpeg" }))).toBe(true);
    expect(isPreviewable(new File([""], "a.webp", { type: "image/webp" }))).toBe(true);
  });

  it("says no to a video — there is no still to show", () => {
    expect(isPreviewable(new File([""], "a.mp4", { type: "video/mp4" }))).toBe(false);
  });

  it("says no rather than throwing on a file with no type", () => {
    expect(isPreviewable(new File([""], "a"))).toBe(false);
    expect(isPreviewable(undefined as unknown as File)).toBe(false);
  });
});

describe("syncPreviewUrls", () => {
  function queuedImage(id: string): QueuedFile {
    return { id, file: new File([""], `${id}.png`, { type: "image/png" }) };
  }

  function queuedVideo(id: string): QueuedFile {
    return { id, file: new File([""], `${id}.mp4`, { type: "video/mp4" }) };
  }

  it("creates a url for every previewable file in a fresh queue", () => {
    let calls = 0;
    const createUrl = () => `blob:${++calls}`;

    const { next, revoked } = syncPreviewUrls(new Map(), [queuedImage("a"), queuedImage("b")], createUrl);

    expect(calls).toBe(2);
    expect(next.get("a")).toBe("blob:1");
    expect(next.get("b")).toBe("blob:2");
    expect(revoked).toEqual([]);
  });

  it("is safe to run twice with the same input (StrictMode double-invoke)", () => {
    const createUrl = () => "blob:only-call";
    const queue = [queuedImage("a")];

    const first = syncPreviewUrls(new Map(), queue, createUrl);

    let secondCallCount = 0;
    const secondCreateUrl = () => {
      secondCallCount += 1;
      return "blob:should-not-happen";
    };
    const second = syncPreviewUrls(first.next, queue, secondCreateUrl);

    expect(secondCallCount).toBe(0);
    expect(second.next.get("a")).toBe("blob:only-call");
    expect(second.revoked).toEqual([]);
  });

  it("reports the url of a file dropped from the queue for revocation", () => {
    const current = new Map([
      ["a", "blob:a"],
      ["b", "blob:b"],
    ]);

    const { next, revoked } = syncPreviewUrls(current, [queuedImage("a")], () => "blob:new");

    expect(next.has("b")).toBe(false);
    expect(revoked).toEqual(["blob:b"]);
    // Untouched entry keeps its existing url rather than getting a new one.
    expect(next.get("a")).toBe("blob:a");
  });

  it("only creates a url for the file that is new, leaving the rest untouched", () => {
    const current = new Map([["a", "blob:a"]]);
    let calls = 0;
    const createUrl = () => `blob:${++calls}`;

    const { next, revoked } = syncPreviewUrls(current, [queuedImage("a"), queuedImage("c")], createUrl);

    expect(calls).toBe(1);
    expect(next.get("a")).toBe("blob:a");
    expect(next.get("c")).toBe("blob:1");
    expect(revoked).toEqual([]);
  });

  it("never creates a url for a video — there is no still to show", () => {
    let calls = 0;
    const createUrl = () => `blob:${++calls}`;

    const { next } = syncPreviewUrls(new Map(), [queuedVideo("v")], createUrl);

    expect(calls).toBe(0);
    expect(next.has("v")).toBe(false);
  });
});
