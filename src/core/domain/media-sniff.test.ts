import { describe, expect, it } from "vitest";

import { sniffMediaMimeType } from "@/core/domain/media-sniff";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** RIFF....WEBP — the size word between the two tags is irrelevant here. */
function webp(): Uint8Array {
  const buffer = new Uint8Array(16);
  buffer.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  buffer.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  return buffer;
}

function isoMedia(brand: string): Uint8Array {
  const buffer = new Uint8Array(16);
  buffer.set([0x00, 0x00, 0x00, 0x18], 0);
  buffer.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
  buffer.set(new TextEncoder().encode(brand), 8);
  return buffer;
}

describe("sniffMediaMimeType — recognised types", () => {
  it("recognises JPEG", () => {
    expect(sniffMediaMimeType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0))).toBe("image/jpeg");
  });

  it("recognises PNG", () => {
    expect(sniffMediaMimeType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
      "image/png",
    );
  });

  it("recognises WEBP", () => {
    expect(sniffMediaMimeType(webp())).toBe("image/webp");
  });

  it("recognises mp4 brands", () => {
    for (const brand of ["isom", "mp42", "avc1", "iso5"]) {
      expect(sniffMediaMimeType(isoMedia(brand))).toBe("video/mp4");
    }
  });

  it("recognises quicktime", () => {
    expect(sniffMediaMimeType(isoMedia("qt  "))).toBe("video/quicktime");
  });
});

describe("sniffMediaMimeType — edge cases", () => {
  it("returns null for anything it does not know", () => {
    // A PDF, an ELF binary, and an SVG renamed to .jpg all land here.
    expect(sniffMediaMimeType(bytes(0x25, 0x50, 0x44, 0x46, 0x2d))).toBeNull();
    expect(sniffMediaMimeType(bytes(0x7f, 0x45, 0x4c, 0x46))).toBeNull();
    expect(sniffMediaMimeType(new TextEncoder().encode("<svg xmlns="))).toBeNull();
  });

  it("returns null for a buffer too short to identify", () => {
    expect(sniffMediaMimeType(bytes())).toBeNull();
    expect(sniffMediaMimeType(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffMediaMimeType(webp().slice(0, 10))).toBeNull();
  });

  it("returns null for a non-buffer", () => {
    expect(sniffMediaMimeType(undefined as unknown as Uint8Array)).toBeNull();
  });

  it("does not accept a RIFF container that is not WEBP", () => {
    // RIFF also fronts WAV and AVI; only WEBP is an image we take.
    const wav = new Uint8Array(16);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    expect(sniffMediaMimeType(wav)).toBeNull();
  });
});
