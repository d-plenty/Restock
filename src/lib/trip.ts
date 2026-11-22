// 0.12.10: a shopping trip that survives leaving the app. Shopping mode's state (which shops, which
// are done, where each thing was ticked) lived only on the screen: Android closing Restock in the
// background, or stepping out to check something, lost the trip and you were back on Home. It is
// now kept on this phone (never sent anywhere), so the trip can be picked up: "Resume shopping", or
// "Start fresh". The ticks themselves were always kept: they are the list.

export interface SavedTrip {
  /** Which list it was started from. */
  section: string;
  /** The shops you said you were going to. */
  chosen: string[];
  /** Lines skipped for this trip (out of stock). */
  skip: string[];
  /** The shop's page that was open ('all': everything in one list). */
  at?: string;
  doneAt: string[];
  /** Where each thing was ticked: [line id, shop]. */
  gotAt: [string, string][];
  /** Shopping mode was on screen when this was saved (false: you stepped out with Pause or Back). */
  open: boolean;
  /** When it was last touched (ms). */
  saved: number;
}

const KEY = 'restock.trip';
/** A trip older than this is forgotten: it's another day's shop. */
export const TRIP_KEEP_MS = 18 * 60 * 60 * 1000;
/** Restock closed mid-shop and opened again within this long goes straight back into the shop. */
export const TRIP_REOPEN_MS = 3 * 60 * 60 * 1000;

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A saved trip read back, or undefined when it isn't one (pure, for testing). */
export function parseTrip(raw: string | null | undefined, now: number): SavedTrip | undefined {
  if (!raw) return undefined;
  try {
    const t = JSON.parse(raw) as Partial<SavedTrip>;
    if (!t || typeof t !== 'object' || typeof t.section !== 'string' || !strings(t.chosen) || !t.chosen.length) return undefined;
    if (typeof t.saved !== 'number' || now - t.saved > TRIP_KEEP_MS || t.saved > now + 60_000) return undefined;
    return {
      section: t.section,
      chosen: t.chosen.slice(0, 40),
      skip: strings(t.skip) ? t.skip.slice(0, 500) : [],
      at: typeof t.at === 'string' ? t.at : undefined,
      doneAt: strings(t.doneAt) ? t.doneAt.slice(0, 40) : [],
      gotAt: Array.isArray(t.gotAt)
        ? (t.gotAt.filter((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string') as [string, string][]).slice(0, 1000)
        : [],
      open: t.open === true,
      saved: t.saved,
    };
  } catch {
    return undefined;
  }
}

/** Should Restock go straight back into the shop when it opens? Only if it was closed mid-shop, not long ago. */
export const reopensTrip = (t: SavedTrip | undefined, now: number): boolean => !!t && t.open && now - t.saved <= TRIP_REOPEN_MS;

let cache: { raw: string | null; trip: SavedTrip | undefined } | undefined;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The trip kept on this phone, if there is one and it isn't stale. */
export function loadTrip(now = Date.now()): SavedTrip | undefined {
  const raw = read();
  if (!cache || cache.raw !== raw) cache = { raw, trip: parseTrip(raw, now) };
  else if (cache.trip && now - cache.trip.saved > TRIP_KEEP_MS) cache = { raw, trip: undefined };
  return cache.trip;
}

export function saveTrip(t: Omit<SavedTrip, 'saved'>, now = Date.now()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...t, saved: now }));
  } catch {
    // no room, or private mode: the trip just isn't kept
  }
  tell();
}

export function clearTrip(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
  tell();
}

/** For useSyncExternalStore: told whenever the trip is saved or cleared. */
export function subscribeTrip(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// "Resume shopping" pressed somewhere other than the list (Home): the list opens the trip when it shows.
let wanted = false;
export const askResume = () => {
  wanted = true;
  tell();
};
export const takeResume = (): boolean => {
  const w = wanted;
  wanted = false;
  return w;
};
export const resumeAsked = () => wanted;
