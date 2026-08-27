import { describe, expect, it } from "vitest";

import {
  SetupProgressSchema,
  isSetupFinished,
  stepFlag,
  type SetupProgress,
} from "../setup-progress.schema";

/**
 * The dock decides what to show from this payload, so the refusals matter more
 * than the happy path: a step id nobody taught the UI about must not reach a
 * component that will try to render a title for it.
 */

const VALID = {
  tenantId: "00000000-0000-0000-0000-000000000001",
  steps: [
    { id: "tenant", isDone: true },
    { id: "google", isDone: true },
    { id: "source", isDone: true },
    { id: "facebook", isDone: true },
    { id: "group", isDone: true },
    { id: "firstPost", isDone: false },
  ],
  doneCount: 5,
  requiredCount: 5,
  isReady: true,
};

describe("SetupProgressSchema — refusals", () => {
  it("rejects an unknown step id instead of rendering it", () => {
    const payload = { ...VALID, steps: [{ id: "billing", isDone: true }] };
    expect(SetupProgressSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects a missing isDone flag", () => {
    const payload = { ...VALID, steps: [{ id: "tenant" }] };
    expect(SetupProgressSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects a negative doneCount", () => {
    expect(SetupProgressSchema.safeParse({ ...VALID, doneCount: -1 }).success).toBe(false);
  });

  it("rejects a requiredCount of zero — a progress bar cannot divide by it", () => {
    expect(SetupProgressSchema.safeParse({ ...VALID, requiredCount: 0 }).success).toBe(false);
  });

  it("accepts the shape the route actually sends", () => {
    expect(SetupProgressSchema.safeParse(VALID).success).toBe(true);
  });
});

describe("isSetupFinished", () => {
  it("is false while the goal step is still open", () => {
    expect(isSetupFinished(VALID as SetupProgress)).toBe(false);
  });

  it("is true only when EVERY step including firstPost is done", () => {
    const done = {
      ...VALID,
      steps: VALID.steps.map((step) => ({ ...step, isDone: true })),
    } as SetupProgress;
    expect(isSetupFinished(done)).toBe(true);
  });

  it("is false when a step is missing from the payload entirely", () => {
    const partial = {
      ...VALID,
      steps: VALID.steps.filter((step) => step.id !== "group").map((step) => ({
        ...step,
        isDone: true,
      })),
    } as SetupProgress;
    expect(isSetupFinished(partial)).toBe(false);
  });
});

describe("stepFlag", () => {
  it("reads one step by id", () => {
    expect(stepFlag(VALID as SetupProgress, "firstPost")).toBe(false);
    expect(stepFlag(VALID as SetupProgress, "google")).toBe(true);
  });

  it("answers false for a step the payload does not carry", () => {
    const partial = { ...VALID, steps: [] } as unknown as SetupProgress;
    expect(stepFlag(partial, "google")).toBe(false);
  });
});
