/**
 * Where the browser gets the BYTES of a product photo.
 *
 * `GET /api/media/preview/<driveFileId>` is the session-authenticated preview
 * route: the cookie the operator already has is the credential, so nothing is
 * put in the URL. It is the opposite of `/api/media/<driveFileId>?sig=…`, which
 * is public-but-signed because Meta's fetcher carries no cookie — that one must
 * NEVER be used as an `<img src>` in this app: a signed link is a bearer token
 * and would leak through `Referer`, the browser history and any shared
 * screenshot of the address bar.
 *
 * Kept as a pure builder (no fetch here): an `<img>` does its own request, so
 * the only thing the UI layer needs is a correct, escaped path.
 */

const PREVIEW_BASE = "/api/media/preview";

/**
 * `null` for a missing id, so the caller renders a placeholder instead of
 * pointing an `<img>` at `/api/media/preview/` — which would 404 on every tile
 * and show the browser's own broken-image glyph.
 */
export function mediaPreviewUrl(driveFileId: string | null | undefined): string | null {
  const id = (driveFileId ?? "").trim();
  if (id.length === 0) return null;
  if (
    id.startsWith("blob:") ||
    id.startsWith("data:") ||
    id.startsWith("http://") ||
    id.startsWith("https://")
  ) {
    return id;
  }
  // Drive ids are URL-safe in practice, but an uploaded asset id is minted
  // server-side and this path segment must survive whatever lands in it.
  return `${PREVIEW_BASE}/${encodeURIComponent(id)}`;
}
