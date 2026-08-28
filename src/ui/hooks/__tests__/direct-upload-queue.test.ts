import { describe, expect, it } from "vitest";

import { nextProgress, planUploadOrder } from "@/ui/hooks/direct-upload-queue";

function fakeFile(name: string, size: number, type: string): File {
  return { name, size, type } as File;
}

describe("direct-upload-queue", () => {
  it("planUploadOrder keeps the order and takes exactly three fields", () => {
    expect(planUploadOrder([fakeFile("b.png", 2, "image/png"), fakeFile("a.png", 1, "image/png")])).toEqual([
      { fileName: "b.png", mimeType: "image/png", sizeBytes: 2 },
      { fileName: "a.png", mimeType: "image/png", sizeBytes: 1 },
    ]);
  });

  it("planUploadOrder returns empty for an empty list", () => {
    expect(planUploadOrder([])).toEqual([]);
  });

  it("nextProgress clamps to 0..100 and never divides by zero", () => {
    expect(nextProgress(0, 0)).toBe(0);
    expect(nextProgress(1, 4)).toBe(25);
    expect(nextProgress(9, 4)).toBe(100);
  });
});
