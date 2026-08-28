import { describe, expect, it, vi } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

/**
 * `remove` (E8.4) and `countWorkers` (E11) against a stubbed BullMQ Queue: what
 * matters here is the translation of BullMQ's answers into what the usecases act
 * on — a boolean for remove, and a census that must NEVER throw for the health
 * banner. The real Redis round trip is covered by the publish smoke script.
 */

const removeMock = vi.fn();
const addMock = vi.fn();
const closeMock = vi.fn();
const getWorkersMock = vi.fn();

vi.mock("bullmq", () => ({
  Queue: class {
    remove = removeMock;
    add = addMock;
    close = closeMock;
    getWorkers = getWorkersMock;
  },
}));

const { makeBullMqJobQueue } = await import("../bullmq-job-queue");

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

describe("BullMqJobQueue.countWorkers", () => {
  // --- Edge cases first -----------------------------------------------------

  it("answers `reachable: false` instead of throwing when Redis is unreachable", async () => {
    getWorkersMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    const { queue, lines } = makeQueue();

    // The whole point: the health screen must still render.
    expect(await queue.countWorkers()).toEqual({ workersOnline: 0, reachable: false });
    expect(
      lines.some(
        (line) => line.level === "warn" && line.context?.error_code === "QUEUE_ERROR",
      ),
    ).toBe(true);
  });

  it("does not count the placeholder a broker without CLIENT LIST returns", async () => {
    getWorkersMock.mockResolvedValueOnce([{ name: "GCP does not support client list" }]);
    const { queue, lines } = makeQueue();

    expect(await queue.countWorkers()).toEqual({ workersOnline: 0, reachable: false });
    expect(lines.some((line) => line.context?.reason === "CLIENT_LIST_UNSUPPORTED")).toBe(true);
  });

  it("treats a non-array answer as no workers rather than crashing", async () => {
    getWorkersMock.mockResolvedValueOnce(undefined);
    const { queue } = makeQueue();

    expect(await queue.countWorkers()).toEqual({ workersOnline: 0, reachable: true });
  });

  it("reports zero workers on a reachable but empty registry", async () => {
    getWorkersMock.mockResolvedValueOnce([]);
    const { queue } = makeQueue();

    expect(await queue.countWorkers()).toEqual({ workersOnline: 0, reachable: true });
  });

  // --- Happy path -----------------------------------------------------------

  it("counts the workers the broker knows about", async () => {
    getWorkersMock.mockResolvedValueOnce([
      { name: "bull:bXlzcA==", addr: "172.18.0.4:52344" },
      { name: "bull:bXlzcA==", addr: "172.18.0.5:52346" },
    ]);
    const { queue } = makeQueue();

    expect(await queue.countWorkers()).toEqual({ workersOnline: 2, reachable: true });
  });
});
