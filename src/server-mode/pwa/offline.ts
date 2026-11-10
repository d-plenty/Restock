// 0.9.5: the web app with no connection (an iPhone on the home screen, out at the shops).
//
// The web already keeps its own copy of the household (live.ts: sql.js in IndexedDB, one database
// per session's web id) and writes every change there first; a sync round then sends the web's own
// file with each change's time, and merges with the phones by the same rules as a phone (the later
// tick wins, a delete beats an edit made without knowing about it). So with no connection:
// - the page opens from the service worker's app shell, and from this browser's copy, when the
//   session kept on this browser is still good and the copy is that session's own;
// - ticks, adds and removes land in the copy and go at the next round (every 30 s, when the app
//   comes back to the front, and as soon as the browser says it's online), each request with a
//   fresh MAC, as always;
// - the copy (and what's here) goes on Sign out, Sign out everywhere, and when the session runs
//   out or the server says it's gone. Another session never opens a copy that isn't its own.
//
// Not kept: a tab signed in with a phone (memory only), and v2 (0.9.3-style) servers.
import { useEffect, useSyncExternalStore } from 'react';
import type { ServerInfo } from '../api';
import type { Session } from '../session';

/** Where main.tsx notes which web id's copy is on this browser (as 0.9.4 did). */
export const WEBID_KEY = 'restock-server-webid';
/** What the server said it is, kept so the app can open offline (no household data in it). */
export const INFO_KEY = 'restock-pwa-server';
/** Inside the copy's own IndexedDB database (so it goes with it): when the list last came from the server. */
export const LAST_KEY = 'pwa-last-sync';

/** The message api.ts gives when the server can't be reached. */
const OFFLINE_TEXT = /^Can't reach your Restock server/;
export const isOfflineError = (msg?: string) => !!msg && OFFLINE_TEXT.test(msg);

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/** Keeps what the server is (a house, its mode and version), for opening offline. */
export function keepInfo(store: KV, info: ServerInfo): void {
  safe(() => {
    if (info.api === 3 && info.mode !== 'v2' && info.mode !== 'released') store.setItem(INFO_KEY, JSON.stringify({ api: 3, mode: info.mode, version: info.version }));
    else store.removeItem(INFO_KEY);
  }, undefined);
}

export function keptInfo(store: KV): ServerInfo | undefined {
  return safe(() => {
    const v = JSON.parse(store.getItem(INFO_KEY) ?? 'null') as ServerInfo | null;
    return v && v.api === 3 && (v.mode === 'v3' || v.mode === 'new' || v.mode === undefined) ? { api: 3, mode: v.mode, version: typeof v.version === 'string' ? v.version : undefined } : undefined;
  }, undefined);
}

const expiresAt = (s: Session) => (typeof s.expires === 'number' ? s.expires : s.expires ? Date.parse(s.expires) : NaN);

/**
 * The session the app may open offline with, or undefined: a house's session with its keys, not
 * signed in with a phone, not run out, and the copy on this browser is its own.
 */
export function offlineSession(s: Session | undefined, copyOf: string | null | undefined, now = Date.now()): Session | undefined {
  if (!s || s.v !== 3 || s.viaPhone || !s.sid || !s.sessionKey) return undefined;
  if (!s.webId || s.webId !== copyOf) return undefined;
  if (!Object.keys(s.keys ?? {}).length) return undefined;
  const exp = expiresAt(s);
  if (Number.isFinite(exp) && exp < now) return undefined;
  return s;
}

/** At the sign-in page: the copy left on this browser that no session here can open any more. */
export function staleCopy(copyOf: string | null | undefined, s: Session | undefined): string | undefined {
  if (!copyOf) return undefined;
  return s && s.webId === copyOf ? undefined : copyOf;
}

/** Forgets what's kept here for offline (the copy itself is deleted by the caller, live.ts). */
export function forgetKept(store: KV): void {
  safe(() => {
    store.removeItem(INFO_KEY);
    store.removeItem(WEBID_KEY);
  }, undefined);
}

// ---------- the copy's own "last updated" ----------

const dbName = (webId: string) => `restock-server-${webId}`;

function withStore<T>(webId: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(dbName(webId), 1);
      open.onupgradeneeded = () => open.result.createObjectStore('files');
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction('files', mode);
          const req = fn(tx.objectStore('files'));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
          tx.oncomplete = () => open.result.close();
        } catch {
          open.result.close();
          resolve(undefined);
        }
      };
    } catch {
      resolve(undefined);
    }
  });
}

/** Is this web id's copy on this browser? */
export async function hasCopy(webId: string): Promise<boolean> {
  return !!(await withStore<IDBValidKey | undefined>(webId, 'readonly', (s) => s.getKey('db')));
}

// ---------- state for the banner ----------

interface State {
  /** Opened with no connection, and no round has worked since. */
  bootOffline: boolean;
  /** The browser says it has no network. */
  noNetwork: boolean;
  /** When the list last came from the server (ISO). */
  last?: string;
}
let state: State = { bootOffline: false, noNetwork: false };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => {
  state = { ...state, ...p };
  subs.forEach((f) => f());
};
const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

export const markBootOffline = () => set({ bootOffline: true });
/** What the notices show (for tests; pages use usePwaState). */
export const pwaState = (): Readonly<State> => state;

let webIdNow: string | undefined;
/** The app opened on this web id's copy: load when it was last updated. */
export async function openedCopy(webId: string): Promise<void> {
  webIdNow = webId;
  const at = await withStore<string>(webId, 'readonly', (s) => s.get(LAST_KEY) as IDBRequest<string>);
  if (webIdNow === webId) set({ last: typeof at === 'string' ? at : undefined });
}

/** A round finished: the list is as fresh as now. */
export function roundDone(at: string): void {
  set({ last: at, bootOffline: false });
  const id = webIdNow;
  if (id) void withStore(id, 'readwrite', (s) => s.put(at, LAST_KEY));
}

/** Signing out: nothing of this session stays in memory here. */
export function clearState(): void {
  webIdNow = undefined;
  state = { bootOffline: false, noNetwork: false };
  subs.forEach((f) => f());
}

export function usePwaState(): State {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Follows the browser's online and offline events; back online, `onOnline` (a round) runs. */
export function useNetworkWatch(onOnline: () => void): void {
  useEffect(() => {
    const on = () => {
      set({ noNetwork: false });
      onOnline();
    };
    const off = () => set({ noNetwork: true });
    if (typeof navigator !== 'undefined' && navigator.onLine === false) off();
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [onOnline]);
}

/** "3:41 pm" today, "Monday 3:41 pm" this week, else "9 Nov, 3:41 pm". */
export function whenText(iso: string | undefined, now = new Date()): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const time = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s+/g, ' ').toLowerCase();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString('en-AU', { weekday: 'long' })} at ${time}`;
  return `${d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} at ${time}`;
}
