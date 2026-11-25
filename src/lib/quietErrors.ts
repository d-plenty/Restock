// 0.15.0: errors that background work catches and carries on from (a sync round, a price check, the
// database saving) used to vanish. They're noted here instead, the last 50, kept on this device
// only, and shown in Diagnostics under "Quiet problems", so a problem that keeps coming back can be
// seen and sent with feedback. Nothing here changes what the app does after the error.

export interface QuietError {
  at: string;
  where: string;
  message: string;
}

const KEY = 'restock-quiet-errors';
const MAX = 50;
let kept: QuietError[] | undefined;
const subs = new Set<() => void>();

function load(): QuietError[] {
  if (kept) return kept;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    kept = Array.isArray(v) ? (v as QuietError[]).slice(-MAX) : [];
  } catch {
    kept = [];
  }
  return kept;
}

/** Notes one error (a repeat of the newest is only counted once). */
export function noteQuiet(where: string, e: unknown): void {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  const list = load();
  const last = list[list.length - 1];
  if (last && last.where === where && last.message === message) last.at = new Date().toISOString();
  else list.push({ at: new Date().toISOString(), where, message });
  if (list.length > MAX) list.splice(0, list.length - MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // private mode or full: this session keeps them in memory
  }
  subs.forEach((f) => f());
}

/** For `.catch(quiet('sync'))`: notes the error, then carries on as `.catch(() => undefined)` did. */
export const quiet =
  (where: string) =>
  (e: unknown): undefined => {
    noteQuiet(where, e);
    return undefined;
  };

/** The noted errors, newest first. */
export const quietErrors = (): QuietError[] => [...load()].reverse();

export function clearQuiet(): void {
  kept = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing kept
  }
  subs.forEach((f) => f());
}

export function onQuiet(f: () => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}
