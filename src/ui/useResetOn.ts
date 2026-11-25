import { useState } from 'react';

const FIRST: unknown[] = [];

/**
 * 0.15.1: when any of `deps` changes, `reset` runs while the screen draws (React's way to change
 * state because something it was given changed, in place of an effect that drew it twice). `reset`
 * may only set this component's own state. `first`: also on the first draw.
 */
export function useResetOn(deps: unknown[], reset: () => void, first = false): void {
  const [seen, setSeen] = useState<unknown[]>(() => (first ? FIRST : deps));
  if (depsChanged(seen, deps)) {
    setSeen(deps);
    reset();
  }
}

/** Whether `deps` differ from what was seen last time (each compared as React compares deps). */
export function depsChanged(seen: unknown[], deps: unknown[]): boolean {
  return seen === FIRST || seen.length !== deps.length || seen.some((d, i) => !Object.is(d, deps[i]));
}
