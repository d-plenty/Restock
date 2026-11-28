// 0.18.3: Server settings → This browser: how the server's page looks on this computer (kept in
// this browser only; nothing here changes the phones). Light or dark, the default theme or Simple,
// the text size, and the animations: the opening when the page loads, the holidays, and movement.
import { useSyncExternalStore } from 'react';

interface Prefs {
  theme: 'light' | 'dark' | 'system';
  style: 'default' | 'simple';
  text: 'smaller' | 'normal' | 'bigger';
  opening: boolean;
  holidays: boolean;
  /** Movement on (off: still pictures, as the computer's Reduce motion does). */
  motion: boolean;
}

export const DEFAULT_PREFS: Prefs = { theme: 'system', style: 'default', text: 'normal', opening: true, holidays: true, motion: true };
const KEY = 'restock-server-look';
const TEXT = { smaller: 0.92, normal: 1, bigger: 1.15 } as const;

/** What was kept, checked (anything odd is the default). Exported for the tests. */
function readPrefs(raw: string | null): Prefs {
  let v: Partial<Prefs> = {};
  try {
    const j = JSON.parse(raw ?? '{}') as unknown;
    if (j && typeof j === 'object') v = j as Partial<Prefs>;
  } catch {
    v = {};
  }
  const pick = <T extends string>(x: unknown, all: readonly T[], d: T): T => (all.includes(x as T) ? (x as T) : d);
  return {
    theme: pick(v.theme, ['light', 'dark', 'system'], DEFAULT_PREFS.theme),
    style: pick(v.style, ['default', 'simple'], DEFAULT_PREFS.style),
    text: pick(v.text, ['smaller', 'normal', 'bigger'], DEFAULT_PREFS.text),
    opening: typeof v.opening === 'boolean' ? v.opening : true,
    holidays: typeof v.holidays === 'boolean' ? v.holidays : true,
    motion: typeof v.motion === 'boolean' ? v.motion : true,
  };
}

let current: Prefs = (() => {
  try {
    return readPrefs(globalThis.localStorage?.getItem(KEY) ?? null);
  } catch {
    return DEFAULT_PREFS;
  }
})();
const listeners = new Set<() => void>();

const darkQuery = () => (typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined);
export const isDarkNow = (p: Prefs = current) => p.theme === 'dark' || (p.theme === 'system' && !!darkQuery()?.matches);
/** Less motion: this page's switch, or the computer's own Reduce motion. */
export const lessMotionNow = (p: Prefs = current) => !p.motion || (typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** Puts the look on the page (tokens.css reads these). */
export function applyPrefs(p: Prefs = current): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = p.theme;
  if (isDarkNow(p)) root.dataset.dark = '1';
  else delete root.dataset.dark;
  if (p.style === 'simple') root.dataset.style = 'simple';
  else root.dataset.style = 'australia';
  root.dataset.motion = p.motion ? 'on' : 'off';
  root.style.setProperty('--sv-text', String(TEXT[p.text]));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#012169');
}

export const prefs = () => current;
export function setPrefs(change: Partial<Prefs>): void {
  current = readPrefs(JSON.stringify({ ...current, ...change }));
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // not kept: this visit only
  }
  applyPrefs();
  listeners.forEach((f) => f());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
    () => current,
  );
}

/** The computer switched between light and dark: System follows it. */
export function watchSystemTheme(): void {
  darkQuery()?.addEventListener?.('change', () => {
    if (current.theme === 'system') {
      applyPrefs();
      listeners.forEach((f) => f());
    }
  });
}
