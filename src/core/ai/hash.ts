/**
 * Stable, dependency-free hash for `ai_generation.inputHash`
 * (docs/ai/prompt-versioning.md §2): dedupe + "same input, different output?"
 * forensics. Not cryptographic — core must not import node:crypto (docs/07 §2).
 */

/** FNV-1a 32-bit, rendered as 8 hex chars. */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Order-independent hash of a plain record — key order must not change the hash. */
export function hashParts(parts: Readonly<Record<string, string | number | undefined>>): string {
  const serialised = Object.keys(parts)
    .sort()
    .map((key) => `${key}=${parts[key] ?? ""}`)
    .join("\x01");
  return stableHash(serialised);
}
