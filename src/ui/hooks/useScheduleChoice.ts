"use client";

import { useCallback, useState } from "react";

import { validateScheduleInput } from "@/ui/schemas/scheduled.schema";

/**
 * "Đăng ngay" vs "Hẹn giờ đăng" (E8.1 UI), shared by the compose wizard and the
 * bulk screen so both speak the same rules and the same sentences.
 *
 * DEFAULT IS "đăng ngay": scheduling is opt-in, exactly like the auto-publish
 * toggle. A screen that silently defers a post the operator meant to publish
 * now is the same class of surprise as one that publishes without approval.
 *
 * `resolve()` is the gate before the request: it returns the instant to send,
 * or false after putting the reason on screen. The SERVER re-validates and has
 * the final say — this only saves a round trip.
 */

export type ScheduleMode = "now" | "scheduled";

export type ResolvedSchedule = { ok: true; scheduledAt: string | null } | { ok: false };

export interface ScheduleChoice {
  mode: ScheduleMode;
  value: string;
  error: string | null;
  setMode: (mode: ScheduleMode) => void;
  setValue: (value: string) => void;
  resolve: () => ResolvedSchedule;
  /** Puts a stored choice back on screen and re-judges it against the clock. */
  restore: (choice: { mode: ScheduleMode; value: string }) => void;
  reset: () => void;
}

export function useScheduleChoice(): ScheduleChoice {
  const [mode, setModeState] = useState<ScheduleMode>("now");
  const [value, setValueState] = useState("");
  const [error, setError] = useState<string | null>(null);

  const setMode = useCallback((next: ScheduleMode) => {
    setError(null);
    setModeState(next);
  }, []);

  const setValue = useCallback((next: string) => {
    setError(null);
    setValueState(next);
  }, []);

  const resolve = useCallback((): ResolvedSchedule => {
    if (mode === "now") return { ok: true, scheduledAt: null };

    // Validated against the clock AT SUBMIT TIME, not at render: a form left
    // open for an hour must not send a time that quietly became the past.
    const verdict = validateScheduleInput(value, Date.now());
    if (!verdict.ok) {
      setError(verdict.message);
      return { ok: false };
    }
    setError(null);
    return { ok: true, scheduledAt: verdict.iso };
  }, [mode, value]);

  /**
   * Restores a saved choice (E10 draft) and judges it NOW, not against the clock
   * of the day it was saved.
   *
   * It validates the value it is given rather than the one in state: React has
   * not re-rendered yet at this point, so `resolve()` would still be looking at
   * the previous value. The old verdict is never restored — an hour that was in
   * the future yesterday is a lie today, and a stale red line under an untouched
   * field is worse than none.
   */
  const restore = useCallback((choice: { mode: ScheduleMode; value: string }) => {
    const nextMode: ScheduleMode = choice?.mode === "scheduled" ? "scheduled" : "now";
    const nextValue = typeof choice?.value === "string" ? choice.value : "";
    setModeState(nextMode);
    setValueState(nextValue);

    if (nextMode !== "scheduled" || nextValue.trim().length === 0) {
      setError(null);
      return;
    }
    const verdict = validateScheduleInput(nextValue, Date.now());
    setError(verdict.ok ? null : verdict.message);
  }, []);

  const reset = useCallback(() => {
    setModeState("now");
    setValueState("");
    setError(null);
  }, []);

  return { mode, value, error, setMode, setValue, resolve, restore, reset };
}
