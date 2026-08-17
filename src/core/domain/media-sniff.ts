/**
 * E9 — identify a file by its CONTENT, not by what the client said it was.
 *
 * A browser's `File.type` and the extension are both attacker-controlled: a
 * `.jpg` can hold an executable, and an SVG (which carries script) can claim to
 * be a PNG. The declared type is fine for choosing an icon; it must never be
 * the thing that decides what we store and hand back out over a public URL.
 *
 * Pure and dependency-free (docs/07 §2): a few byte comparisons, no library.
 * Deliberately narrow — it recognises exactly the types the upload whitelist
 * accepts, and answers null for everything else rather than guessing.
 */

/**
 * Each signature declares its own length. One global minimum would refuse a
 * short-but-valid JPEG (3 signature bytes) for the sake of the longest check
 * (ISO base media, whose brand ends at byte 12).
 */
const JPEG_BYTES = 3;
const PNG_BYTES = 8;
const CONTAINER_BYTES = 12;

/**
 * `ftyp` brands we treat as mp4. Not exhaustive by design: an unknown brand
 * answers null and the file is refused, which is the safe direction.
 */
const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash"]);

export function sniffMediaMimeType(bytes: Uint8Array): string | null {
  if (!(bytes instanceof Uint8Array)) return null;

  // JPEG — SOI marker followed by any segment marker.
  if (bytes.length >= JPEG_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG — the 8-byte signature, including the CRLF trap bytes.
  if (
    bytes.length >= PNG_BYTES &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.length < CONTAINER_BYTES) return null;

  // WEBP — a RIFF container whose form type is WEBP. RIFF alone also fronts WAV
  // and AVI, so both tags must match.
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";

  // MP4 / MOV — ISO base media: a box whose type is `ftyp`, then the brand.
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "qt  ") return "video/quicktime";
    if (MP4_BRANDS.has(brand)) return "video/mp4";
    return null;
  }

  return null;
}

/** Reads `length` bytes as ASCII. Non-ASCII bytes cannot match a tag anyway. */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let index = offset; index < offset + length; index += 1) {
    out += String.fromCharCode(bytes[index]);
  }
  return out;
}
