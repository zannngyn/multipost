import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";
import { MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_POST, validateUpload } from "@/core/domain/uploaded-media";
import type { Logger } from "@/core/ports/infra";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";
import type { UploadTicket, UploadTicketRepo } from "@/core/ports/upload-ticket-repo";

import { assertOneAlbumKind, type UploadRejectionReport } from "./upload-media";

/**
 * Stage 1 of the presigned-upload path: sign an upload URL, never touch a
 * byte.
 *
 * The bytes go browser -> MinIO directly at stage 2, so everything here works
 * off the client's CLAIM about a file (name, mime, size). A claim is
 * forgeable — the real gate is `confirm-upload` (stage 3), which sniffs the
 * bytes once they exist. Validation here exists only to avoid signing a URL
 * that is certainly useless, not as a security boundary.
 */

export interface IssueUploadTicketsInput {
  readonly tenantId: TenantId;
  readonly productCode: string;
  readonly actorUserId?: string | null;
  readonly files: readonly { fileName: string; mimeType: string; sizeBytes: number }[];
}

export interface IssuedTicket {
  readonly assetId: string;
  readonly fileName: string;
  /**
   * Index into the `files` array the client sent. The UI pairs a ticket with
   * its `File` object by this NUMBER, not by name: two same-named photos in
   * one album is ordinary (shot from two different folders), and pairing by
   * name would silently swallow one with nobody told.
   */
  readonly sourceIndex: number;
  readonly postUrl: string;
  readonly formFields: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface IssueUploadTicketsResult {
  readonly issued: readonly IssuedTicket[];
  readonly rejected: readonly UploadRejectionReport[];
}

export interface IssueUploadTicketsDeps {
  blobs: MediaBlobStore;
  tickets: UploadTicketRepo;
  logger: Logger;
  /** Injected so the id is deterministic under test. Must be path-safe. */
  newAssetId: () => string;
  ticketTtlSeconds: number;
}

export function makeIssueUploadTickets(deps: IssueUploadTicketsDeps) {
  return async function issueUploadTickets(
    input: IssueUploadTicketsInput,
  ): Promise<IssueUploadTicketsResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    const productCode =
      typeof input?.productCode === "string" ? input.productCode.trim().toUpperCase() : "";

    if (!isTenantId(rawTenantId) || productCode.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "issueUploadTickets requires a tenant UUID and a product code",
        userMessage: "Thiếu mã sản phẩm cho các file vừa chọn.",
        context: { tenant_id: rawTenantId || null, product_code: productCode || null },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);
    const files = Array.isArray(input?.files) ? input.files : [];

    if (files.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "issueUploadTickets was called with no files",
        userMessage: "Chưa chọn file nào.",
        context: { tenant_id: tenantId, product_code: productCode, reason: "EMPTY_ALBUM" },
      });
    }
    if (files.length > MAX_UPLOADS_PER_POST) {
      throw new AppError("INVALID_INPUT", {
        message: `An uploaded album holds at most ${MAX_UPLOADS_PER_POST} files`,
        userMessage: `Một bài chỉ nhận tối đa ${MAX_UPLOADS_PER_POST} file — hiện đang có ${files.length}.`,
        context: {
          tenant_id: tenantId,
          product_code: productCode,
          reason: "TOO_MANY_FILES",
          count: files.length,
        },
      });
    }

    const log = deps.logger.child({ tenant_id: tenantId, product_code: productCode });

    // --- Per-file gate, based on the CLIENT'S CLAIM only --------------------
    const rejected: UploadRejectionReport[] = [];
    const usable: {
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      kind: "image" | "video";
      sourceIndex: number;
    }[] = [];

    for (const [sourceIndex, candidate] of files.entries()) {
      const verdict = validateUpload({
        fileName: candidate?.fileName,
        mimeType: candidate?.mimeType,
        sizeBytes: candidate?.sizeBytes,
      });
      if (!verdict.ok) {
        log.warn("Ticket refused a file before signing", {
          error_code: "INVALID_INPUT",
          reason: verdict.rejection.reason,
          file_name: candidate?.fileName ?? null,
          size_bytes: candidate?.sizeBytes ?? null,
        });
        rejected.push({
          fileName: typeof candidate?.fileName === "string" ? candidate.fileName : "",
          reason: verdict.rejection.reason,
          userMessage: verdict.rejection.userMessage,
        });
        continue;
      }
      usable.push({
        fileName: candidate.fileName.trim(),
        mimeType: verdict.mimeType,
        sizeBytes: candidate.sizeBytes,
        kind: verdict.kind,
        sourceIndex,
      });
    }

    if (usable.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "Every candidate file was refused before signing",
        userMessage: `Không nhận được file nào: ${rejected.map((item) => item.userMessage).join(" ")}`,
        context: { tenant_id: tenantId, product_code: productCode, refused: rejected.length },
      });
    }

    assertOneAlbumKind(
      usable.map((item) => item.kind),
      { tenantId, productCode },
    );

    // --- Sign, then record the tickets --------------------------------------
    const issued: IssuedTicket[] = [];
    const ticketRows: UploadTicket[] = [];

    for (const item of usable) {
      const assetId = deps.newAssetId();
      const signed = await deps.blobs.createUploadUrl({
        tenantId,
        assetId,
        declaredMimeType: item.mimeType,
        maxBytes: MAX_UPLOAD_BYTES,
        expiresInSeconds: deps.ticketTtlSeconds,
      });
      issued.push({
        assetId,
        fileName: item.fileName,
        sourceIndex: item.sourceIndex,
        postUrl: signed.postUrl,
        formFields: signed.formFields,
        expiresAt: signed.expiresAt,
      });
      ticketRows.push({
        tenantId,
        assetId,
        storageKey: signed.storageKey,
        fileName: item.fileName,
        declaredMime: item.mimeType,
        declaredSize: item.sizeBytes,
        productCode,
        expiresAt: signed.expiresAt,
        createdBy: input.actorUserId ?? null,
      });
    }

    // A retried request that replays the same asset ids collides with the
    // unique (tenant_id, asset_id) constraint — wrapDbError turns that into an
    // AppError inside the repo, which we let propagate rather than swallow;
    // by then every URL above has already been signed and is simply unused.
    await deps.tickets.createMany(tenantId, ticketRows);

    log.info("Issued upload tickets", { issued: issued.length, refused: rejected.length });
    return { issued, rejected };
  };
}

export type IssueUploadTickets = ReturnType<typeof makeIssueUploadTickets>;
