"use client";

import { useState, useRef, useEffect } from "react";
import {
  Calendar as CalendarIcon,
  Clock,
  ChevronLeft,
  ChevronRight,
  Flame,
  Sun,
  Utensils,
  Moon,
  Sparkles,
} from "lucide-react";

import { cn } from "@/shared/utils";
import {
  MAX_SCHEDULE_AHEAD_DAYS,
  formatCountdown,
  formatScheduledAt,
  timeZoneLabel,
  validateScheduleInput,
  toDateTimeLocalValue,
  scheduleInputBounds,
} from "@/ui/schemas/scheduled.schema";

export interface ScheduleTimeFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  disabledReason?: string;
  error?: string | null;
  nowMs: number;
}

const GOLDEN_HOURS = [
  { label: "08:00 (Sáng)", hour: 8, minute: 0, icon: Sun },
  { label: "11:30 (Trưa)", hour: 11, minute: 30, icon: Utensils },
  { label: "15:30 (Chiều)", hour: 15, minute: 30, icon: Sparkles },
  { label: "19:30 (Tối vàng)", hour: 19, minute: 30, icon: Flame },
  { label: "20:30 (Tối)", hour: 20, minute: 30, icon: Moon },
];

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const ALL_MINUTES = Array.from({ length: 60 }, (_, i) => i);

