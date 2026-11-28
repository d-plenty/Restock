// 0.19.0: what the screens are waiting for. A screen that stays on "Loading…" used to say nothing
// about why (on one iPhone it stayed for good, and nothing on the phone said which read was stuck or
// what had gone wrong). Every read a screen starts (useLive) and every question put to the database
// (db.ts) is noted here while it's unanswered, with its last error; ScreenWaiting shows them once a
// screen has waited a while, with Copy, and the same lines go to Diagnostics → Quiet problems.

export interface Waiting {
  /** A screen's read ("your items") or a database question (its first words). */
  what: string;
  kind: 'screen' | 'database';
  since: number;
  /** How many times it has failed in a row, and what the last failure said. */
  failures: number;
  error?: string;
}

const open = new Map<number, Waiting>();
let next = 1;
/** The last database error, whatever asked (kept a minute, so a screen that waits can say it). */
let lastDbError: { at: number; text: string } | undefined;

/**
 * Plain names for the reads the main screens start (App.tsx names them once). The code's own names
 * can't be used: the built app shortens them to a letter or two.
 */
const names = new WeakMap<object, string>();
export function nameReads(list: [(...a: never[]) => unknown, string][]): void {
  for (const [fn, name] of list) names.set(fn, name);
}
export const plainName = (fn: (...a: never[]) => unknown): string => names.get(fn) ?? 'part of this screen';

/** Something started waiting. Returns how to say it ended, or failed (it stays, with its error, until it's tried again). */
export function waitingFor(what: string, kind: Waiting['kind'], before?: { failures: number; error?: string }): { done(): void; failed(e: unknown): void } {
  const id = next++;
  open.set(id, { what, kind, since: Date.now(), failures: before?.failures ?? 0, ...(before?.error ? { error: before.error } : {}) });
  return {
    done: () => void open.delete(id),
    failed: (e) => {
      open.delete(id);
      if (kind === 'database') lastDbError = { at: Date.now(), text: `${words(e)} (${what})` };
    },
  };
}

export const words = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 240);

/** Everything unanswered for at least `olderThan` ms, the longest wait first. */
export function waitingNow(olderThan = 0, now = Date.now()): Waiting[] {
  return [...open.values()].filter((w) => now - w.since >= olderThan || w.failures > 0).sort((a, b) => a.since - b.since);
}

/** What a waiting screen says: one line for each thing it's waiting on, and the last database error. */
export function waitingReport(now = Date.now()): string[] {
  const secs = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;
  const lines = waitingNow(1500, now)
    .slice(0, 8)
    .map((w) => `${w.kind === 'screen' ? 'Waiting for' : 'Database'}: ${w.what}, ${secs(now - w.since)}${w.failures ? `, failed ${w.failures}×` : ''}${w.error ? `. Last problem: ${w.error}` : ''}`);
  if (lastDbError && now - lastDbError.at < 60_000 && !lines.some((l) => l.includes(lastDbError!.text))) lines.push(`Last database problem: ${lastDbError.text}`);
  return lines;
}

/** For the tests. */
export function resetWaiting(): void {
  open.clear();
  lastDbError = undefined;
}
