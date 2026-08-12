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

  const reset = useCallback(() => {
    setModeState("now");
    setValueState("");
    setError(null);
  }, []);

  return { mode, value, error, setMode, setValue, resolve, reset };
}
