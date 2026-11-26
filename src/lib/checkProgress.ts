// 0.15.2: how far a price check has got, so one that was cut off (the app closed, the phone slept,
// iOS stopped it in the background) carries on from there next time instead of starting again. One
// more than a day old starts again from the beginning. Android's check keeps the same note in the
// same place (PriceChecker.java PROGRESS_KV), so either phone's check reads the other's the same way.
import { getKV, putKV } from './db';

/** Kept in the kv table under this key: this phone only (sync reads and writes only "settings"). */
export const PROGRESS_KEY = 'checkProgress';
/** A check cut off longer ago than this starts again. */
export const RESUME_FOR_MS = 24 * 3_600_000;

export interface CheckProgress {
  /** When this check started (the first part of it, for one carried on). */
  started: string;
  /** Products already checked. */
  done: string[];
}

/** Where to carry on from: what's already done, if the last check was cut off less than a day ago. */
export function carryOn(was: CheckProgress | undefined, now = Date.now()): CheckProgress {
  const then = was ? Date.parse(was.started) : NaN;
  if (was && Number.isFinite(then) && then <= now && now - then < RESUME_FOR_MS && Array.isArray(was.done)) return { started: was.started, done: [...was.done] };
  return { started: new Date(now).toISOString(), done: [] };
}

export const readProgress = () => getKV<CheckProgress>(PROGRESS_KEY).catch(() => undefined);
export const saveProgress = (p: CheckProgress) => putKV(PROGRESS_KEY, p);
export const clearProgress = () => putKV(PROGRESS_KEY, null);
