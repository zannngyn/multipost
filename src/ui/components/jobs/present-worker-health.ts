import { formatWaitDuration, type WorkerHealth } from "@/ui/schemas/worker-health.schema";

/**
 * Turns one worker-health reading into the banner the operator sees — or into
 * nothing at all.
 *
 * Pure on purpose: the decision "does an alarm fire?" is the part that must not
 * regress, and it is testable only while it stays out of the component
 * (core-frontend-testing). A false alarm here is worse than no alarm: an
 * operator who learns to ignore this banner gains nothing from the day it is
 * right.
 *
 * The three situations are deliberately three different sentences. Merging them
 * would tell somebody whose posts are stuck right now the same thing as
 * somebody whose queue is simply empty.
 */

export type WorkerHealthNoticeKind =
  /** No worker + posts already waiting: nothing goes out until that changes. */
  | "workers-down-with-backlog"
  /** No worker, nothing waiting: an early warning, nobody is hurt yet. */
  | "workers-down-idle"
  /** The queue could not be asked — no conclusion is possible, and that is bad. */
  | "queue-unreachable"
  /** We could not even read the health of the queue. Lowest severity. */
  | "check-failed";

/** Drives colour and how loudly assistive tech announces the banner. */
export type WorkerHealthTone = "critical" | "warning" | "muted";

export interface WorkerHealthNotice {
  kind: WorkerHealthNoticeKind;
  tone: WorkerHealthTone;
  /** What is happening. */
  title: string;
  /** Consequence — always says whether posts are lost (they are not). */
  description: string;
  /** What the operator does next. */
  action: string;
}

export interface PresentWorkerHealthInput {
  /** Last successful reading, if any. */
  health?: WorkerHealth | null;
  /** The health request failed. Ignored while a previous reading is still held. */
  hasError?: boolean;
}

/**
 * `null` = say nothing. That is the normal case and it must stay the easiest
 * one to reach.
 */
export function presentWorkerHealth(input: PresentWorkerHealthInput): WorkerHealthNotice | null {
  const { health, hasError = false } = input;

  // --- Edge cases first ----------------------------------------------------

  // No reading at all. An error is reported only when nothing else is known;
  // a failed poll that follows a good reading must not overwrite the reading,
  // otherwise a blip would replace "bài đang bị treo" with "chưa kiểm tra được".
  if (!health) {
    if (!hasError) return null; // still loading, or never asked — stay quiet
    return {
      kind: "check-failed",
      tone: "muted",
      title: "Chưa kiểm tra được tình trạng máy đăng bài",
      description:
        "Không lấy được tình trạng của máy đăng bài từ máy chủ. Đây chỉ là phần kiểm tra tình trạng — danh sách bài bên dưới vẫn đúng, và không bài nào bị mất.",
      action: "Bấm “Kiểm tra lại”. Nếu vẫn không được, báo người phụ trách kỹ thuật.",
    };
  }

  // The queue answered nothing, so `workersOnline` proves nothing either.
  // This branch must stay ABOVE the worker branches: announcing "không có máy
  // nào chạy" from a reading we could not take would be a guess.
  if (!health.queueReachable) {
    return {
      kind: "queue-unreachable",
      tone: "warning",
      title: "Không kiểm tra được hàng chờ đăng bài",
      description:
        "Hệ thống không đọc được hàng chờ đăng bài, nên chưa thể khẳng định bài đang được đăng hay đang nằm im. Bài đã tạo vẫn được giữ nguyên, không mất.",
      action:
        "Bấm “Kiểm tra lại” sau ít phút. Nếu bài mới vẫn không lên Facebook, báo người phụ trách kỹ thuật kiểm tra dịch vụ hàng chờ (Redis).",
    };
  }

  // Defensive: the schema already rejects negatives, but a future field change
  // must not turn a bad number into "mọi thứ bình thường".
  const workersOnline = Number.isFinite(health.workersOnline) ? health.workersOnline : 0;
  // Somebody IS draining the queue. Deliberately silent even when
  // `oldestUntouchedWaitMs` is large: the publish spacing gate re-enqueues a
  // job without attempting it (core/usecases/publish-post), so a batch of N
  // posts on one channel legitimately leaves the last one untouched for
  // N × spacing (60s today). A "worker sống nhưng tắc" banner built on that
  // number would fire on every normal large batch. Telling a real backlog from
  // normal spacing needs a signal the health contract does not carry yet.
  if (workersOnline > 0) return null;

  const waiting = Number.isFinite(health.untouchedQueuedJobs)
    ? Math.max(0, health.untouchedQueuedJobs)
    : 0;

  // --- No worker, and posts are already waiting: today's incident -----------
  if (waiting > 0) {
    const waited = formatWaitDuration(health.oldestUntouchedWaitMs);
    const count = waiting.toLocaleString("vi-VN");

    return {
      kind: "workers-down-with-backlog",
      tone: "critical",
      title: "Bài đang bị treo: không có máy đăng bài nào chạy",
      description:
        `Có ${count} bài đang xếp hàng chờ đăng` +
        (waited ? `, bài chờ lâu nhất đã chờ ${waited}` : "") +
        ". Không bài nào lên Facebook cho tới khi máy đăng bài chạy lại. Các bài này không bị mất — máy chạy lại là chúng tự đăng tiếp, không phải soạn lại.",
      action:
        "Báo người phụ trách kỹ thuật bật lại máy đăng bài (tiến trình xử lý hàng chờ). Bật xong, bấm “Kiểm tra lại” để xác nhận.",
    };
  }

  // --- No worker, nothing waiting: warn before it costs anything ------------
  return {
    kind: "workers-down-idle",
    tone: "warning",
    title: "Không có máy đăng bài nào đang chạy",
    // Deliberately NOT "không có bài nào đang chờ": the log below may still
    // list queued rows (bài đã hẹn giờ, bài đã thử ít nhất một lần). Claiming
    // the opposite right above that table would read as a lie.
    description:
      "Chưa thấy bài nào đang chờ tới lượt đăng, nên có thể chưa bài nào bị lỡ. Nhưng bài đăng từ lúc này sẽ nằm im chờ, không tự lên Facebook — bài vẫn được giữ, không mất.",
    action:
      "Báo người phụ trách kỹ thuật bật lại máy đăng bài (tiến trình xử lý hàng chờ) trước khi đăng tiếp.",
  };
}