export function ScheduleTimeField({
  id,
  label,
  value,
  onChange,
  disabled,
  disabledReason,
  error,
  nowMs,
}: ScheduleTimeFieldProps) {
  const zone = timeZoneLabel();
  const trimmed = typeof value === "string" ? value.trim() : "";
  // nowMs is 0 until the client reports its clock. Everything below reads it
  // instead of calling Date.now(): an impure call during render gives a
  // different answer on every re-render, and React's purity rule rejects it.
  const clockKnown = nowMs > 0;
  const verdict = clockKnown && trimmed.length > 0 ? validateScheduleInput(trimmed, nowMs) : null;

  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [isTimeDropdownOpen, setIsTimeDropdownOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Parse current date & time from value. `new Date("2026-09-15T20:00")` is
  // spec-defined local time — this is NOT the locale-dependent string parsing
  // that once read "1/9/2026" as 9 January.
  //
  // No useMemo: building one Date is cheaper than the memo bookkeeping, and a
  // hand-written dependency list here is a second place to keep in sync.
  const parsedDate = ((): Date => {
    const fallback = new Date(clockKnown ? nowMs + 3600000 : 0);
    if (!trimmed) return fallback;
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? fallback : d;
  })();

  const [viewYear, setViewYear] = useState(parsedDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(parsedDate.getMonth()); // 0-indexed

  // Close popovers on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsCalendarOpen(false);
        setIsTimeDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedYear = parsedDate.getFullYear();
  const selectedMonth = parsedDate.getMonth();
  const selectedDay = parsedDate.getDate();
  const curHour = parsedDate.getHours();
  const curMinute = parsedDate.getMinutes();
  const selectedHoursStr = curHour.toString().padStart(2, "0");
  const selectedMinutesStr = curMinute.toString().padStart(2, "0");
  const timeString = `${selectedHoursStr}:${selectedMinutesStr}`;

  const setDatePart = (year: number, month: number, day: number) => {
    const updated = new Date(year, month, day, parsedDate.getHours(), parsedDate.getMinutes());
    onChange(toDateTimeLocalValue(updated));
    setIsCalendarOpen(false);
  };

  const setTimePart = (hours: number, minutes: number) => {
    const validH = Math.max(0, Math.min(23, hours));
    const validM = Math.max(0, Math.min(59, minutes));
    const updated = new Date(
      parsedDate.getFullYear(),
      parsedDate.getMonth(),
      parsedDate.getDate(),
      validH,
      validM,
    );
    onChange(toDateTimeLocalValue(updated));
  };

  // Calendar calculations
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfWeek = (new Date(viewYear, viewMonth, 1).getDay() + 6) % 7; // Monday = 0
  const daysArray = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  // ONE definition of the window, shared with the validator: the calendar can
  // never disagree with the error message the field shows afterwards.
  const bounds = scheduleInputBounds(clockKnown ? nowMs : 0);
  const today = new Date(clockKnown ? nowMs : 0);
  const maxDate = new Date((clockKnown ? nowMs : 0) + MAX_SCHEDULE_AHEAD_DAYS * 86400000);

  const isDayDisabled = (day: number) => {
    const checkDate = new Date(viewYear, viewMonth, day, 23, 59, 59);
    const checkDateStart = new Date(viewYear, viewMonth, day, 0, 0, 0);
    return checkDate.getTime() < today.getTime() || checkDateStart.getTime() > maxDate.getTime();
  };

  const isDaySelected = (day: number) => {
    return (
      viewYear === selectedYear &&
      viewMonth === selectedMonth &&
      day === selectedDay
    );
  };

  const isToday = (day: number) => {
    return (
      viewYear === today.getFullYear() &&
      viewMonth === today.getMonth() &&
      day === today.getDate()
    );
  };

  const formatSelectedDateLabel = () => {
    // Before the clock is known there is no honest date to show, and printing
    // 01/01/1970 for a split second reads as a bug.
    if (!clockKnown && !trimmed) return "Chọn ngày";
    const d = parsedDate;
    const days = ["Chủ Nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
    const dayName = days[d.getDay()];
    return `${dayName}, ${d.getDate().toString().padStart(2, "0")}/${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getFullYear()}`;
  };

  const displayError = error || (!verdict?.ok ? verdict?.message : null);
  const isInvalidTime = Boolean(error) || Boolean(!verdict?.ok && trimmed.length > 0);

  // The two buttons ARE the control now, so they carry what the native input
  // used to: the invalid state and the pointers to the sentences explaining it.
  // Without these a screen reader announces a plain button and the reason is
  // just decorative text somewhere below.
  const errorId = `${id}-error`;
  const lockedId = `${id}-locked`;
  const describedBy =
    [displayError ? errorId : null, disabled && disabledReason ? lockedId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const handleGoldenHourClick = (slotHour: number, slotMinute: number) => {
    // No clock, no scheduling: rolling "today" over to "tomorrow" needs a real
    // now, and guessing one here would silently pick the wrong day.
    if (!clockKnown) return;
    const isCurDayToday = isToday(selectedDay);
    const now = new Date(nowMs);
    const slotTimeToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), slotHour, slotMinute);

    // If currently on "Today" and this golden hour has already passed today, roll over to Tomorrow
    if (isCurDayToday && slotTimeToday.getTime() <= now.getTime() + 60_000) {
      const tomorrow = new Date(now.getTime() + 86_400_000);
      const updated = new Date(
        tomorrow.getFullYear(),
        tomorrow.getMonth(),
        tomorrow.getDate(),
        slotHour,
        slotMinute,
      );
      onChange(toDateTimeLocalValue(updated));
    } else {
      setTimePart(slotHour, slotMinute);
    }
  };

  return (
    <div
      ref={popoverRef}
      className="flex flex-col gap-2.5 w-full"
      // The scheduling window, from the same helper the validator uses. The
      // native control used to publish it as min/max; with a custom picker it
      // would otherwise exist only inside a disabled-day check nobody can see.
      data-min={bounds.min}
      data-max={bounds.max}
    >
      <label htmlFor={id} className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </label>

      {/* Modern Date & Time Picker Controls */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Date Button (Opens Calendar Popover) */}
        <div className="relative">
          <button
            id={id}
            type="button"
            role="combobox"
            aria-haspopup="dialog"
            disabled={disabled}
            aria-invalid={isInvalidTime || undefined}
            aria-describedby={describedBy}
            aria-expanded={isCalendarOpen}
            aria-controls={`${id}-calendar`}
            onClick={() => {
              setIsCalendarOpen(!isCalendarOpen);
              setIsTimeDropdownOpen(false);
            }}
            className={cn(
              "flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-input bg-card px-3.5 text-xs font-semibold text-foreground shadow-xs transition-all hover:border-primary/50 hover:bg-muted/30 outline-none focus:ring-2 focus:ring-primary/30",
              isCalendarOpen && "border-primary ring-2 ring-primary/20",
              isInvalidTime && "border-destructive/60 bg-destructive/5 text-destructive",
              disabled && "opacity-50 cursor-not-allowed",
            )}
          >
            <CalendarIcon className={cn("size-4 shrink-0", isInvalidTime ? "text-destructive" : "text-primary")} />
            <span>{formatSelectedDateLabel()}</span>
          </button>

          {/* Calendar Popover (Opens UPWARD) */}
          {isCalendarOpen && (
            <div
              id={`${id}-calendar`}
              role="dialog"
              aria-label="Chọn ngày đăng"
              className="absolute bottom-full mb-2 left-0 z-50 w-72 rounded-2xl border border-border bg-card p-3.5 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-150"
            >
              {/* Quick Date Presets */}
              <div className="flex items-center justify-between gap-1 mb-3 border-b border-border/60 pb-2">
                <button
                  type="button"
                  onClick={() => setDatePart(today.getFullYear(), today.getMonth(), today.getDate())}
                  className="rounded-lg px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                >
                  Hôm nay
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const t = new Date(today.getTime() + 86400000);
                    setDatePart(t.getFullYear(), t.getMonth(), t.getDate());
                  }}
                  className="rounded-lg px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                >
                  Ngày mai
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const t = new Date(today.getTime() + 2 * 86400000);
                    setDatePart(t.getFullYear(), t.getMonth(), t.getDate());
                  }}
                  className="rounded-lg px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                >
                  Ngày mốt
                </button>
              </div>

              {/* Month / Year Navigator */}
              <div className="flex items-center justify-between mb-2.5 px-1">
                <span className="text-xs font-bold text-foreground">
                  Tháng {viewMonth + 1}, {viewYear}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={prevMonth}
                    className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={nextMonth}
                    className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </div>
              </div>

              {/* Day Headers (T2 - CN) */}
              <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-muted-foreground mb-1">
                <span>T2</span>
                <span>T3</span>
                <span>T4</span>
                <span>T5</span>
                <span>T6</span>
                <span>T7</span>
                <span className="text-amber-500">CN</span>
              </div>

              {/* Calendar Days Grid */}
              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: firstDayOfWeek }).map((_, i) => (
                  <div key={`empty-${i}`} className="size-8" />
                ))}

                {daysArray.map((day) => {
                  const isDisabled = isDayDisabled(day);
                  const isSelected = isDaySelected(day);
                  const isCurToday = isToday(day);

                  return (
                    <button
                      key={day}
                      type="button"
                      disabled={isDisabled}
                      onClick={() => setDatePart(viewYear, viewMonth, day)}
                      className={cn(
                        "flex size-8 cursor-pointer items-center justify-center rounded-lg text-xs font-medium transition-all select-none",
                        isSelected
                          ? "bg-primary text-primary-foreground font-bold shadow-xs scale-105"
                          : isCurToday
                            ? "border border-primary text-primary font-semibold hover:bg-primary/10"
                            : "text-foreground hover:bg-muted/70",
                        isDisabled && "opacity-25 cursor-not-allowed hover:bg-transparent text-muted-foreground",
                      )}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Detailed Time Selector Popover (Hour & Minute Selector) */}
        <div className="relative">
          <button
            type="button"
            role="combobox"
            aria-haspopup="dialog"
            disabled={disabled}
            aria-label={`${label} — giờ`}
            aria-invalid={isInvalidTime || undefined}
            aria-describedby={describedBy}
            aria-expanded={isTimeDropdownOpen}
            aria-controls={`${id}-time`}
            onClick={() => {
              setIsTimeDropdownOpen(!isTimeDropdownOpen);
              setIsCalendarOpen(false);
            }}
            className={cn(
              "flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-input bg-card px-3.5 text-xs font-semibold text-foreground shadow-xs transition-all hover:border-primary/50 hover:bg-muted/30 outline-none focus:ring-2 focus:ring-primary/30",
              isTimeDropdownOpen && "border-primary ring-2 ring-primary/20",
              isInvalidTime && "border-destructive/60 bg-destructive/5 text-destructive",
              disabled && "opacity-50 cursor-not-allowed",
            )}
          >
            <Clock className={cn("size-4 shrink-0", isInvalidTime ? "text-destructive" : "text-primary")} />
            <span className="font-mono text-sm">{timeString}</span>
          </button>

          {/* Time Picker 2-Column Popover (Opens UPWARD with strict overflow control) */}
          {isTimeDropdownOpen && (
            <div
              id={`${id}-time`}
              role="dialog"
              aria-label="Chọn giờ đăng"
              className="absolute bottom-full mb-2 left-0 z-50 w-60 overflow-hidden rounded-2xl border border-border bg-card p-3 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-150"
            >
              {/* Direct Hour:Minute Input Bar */}
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-border/70">
                <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                  Giờ hẹn
                </span>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    max={23}
                    aria-label="Giờ"
                    // Uncontrolled + keyed on the selected time: typing stays
                    // free-form (a half-typed "1" must not snap to 01), and a
                    // change made elsewhere in the popover remounts the input
                    // with the new value. The previous version synced it with a
                    // setState inside an effect, which re-renders twice.
                    key={`hour-${selectedHoursStr}`}
                    defaultValue={selectedHoursStr}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!Number.isNaN(val) && val >= 0 && val <= 23) {
                        setTimePart(val, curMinute);
                      }
                    }}
                    className="w-10 h-7 rounded-md border border-input bg-background text-center text-xs font-bold font-mono outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  />
                  <span className="font-bold text-muted-foreground">:</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    aria-label="Phút"
                    key={`minute-${selectedMinutesStr}`}
                    defaultValue={selectedMinutesStr}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!Number.isNaN(val) && val >= 0 && val <= 59) {
                        setTimePart(curHour, val);
                      }
                    }}
                    className="w-10 h-7 rounded-md border border-input bg-background text-center text-xs font-bold font-mono outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  />
                  <button
                    type="button"
                    onClick={() => setIsTimeDropdownOpen(false)}
                    className="ml-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-bold text-primary-foreground hover:opacity-90 cursor-pointer shadow-xs"
                  >
                    Xong
                  </button>
                </div>
              </div>

              {/* 2 Scroll Columns: Hours (00-23) & Minutes (00-59) */}
              <div className="grid grid-cols-2 gap-2 h-44 max-h-44 min-h-0 overflow-hidden">
                {/* Hours Column */}
                <div className="flex flex-col min-h-0 h-full border border-border/50 rounded-xl bg-muted/20 p-1">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase text-center py-0.5 border-b border-border/40 shrink-0">
                    Giờ
                  </span>
                  <div className="flex flex-col gap-0.5 overflow-y-auto flex-1 p-0.5 min-h-0">
                    {HOURS.map((h) => {
                      const isCur = curHour === h;
                      return (
                        <button
                          key={h}
                          type="button"
                          onClick={() => setTimePart(h, curMinute)}
                          className={cn(
                            "rounded-lg py-1 text-xs font-mono font-medium transition-colors cursor-pointer text-center shrink-0",
                            isCur
                              ? "bg-primary text-primary-foreground font-bold shadow-xs scale-100"
                              : "text-foreground hover:bg-muted",
                          )}
                        >
                          {h.toString().padStart(2, "0")}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Minutes Column (00 - 59) */}
                <div className="flex flex-col min-h-0 h-full border border-border/50 rounded-xl bg-muted/20 p-1">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase text-center py-0.5 border-b border-border/40 shrink-0">
                    Phút
                  </span>
                  <div className="flex flex-col gap-0.5 overflow-y-auto flex-1 p-0.5 min-h-0">
                    {ALL_MINUTES.map((m) => {
                      const isCur = curMinute === m;
                      return (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setTimePart(curHour, m)}
                          className={cn(
                            "rounded-lg py-1 text-xs font-mono font-medium transition-colors cursor-pointer text-center shrink-0",
                            isCur
                              ? "bg-primary text-primary-foreground font-bold shadow-xs scale-100"
                              : "text-foreground hover:bg-muted",
                          )}
                        >
                          {m.toString().padStart(2, "0")}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Quick Golden Hours Chips (Single clean row, no cramped wrapping) */}
      <div className="flex flex-col gap-1.5 pt-0.5 w-full">
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          Khung giờ vàng gợi ý
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {GOLDEN_HOURS.map((slot) => {
            const isMatch = curHour === slot.hour && curMinute === slot.minute;
            const Icon = slot.icon;

            return (
              <button
                key={slot.label}
                type="button"
                disabled={disabled}
                onClick={() => handleGoldenHourClick(slot.hour, slot.minute)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-all cursor-pointer",
                  isMatch
                    ? "border-primary bg-primary/10 text-primary font-bold shadow-xs ring-1 ring-primary/30"
                    : "border-border/70 bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
              >
                <Icon className="size-3 text-amber-500" />
                <span>{slot.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Feedback sentence or live error warning */}
      {verdict?.ok ? (
        <p className="text-xs text-muted-foreground leading-relaxed pt-0.5">
          Sẽ đăng lúc <span className="font-semibold text-foreground">{formatScheduledAt(verdict.iso)}</span> ({zone}) — {formatCountdown(verdict.delayMs)}.
        </p>
      ) : null}

      {displayError ? (
        <p id={errorId} role="alert" className="text-xs font-semibold text-destructive flex items-center gap-1 pt-0.5">
          <span>⚠️</span>
          <span>{displayError}</span>
        </p>
      ) : null}

      {disabled && disabledReason ? (
        <p id={lockedId} className="text-xs text-muted-foreground italic">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}
