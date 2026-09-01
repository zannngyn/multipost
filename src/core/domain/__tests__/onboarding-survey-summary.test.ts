import { describe, expect, it } from "vitest";

import {
  summarizeOnboardingSurvey,
  type SurveyAnswers,
} from "../onboarding-survey-summary";

/**
 * Edge cases first (CLAUDE.md technical rule 1).
 *
 * THE invariant this whole file exists to protect: `null` (skipped / never
 * reached) and `[]` ("none of these") are DIFFERENT facts. Merge them and the
 * single most valuable number on the screen — "bao nhiêu người bỏ qua bước
 * này" — becomes meaningless. Every list assertion below therefore checks
 * `noAnswer` and `answeredNone` separately, never their sum.
 */

const answers = (over: Partial<SurveyAnswers> = {}): SurveyAnswers => ({
  sellerKind: null,
  currentTools: null,
  channelCount: null,
  focusChannels: null,
  completedAt: null,
  ...over,
});

// --- Refusals and empty input -----------------------------------------------

describe("summarizeOnboardingSurvey — refusals", () => {
  it("refuses a non-array instead of reporting zero tenants", () => {
    // A zero summary is a real answer ("no tenants yet"); a caller bug must not
    // be able to forge it.
    expect(() => summarizeOnboardingSurvey(undefined as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => summarizeOnboardingSurvey({ length: 2 } as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("summarises an empty platform as zeros, not as missing keys", () => {
    const summary = summarizeOnboardingSurvey([]);
    expect(summary.total).toBe(0);
    expect(summary.completed).toBe(0);
    expect(summary.notCompleted).toBe(0);
    expect(summary.sellerKind).toMatchObject({ total: 0, answered: 0, noAnswer: 0, byCode: [] });
    expect(summary.focusChannels).toMatchObject({ total: 0, noAnswer: 0, answeredNone: 0, votes: 0 });
  });
});

// --- The null / [] distinction ----------------------------------------------

describe("summarizeOnboardingSurvey — null is not []", () => {
  it("counts a skipped list and an explicit 'none of these' in different buckets", () => {
    const summary = summarizeOnboardingSurvey([
      answers({ currentTools: null }),
      answers({ currentTools: [] }),
      answers({ currentTools: ["smm_tool"] }),
    ]);

    expect(summary.currentTools.noAnswer).toBe(1);
    expect(summary.currentTools.answeredNone).toBe(1);
    expect(summary.currentTools.answered).toBe(1);
    expect(summary.currentTools.votes).toBe(1);
    // The two must never be summed into one "no data" bucket.
    expect(summary.currentTools.noAnswer).not.toBe(summary.currentTools.answeredNone + 1);
  });

  it("treats a tenant with NO profile row as no-answer, and still counts it in total", () => {
    // LEFT JOIN: most tenants predate the survey and have no row at all. They
    // must not vanish from the denominator.
    const summary = summarizeOnboardingSurvey([null, undefined, answers({ focusChannels: [] })]);

    expect(summary.total).toBe(3);
    expect(summary.focusChannels.noAnswer).toBe(2);
    expect(summary.focusChannels.answeredNone).toBe(1);
    expect(summary.focusChannels.answered).toBe(0);
    expect(summary.sellerKind.noAnswer).toBe(3);
  });

  it("keeps the buckets adding up to the total, for both answer shapes", () => {
    const summary = summarizeOnboardingSurvey([
      null,
      answers({ sellerKind: "agency", focusChannels: [] }),
      answers({ sellerKind: null, focusChannels: ["tiktok"] }),
      answers({ sellerKind: "  ", focusChannels: "tiktok" as never }),
    ]);

    const single = summary.sellerKind;
    expect(single.noAnswer + single.answered + single.unreadable).toBe(single.total);
    expect(single.total).toBe(4);

    const multi = summary.focusChannels;
    expect(multi.noAnswer + multi.answeredNone + multi.answered + multi.unreadable).toBe(multi.total);
    expect(multi.total).toBe(4);
  });
});

// --- Unreadable stored values -----------------------------------------------

describe("summarizeOnboardingSurvey — values it cannot read", () => {
  it("never files a blank single answer under 'skipped'", () => {
    // "no answer" is spelled null. An empty string is corrupt data, and hiding
    // it inside noAnswer would inflate exactly the number we care about.
    const summary = summarizeOnboardingSurvey([answers({ sellerKind: "" }), answers({ sellerKind: 7 as never })]);

    expect(summary.sellerKind.noAnswer).toBe(0);
    expect(summary.sellerKind.unreadable).toBe(2);
    expect(summary.sellerKind.byCode).toEqual([]);
  });

  it("counts an unreadable entry as a bad vote, not as a code and not as a skip", () => {
    const summary = summarizeOnboardingSurvey([
      answers({ focusChannels: ["facebook", null as never, ""] }),
    ]);

    expect(summary.focusChannels.answered).toBe(1);
    expect(summary.focusChannels.answeredNone).toBe(0);
    expect(summary.focusChannels.noAnswer).toBe(0);
    expect(summary.focusChannels.votes).toBe(1);
    expect(summary.focusChannels.unreadableVotes).toBe(2);
    expect(summary.focusChannels.byCode).toEqual([{ code: "facebook", count: 1 }]);
  });

  it("does not let a list column holding a scalar look like 'none of these'", () => {
    const summary = summarizeOnboardingSurvey([answers({ currentTools: "smm_tool" as never })]);

    expect(summary.currentTools.answeredNone).toBe(0);
    expect(summary.currentTools.noAnswer).toBe(0);
    expect(summary.currentTools.unreadable).toBe(1);
  });
});

// --- Ranking ----------------------------------------------------------------

describe("summarizeOnboardingSurvey — ranking", () => {
  it("ranks channels by picks, breaking ties by code so the order is stable", () => {
    const summary = summarizeOnboardingSurvey([
      answers({ focusChannels: ["facebook", "tiktok"] }),
      answers({ focusChannels: ["tiktok", "instagram"] }),
      answers({ focusChannels: ["tiktok"] }),
      answers({ focusChannels: ["zalo_oa"] }),
    ]);

    expect(summary.focusChannels.byCode).toEqual([
      { code: "tiktok", count: 3 },
      { code: "facebook", count: 1 },
      { code: "instagram", count: 1 },
      { code: "zalo_oa", count: 1 },
    ]);
    expect(summary.focusChannels.votes).toBe(6);
  });

  it("counts a repeated pick once per tenant — a vote is a tenant, not a click", () => {
    const summary = summarizeOnboardingSurvey([answers({ focusChannels: ["tiktok", "tiktok", " tiktok "] })]);

    expect(summary.focusChannels.byCode).toEqual([{ code: "tiktok", count: 1 }]);
    expect(summary.focusChannels.votes).toBe(1);
  });

  it("ranks seller kinds the same way", () => {
    const summary = summarizeOnboardingSurvey([
      answers({ sellerKind: "shop_owner" }),
      answers({ sellerKind: "shop_owner" }),
      answers({ sellerKind: "agency" }),
    ]);

    expect(summary.sellerKind.byCode).toEqual([
      { code: "shop_owner", count: 2 },
      { code: "agency", count: 1 },
    ]);
    expect(summary.sellerKind.answered).toBe(3);
  });
});

// --- Known vocabulary -------------------------------------------------------

describe("summarizeOnboardingSurvey — the known code list", () => {
  it("shows an option nobody picked as an explicit zero", () => {
    // "Nên làm TikTok hay Instagram trước" is unanswerable if a channel with no
    // votes is simply absent from the list.
    const summary = summarizeOnboardingSurvey([answers({ focusChannels: ["tiktok"] })], {
      focusChannels: ["facebook", "tiktok", "instagram"],
    });

    expect(summary.focusChannels.byCode).toEqual([
      { code: "tiktok", count: 1 },
      { code: "facebook", count: 0 },
      { code: "instagram", count: 0 },
    ]);
  });

  it("keeps a stored code that is no longer offered instead of dropping it", () => {
    // Dropping it would silently under-count and make the totals disagree with
    // the rows underneath.
    const summary = summarizeOnboardingSurvey([answers({ sellerKind: "retired_code" })], {
      sellerKind: ["agency"],
    });

    expect(summary.sellerKind.byCode).toEqual([
      { code: "retired_code", count: 1 },
      { code: "agency", count: 0 },
    ]);
    expect(summary.sellerKind.answered).toBe(1);
  });
});

// --- Completion -------------------------------------------------------------

describe("summarizeOnboardingSurvey — completion", () => {
  it("counts finished surveys, and an all-skipped-but-finished one is still finished", () => {
    const summary = summarizeOnboardingSurvey([
      answers({ completedAt: new Date("2026-08-26T10:00:00.000Z") }),
      answers({ completedAt: null }),
      null,
    ]);

    expect(summary.completed).toBe(1);
    expect(summary.notCompleted).toBe(2);
  });

  it("does not count an invalid date as finished", () => {
    const summary = summarizeOnboardingSurvey([
      answers({ completedAt: new Date("not a date") }),
      answers({ completedAt: "2026-08-26T10:00:00.000Z" as never }),
    ]);

    // An ISO string is accepted (a JSON round trip is a real caller); NaN is not.
    expect(summary.completed).toBe(1);
    expect(summary.notCompleted).toBe(1);
  });
});
