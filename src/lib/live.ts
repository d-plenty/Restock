// Tells screens to re-read after something changes in the database.
const listeners = new Set<() => void>();
let pending = false;
// 0.15.1: counts every change, so what's worked out from the database can be shared until the next one.
let generation = 0;

/** Goes up by one at every change to the database. */
export const changeCount = (): number => generation;
// 0.18.2: and one for the price history only, so what's read of it can be kept while other things
// change (a tick on the list, a setting). A change that doesn't say otherwise may have touched it.
let pricesGeneration = 0;
/** Goes up when the price history may have changed. */
export const pricesChangeCount = (): number => pricesGeneration;

/** Something changed. `scope` 'noprices': the price history didn't (db.ts knows from its writes). */
export function changed(scope?: 'noprices'): void {
  generation++;
  if (scope !== 'noprices') pricesGeneration++;
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    listeners.forEach((fn) => fn());
  });
}

/** 0.18.2: screens read again, with nothing changed (newer answers are ready: recs.ts). */
export function poke(): void {
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
