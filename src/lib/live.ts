// Tells screens to re-read after something changes in the database.
const listeners = new Set<() => void>();
let pending = false;
// 0.15.1: counts every change, so what's worked out from the database can be shared until the next one.
let generation = 0;

/** Goes up by one at every change to the database. */
export const changeCount = (): number => generation;

export function changed(): void {
  generation++;
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    listeners.forEach((fn) => fn());
  });
}

export function onChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
