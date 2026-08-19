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
 * The draft's own status line (E10).
 *
 * It answers one question at all times: WHERE is what I just typed? Autosave
 * that shows nothing is indistinguishable from autosave that is broken, and the
 * operator only finds out which after losing an afternoon.
 *
 * Four states, four different sentences (core-feedback-states):
 *  - restoring → "Đang khôi phục nháp…"
 *  - saved     → "Đã lưu nháp lúc HH:mm" (the hour, not a vague "đã lưu")
 *  - local-only→ "Chỉ lưu trên máy này" + why, because it is a real limitation
 *  - error     → "Lưu nháp lỗi" + the server's reason + a retry that works
 *
 * Never a spinner over the content and never a toast: this is ambient state, it
 * belongs in a line the operator can glance at, not in something that steals
 * focus or disappears before it is read.
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
  const status = describe(draft, showRestoring);

  return (
    <section aria-label="Trạng thái nháp" className="flex flex-col gap-2">
      <div className="border-border bg-card flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3.5 py-2.5">
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${status.dotClass}`}
        />
        {/* `polite`: a save is not an interruption. The text carries the state,
            never the colour alone (core-accessibility §5). */}
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
      </div>

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

/** One sentence per state — and the hour, because "đã lưu" alone ages badly. */
function describe(draft: ComposeDraftState, showRestoring: boolean): DraftStatusText {
  if (showRestoring) {
    return {
      title: "Đang khôi phục nháp…",
      detail: "Đang tra lại mã sản phẩm và kiểm tồn kho như lúc soạn mới.",
      dotClass: "bg-accent-foreground motion-safe:animate-pulse",
    };
  }

  switch (draft.phase) {
    case "saving":
      return { title: "Đang lưu nháp…", detail: null, dotClass: "bg-accent-foreground" };
    case "saved":
      return {
        title: draft.updatedAt ? `Đã lưu nháp lúc ${formatSavedAt(draft.updatedAt)}` : "Đã lưu nháp",
        detail: "Đóng tab hay F5 đều không mất phần bạn đã gõ.",
        dotClass: "bg-success",
      };
    case "local-only":
      return {
        title: "Chỉ lưu trên máy này",
        detail:
          "Máy chủ chưa nhận diện được người dùng của phiên này, nên nháp không đồng bộ sang máy khác.",
        dotClass: "bg-warning",
      };
    case "error":
      return {
        title: "Lưu nháp lỗi",
        detail: draft.errorMessage ?? "Không lưu được nháp lên máy chủ.",
        dotClass: "bg-destructive",
      };
    // Also the first ~300ms of a restore, before it is worth announcing: the
    // sentence is true either way, so nothing flickers between the two.
    default:
      return {
        title: "Tự động lưu nháp đang bật",
        detail: "Mọi thứ bạn gõ được lưu lại ngay khi bạn dừng tay.",
        dotClass: "bg-border",
      };
  }
}

/** "15:30" in the operator's own zone; the date is not news on this screen. */
function formatSavedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(date);
}
