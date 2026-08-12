import { describe, expect, it, vi } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

/**
 * `remove` (E8.4) against a stubbed BullMQ Queue: what matters here is the
 * translation of BullMQ's numeric answer into a boolean the usecases can act on,
 * and that a broker failure becomes a QUEUE_ERROR instead of escaping raw.
 * The real Redis round trip is covered by the publish smoke script.
 */

const removeMock = vi.fn();
const addMock = vi.fn();
const closeMock = vi.fn();

vi.mock("bullmq", () => ({
  Queue: class {
    remove = removeMock;
    add = addMock;
    close = closeMock;
  },
}));

const { makeBullMqJobQueue } = await import("./bullmq-job-queue");

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
}

function recordingLogger(lines: LogLine[]): Logger {
  const make = (): Logger => ({
    child: (_bindings: LogBindings) => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

function makeQueue() {
  const lines: LogLine[] = [];
  const queue = makeBullMqJobQueue({
    connection: {} as never,
    logger: recordingLogger(lines),
  });
  return { queue, lines };
}

// --- Edge cases first -------------------------------------------------------

describe("BullMqJobQueue.remove", () => {
  it.each(["", "   "])("rejects the blank job id %p", async (jobId) => {
    const { queue } = makeQueue();
    await expect(queue.remove(jobId)).rejects.toMatchObject({ code: "QUEUE_ERROR" });
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("reports false when the broker removed nothing (unknown id or active job)", async () => {
    removeMock.mockResolvedValueOnce(0);
    const { queue, lines } = makeQueue();

    expect(await queue.remove("pp.job-1")).toBe(false);

    expect(lines.some((line) => line.context?.reason === "NOT_FOUND_OR_ACTIVE")).toBe(true);
  });

  it("reports true when the delayed entry was dropped", async () => {
    removeMock.mockResolvedValueOnce(1);
    const { queue } = makeQueue();
    expect(await queue.remove("  pp.job-1  ")).toBe(true);
    expect(removeMock).toHaveBeenCalledWith("pp.job-1");
  });

  it("wraps a broker failure as QUEUE_ERROR with the job id in context", async () => {
    removeMock.mockRejectedValueOnce(new Error("connection closed"));
    const { queue, lines } = makeQueue();

    await expect(queue.remove("pp.job-1")).rejects.toMatchObject({
      code: "QUEUE_ERROR",
      context: { job_id: "pp.job-1", operation: "queue.remove" },
    });
    expect(lines.some((line) => line.level === "error")).toBe(true);
  });
});
