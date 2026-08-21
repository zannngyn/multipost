import { describe, expect, it, vi } from "vitest";

import {
  CAPTION_FANOUT_CONCURRENCY,
  describeFanOut,
  fanOutPlan,
  runCaptionFanOut,
  type CaptionFanOutEvents,
} from "./caption-fanout";

/**
 * "Viết caption cho N trang". The rule under test throughout: ONE channel
 * failing must not stop the others (CLAUDE.md business rule 6), and every
 * channel must end up with either a caption or a stated reason — never with
 * silence.
 */

/** Records what the UI would have drawn. */
function recorder() {
  const texts: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const pending: string[] = [];
  const settled: string[] = [];
  const events: CaptionFanOutEvents = {
    onPending: (channelId) => pending.push(channelId),
    onText: (channelId, text) => {
      texts[channelId] = text;
    },
    onError: (channelId, reason) => {
      errors[channelId] = reason;
    },
    onSettled: (channelId) => settled.push(channelId),
  };
  return { texts, errors, pending, settled, events };
}

describe("fanOutPlan", () => {
  it("plans nothing for an empty selection", () => {
    expect(fanOutPlan([])).toEqual({ channelIds: [], concurrency: 1 });
  });

  it("drops blanks and duplicates — two calls racing on one tab is a bug", () => {
    expect(fanOutPlan(["a", "  ", "a", "b"]).channelIds).toEqual(["a", "b"]);
  });

  it("never starts more workers than there are channels", () => {
    expect(fanOutPlan(["a"]).concurrency).toBe(1);
    expect(fanOutPlan(["a", "b"]).concurrency).toBe(2);
  });

  it("caps concurrency — the AI gateway is rate-limited per tenant", () => {
    const many = ["a", "b", "c", "d", "e", "f"];
    expect(fanOutPlan(many).concurrency).toBe(CAPTION_FANOUT_CONCURRENCY);
  });
});

describe("runCaptionFanOut", () => {
  it("does nothing at all for an empty selection", async () => {
    const sink = recorder();
    const generate = vi.fn();
    await runCaptionFanOut({ channelIds: [], generate, events: sink.events });
    expect(generate).not.toHaveBeenCalled();
    expect(sink.settled).toEqual([]);
  });

  it("writes each channel's caption onto its OWN tab", async () => {
    const sink = recorder();
    await runCaptionFanOut({
      channelIds: ["lady", "camilla", "devis"],
      concurrency: 1,
      generate: (channelId) => Promise.resolve({ text: `caption cho ${channelId}` }),
      events: sink.events,
    });

    expect(sink.texts).toEqual({
      lady: "caption cho lady",
      camilla: "caption cho camilla",
      devis: "caption cho devis",
    });
    expect(sink.errors).toEqual({});
  });

  it("calls once per channel, never twice", async () => {
    const sink = recorder();
    const generate = vi.fn((channelId: string) => Promise.resolve({ text: channelId }));
    await runCaptionFanOut({
      channelIds: ["a", "b", "c"],
      generate,
      events: sink.events,
    });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps going when ONE channel throws, and names the reason", async () => {
    const sink = recorder();
    await runCaptionFanOut({
      channelIds: ["lady", "camilla", "devis"],
      concurrency: 1,
      generate: (channelId) =>
        channelId === "camilla"
          ? Promise.reject(new Error("Máy chủ AI đang bận."))
          : Promise.resolve({ text: `ok ${channelId}` }),
      events: sink.events,
    });

    expect(sink.texts).toEqual({ lady: "ok lady", devis: "ok devis" });
    expect(sink.errors.camilla).toContain("Máy chủ AI đang bận.");
    // Every channel settled, so a progress counter can never stall.
    expect(sink.settled.sort()).toEqual(["camilla", "devis", "lady"]);
  });

  it("treats an answer with no caption as that channel's failure, with the server's reason", async () => {
    const sink = recorder();
    await runCaptionFanOut({
      channelIds: ["lady"],
      generate: () => Promise.resolve({ reason: "Caption vi phạm quy tắc nội dung." }),
      events: sink.events,
    });
    expect(sink.texts).toEqual({});
    expect(sink.errors.lady).toBe("Caption vi phạm quy tắc nội dung.");
  });

  it("has a sentence even when the failure carries none", async () => {
    const sink = recorder();
    await runCaptionFanOut({
      channelIds: ["lady"],
      generate: () => Promise.resolve({}),
      events: sink.events,
    });
    expect(sink.errors.lady).toContain("AI không trả về caption");
  });

  it("never overwrites a tab with an empty string", async () => {
    const sink = recorder();
    await runCaptionFanOut({
      channelIds: ["lady"],
      generate: () => Promise.resolve({ text: "   " }),
      events: sink.events,
    });
    expect(sink.texts).toEqual({});
    expect(sink.errors.lady).toBeTruthy();
  });

  it("marks every channel pending before it settles — the tab dots move", async () => {
    const sink = recorder();
    await runCaptionFanOut({
      channelIds: ["a", "b"],
      concurrency: 1,
      generate: (channelId) => Promise.resolve({ text: channelId }),
      events: sink.events,
    });
    expect(sink.pending).toEqual(["a", "b"]);
    expect(sink.settled).toEqual(["a", "b"]);
  });

  it("stops writing once the run is superseded", async () => {
    const sink = recorder();
    let current = true;
    await runCaptionFanOut({
      channelIds: ["a", "b", "c"],
      concurrency: 1,
      isCurrent: () => current,
      generate: (channelId) => {
        // The operator pressed the button again while "a" was in flight.
        if (channelId === "a") current = false;
        return Promise.resolve({ text: channelId });
      },
      events: sink.events,
    });
    // Nothing from the abandoned run lands on a tab.
    expect(sink.texts).toEqual({});
    expect(sink.settled).toEqual([]);
  });

  it("runs channels concurrently up to the cap", async () => {
    const sink = recorder();
    let inFlight = 0;
    let peak = 0;
    await runCaptionFanOut({
      channelIds: ["a", "b", "c", "d", "e"],
      concurrency: 2,
      generate: async (channelId) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { text: channelId };
      },
      events: sink.events,
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(Object.keys(sink.texts)).toHaveLength(5);
  });
});

describe("describeFanOut", () => {
  it("says nothing when no run has happened", () => {
    expect(describeFanOut({ isRunning: false, done: 0, total: 0, failed: 0 })).toBe("");
  });

  it("counts progress while it runs", () => {
    expect(describeFanOut({ isRunning: true, done: 2, total: 3, failed: 0 })).toBe(
      "Đang viết caption — đã xong 2/3 trang…",
    );
  });

  it("reports a clean finish", () => {
    expect(describeFanOut({ isRunning: false, done: 3, total: 3, failed: 0 })).toBe(
      "Đã viết caption cho 3 trang.",
    );
  });

  it("NAMES the failures instead of only counting the successes", () => {
    const note = describeFanOut({ isRunning: false, done: 3, total: 3, failed: 1 });
    expect(note).toContain("2/3");
    expect(note).toContain("1 trang lỗi");
    expect(note).toContain("Viết lại");
  });
});
