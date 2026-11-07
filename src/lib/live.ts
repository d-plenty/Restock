// Tells screens to re-read after something changes in the database.
const listeners = new Set<() => void>();
let pending = false;

export function changed(): void {
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
