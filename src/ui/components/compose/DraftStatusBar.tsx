"use client";

import { useState } from "react";

import { Button } from "@/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/ui/dialog";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import type { ComposeDraftState } from "@/ui/hooks/useComposeDraft";

/**
 * The draft's status line (E10) — SILENT while nothing is wrong.
 *
 * Autosave working is not news. "Đang lưu nháp…", "Đã lưu nháp lúc 15:30" and
 * "Tự động lưu nháp đang bật" are the app narrating its own bookkeeping: they
 * occupy the header on every single visit and the operator has no decision to
 * make about any of them. So the happy path renders NOTHING.
 *
 * What still speaks, because each one costs the operator something if missed
 * (business rule 5 — nothing is swallowed):
 *  - error            → "Lưu nháp lỗi" + the server's reason + a retry
 *  - local-only       → "Chỉ lưu trên máy này", a real limitation
 *  - localBufferFailed→ the browser refused to buffer locally (own paragraph)
 *  - notices          → warnings raised while restoring
 *
 * "Xoá nháp" stays reachable whenever a draft actually exists — it is the only
 * way to clear one — but on its own, not wrapped in a status announcement.
 *
 * Never a spinner over the content and never a toast.
 */
export function DraftStatusBar({ draft }: { draft: ComposeDraftState }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  /**
   * A screen with no draft settles in a few dozen milliseconds, and flashing
   * "Đang khôi phục nháp…" on every visit reads as a glitch (core-feedback-
   * states: nothing under 300ms). A real restore — a fetch plus a compose — is
   * always slower than that, so the only thing this hides is the flicker.
   */
  const showRestoring = useDelayedFlag(draft.isRestoring);

  /** Something the operator has to know about or act on. */
  const hasProblem =
    draft.phase === "error" || draft.phase === "local-only" || draft.localBufferFailed;
  // Only these two get the dot-and-sentence line; `localBufferFailed` has its
  // own paragraph below and must not be said twice.
  const status =
    draft.phase === "error" || draft.phase === "local-only" ? describe(draft) : null;

  /**
   * Is there anything to throw away? A "Xoá nháp" button on an untouched screen
   * is one more thing to read and nothing to do.
   */
  const hasDraft =
    draft.phase === "saved" ||
    draft.phase === "local-only" ||
    draft.phase === "error" ||
    Boolean(draft.updatedAt);

  // Quiet, with nothing stored and nothing wrong: say nothing at all. Also the
  // whole of a restore, which the operator did not ask about either.
  if (!hasProblem && !hasDraft && draft.notices.length === 0) return null;
  if (showRestoring && !hasProblem && draft.notices.length === 0) return null;

  return (
    <section aria-label="Trạng thái nháp" className="flex flex-col gap-2">
      {status ? (
        <div className="border-border bg-card flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3.5 py-2.5">
          <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${status.dotClass}`} />
          {/* `polite`: a failed save is not an interruption, but it must be
              announced. The text carries the state, never the colour alone
              (core-accessibility §5). */}
          <p role="status" aria-live="polite" className="text-sm">
            <span className="font-medium">{status.title}</span>
            {status.detail ? (
              <span className="text-muted-foreground"> — {status.detail}</span>
            ) : null}
          </p>

          <div className="ms-auto flex items-center gap-2">
            {draft.phase === "error" ? (
              <Button type="button" variant="outline" size="sm" onClick={draft.retry}>
                Thử lại
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {hasDraft ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={draft.isRestoring}
          >
            Xoá nháp
          </Button>
        </div>
      ) : null}

      {draft.localBufferFailed ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Trình duyệt không cho lưu tạm trên máy này (bộ nhớ đầy hoặc đang ở chế độ ẩn danh). Nháp
          chỉ còn dựa vào bản lưu trên máy chủ.
        </p>
      ) : null}

      {draft.notices.length > 0 ? (
        <ul
          role="status"
          className="border-warning/40 bg-warning/10 text-warning-foreground flex flex-col gap-1.5 rounded-xl border px-3.5 py-2.5 text-sm leading-relaxed"
        >
          {/* Index in the key: two notices can legitimately read the same, and
              a duplicate React key drops one of them silently. */}
          {draft.notices.map((notice, index) => (
            <li key={`${index}-${notice}`}>{notice}</li>
          ))}
        </ul>
      ) : null}

      {/* Destructive and not undoable -> confirmed, with the consequence spelled
          out before the button (core-feedback-states §Ma trận thông báo). */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent aria-describedby="discard-draft-description">
          <DialogHeader>
            <DialogTitle>Xoá nháp đang soạn?</DialogTitle>
            <DialogDescription id="discard-draft-description">
              Nội dung đang soạn sẽ bị xoá khỏi máy chủ và khỏi máy này, màn hình quay về bước 1
              trống. Việc này không hoàn tác được.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
              Giữ lại nháp
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                draft.discard();
              }}
            >
              Xoá nháp
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

interface DraftStatusText {
  title: string;
  detail: string | null;
  dotClass: string;
}

/** One sentence per state that is still worth a sentence. */
function describe(draft: ComposeDraftState): DraftStatusText {
  if (draft.phase === "error") {
    return {
      title: "Lưu nháp lỗi",
      detail: draft.errorMessage ?? "Không lưu được nháp lên máy chủ.",
      dotClass: "bg-destructive",
    };
  }

  // local-only — the only other phase this is called for.
  return {
    title: "Chỉ lưu trên máy này",
    detail:
      "Máy chủ chưa nhận diện được người dùng của phiên này, nên nháp không đồng bộ sang máy khác.",
    dotClass: "bg-warning",
  };
}

/**
 * "15:30" today, "20/08/2026 15:30" any other day, in the operator's own zone.
 *
 * The hour alone was a trap on the screen this line lives on: a draft is
 * restored days later, and "Đã lưu nháp lúc 01:31" reads as "a minute ago" —
 * the operator then trusts content typed before a catalog sync moved the stock.
 * The date shows up exactly when it carries news, so the everyday case stays
 * short (`formatDraftSavedAt` is exported for its test).
 */
export function formatDraftSavedAt(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const time = new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  if (isSameLocalDay(date, now)) return time;

  // The year is in, and on purpose: the `day/month` skeleton alone renders as
  // "22-07" in the vi-VN ICU data, a separator that appears nowhere else in
  // this app. Every other date on screen is dd/MM/yyyy (`formatScheduledAt`,
  // `formatDateTime`), and one line reading differently is the kind of detail
  // an operator notices without being able to name.
  const day = new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
  return `${day} ${time}`;
}

/** Local calendar day, not UTC — the operator reads their own clock. */
function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
