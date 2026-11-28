// 0.18.2: how quick Restock is on this phone, in Settings → Help → Diagnostics → Speed: how long a
// screen took to show, how long the prices took to work out, and each time the screen was too busy
// to answer a tap for more than a moment (and whether a price check or a sync was running then).
// Kept on this phone only, the last 60, so a report about a slow iPad can come with real figures.
export interface SpeedNote {
  at: number;
  what: 'screen' | 'prices' | 'busy' | 'read' | 'hold';
  ms: number;
  /** The screen's name, for 'screen'; what was running, for 'busy'; what read, for 'read'. */
  detail?: string;
}

const KEY = 'restock.speedLog.v1';
const MAX = 60;
let notes: SpeedNote[] | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const running = new Set<string>();

function load(): SpeedNote[] {
  if (notes) return notes;
  try {
    const t = globalThis.localStorage?.getItem(KEY);
    const v = t ? (JSON.parse(t) as unknown) : [];
    notes = Array.isArray(v) ? (v as SpeedNote[]).filter((n) => n && typeof n.ms === 'number').slice(-MAX) : [];
  } catch {
    notes = [];
  }
  return notes;
}

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(load()));
    } catch {
      // not kept: only this session's show
    }
  }, 2000);
}

/** Notes one. Quick ones aren't worth keeping: screens under 300 ms, prices under 500 ms. */
export function noteSpeed(what: SpeedNote['what'], ms: number, detail?: string): void {
  if ((what === 'screen' && ms < 300) || (what === 'prices' && ms < 500) || (what === 'read' && ms < 500) || (what === 'hold' && ms < 1000)) return;
  const list = load();
  list.push({ at: Date.now(), what, ms: Math.round(ms), ...(detail ? { detail } : {}) });
  if (list.length > MAX) list.splice(0, list.length - MAX);
  save();
}

export const speedNotes = (): SpeedNote[] => [...load()].reverse();
export function clearSpeedNotes(): void {
  notes = [];
  save();
}

/** Something that can keep the screen busy started or ended ('price check', 'sync'), for the busy notes. */
export function busyWith(what: string, on: boolean): void {
  if (on) running.add(what);
  else running.delete(what);
}

let watching = false;
/** Watches for the screen being too busy to answer a tap (a 100 ms timer arriving late). */
export function watchBusy(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const late = now - last - 100;
    last = now;
    // In the background, timers are held back on purpose: that isn't the screen being busy.
    if (late > 400 && document.visibilityState === 'visible') noteSpeed('busy', late, running.size ? [...running].join(' and ') : undefined);
  }, 100);
}

/** In words, for Diagnostics. */
export function speedWords(n: SpeedNote): string {
  const s = n.ms >= 1000 ? `${(n.ms / 1000).toFixed(1)} s` : `${n.ms} ms`;
  if (n.what === 'screen') return `${n.detail ?? 'A screen'} took ${s} to show`;
  if (n.what === 'prices') return `Working out the deals took ${s}`;
  if (n.what === 'read') return n.detail ? `Reading for ${n.detail} took ${s}` : `Reading from the database waited ${s}`;
  // 0.18.4: the sync held the database (iPhone and iPad), and the phone's own saves waited that long.
  if (n.what === 'hold') return `A sync step held the database for ${s}`;
  return `Too busy to answer a tap for ${s}${n.detail ? ` (${n.detail} running)` : ''}`;
}
