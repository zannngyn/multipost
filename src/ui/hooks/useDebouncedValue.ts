"use client";

import { useEffect, useState } from "react";

/**
 * Holds a value back until the user stops changing it.
 *
 * Search boxes that query on every keystroke do two bad things at once: they
 * burn a Drive API call per character, and they flash the skeleton between them
 * (core-feedback-states: debounce the INPUT, do not blink the list).
 */
export function useDebouncedValue<T>(value: T, delayMs = 350): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    if (value === settled) return;

    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, settled, delayMs]);

  return settled;
}
