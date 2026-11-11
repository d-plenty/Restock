// 0.9.6 (iPhone offline): what the web app can show with no signal, beyond the Shopping list.
//
// What is already on this phone, in this session's own copy (live.ts: sql.js kept in IndexedDB,
// database `restock-server-<web id>`), after one round online:
// - the Pantry, Keg and Health tabs (items, their products and the prices the phones shared),
// - all four lists (Groceries, Keg, Health, General): ticking, adding, editing, Move to and Undo all
//   write to the copy first and wait in the web's sync log (engine.ts) until a round reaches the
//   server, which sends them with the same v3 round as always (no new endpoints);
// - the specials and catalogue links the phones shared (live.ts keepShared), shown as of when the
//   phone fetched them;
// - Cards: kept in this browser only (cardStore.ts, IndexedDB `restock-cards`), barcodes drawn here.
// What this file adds:
// - an item's older prices from the server (Price history beyond what the phones send) are kept in
//   the same copy as they're looked at, so the chart still shows them offline ("as of" when fetched);
// - the words for the offline notice, and which pages need signal.
//
// Honest limits (iOS): the first open must be online and signed in, with Keep me signed in ticked
// (a session kept only for the tab is gone when iOS closes the app). Safari may clear a website's
// stored data when the phone is low on space; the home screen app is not subject to Safari's 7-day
// limit on script-written storage, but it is not exempt from being cleared under storage pressure.
// When that happens, the app opens at the sign-in page and loads everything again once online.
// Edits made offline that were never sent are lost in that case (the Sign out warning covers
// signing out on purpose).
import type { PriceReading } from '../../types';

/** A key in the copy's own IndexedDB store, beside the database itself. */
export const historyKey = (productId: string) => `hist:${productId}`;
/** At most this many readings kept per product (years of daily prices is ~1,100). */
export const HISTORY_CAP = 2000;

export interface KeptHistory {
  /** When it came from the server (ISO). */
  at: string;
  rows: PriceReading[];
}

export interface KeyStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** The copy's own IndexedDB store for this web id (the same database live.ts keeps, so it goes with it). */
export function copyKeyStore(webId: string): KeyStore {
  const name = `restock-server-${webId}`;
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> =>
    new Promise((resolve) => {
      try {
        const open = indexedDB.open(name, 1);
        open.onupgradeneeded = () => open.result.createObjectStore('files');
        open.onerror = () => resolve(undefined);
        open.onsuccess = () => {
          try {
            const tx = open.result.transaction('files', mode);
            const req = fn(tx.objectStore('files'));
            req.onsuccess = () => resolve(req.result as T);
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
  return {
    get: <T>(key: string) => run<T>('readonly', (s) => s.get(key)),
    put: async (key, value) => void (await run('readwrite', (s) => s.put(value, key))),
  };
}

/**
 * The server's older prices for an item, kept for offline: what the server gave is kept (newest
 * first, capped); with no signal, what was kept is shown instead (from `from` on).
 */
export function keptHistory(
  fetch: (productId: string, from: string) => Promise<PriceReading[]>,
  store: () => KeyStore | undefined,
  offlineNow: () => boolean,
  now: () => string = () => new Date().toISOString(),
): (productId: string, from: string) => Promise<PriceReading[]> {
  return async (productId, from) => {
    const kv = store();
    const offline = offlineNow();
    let rows: PriceReading[] = [];
    if (!offline) rows = await fetch(productId, from).catch(() => []);
    if (rows.length) {
      if (kv) {
        const was = await kv.get<KeptHistory>(historyKey(productId)).catch(() => undefined);
        // Merge with what was kept (an earlier, longer range stays), one reading per date.
        const byDate = new Map<string, PriceReading>();
        for (const r of was?.rows ?? []) byDate.set(r.date, r);
        for (const r of rows) byDate.set(r.date, r);
        const all = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, HISTORY_CAP);
        await kv.put(historyKey(productId), { at: now(), rows: all } satisfies KeptHistory).catch(() => undefined);
      }
      return rows;
    }
    // Nothing from the server: offline (or it failed), so what was kept here.
    if (!kv || !offline) return rows;
    const kept = await kv.get<KeptHistory>(historyKey(productId)).catch(() => undefined);
    return (kept?.rows ?? []).filter((r) => r.date >= from);
  };
}

/** The offline notice: "Offline: showing what this phone last saved today at 3:41 pm." */
export function offlineText(last: string | undefined, device: 'phone' | 'browser'): string {
  return last ? `Offline: showing what this ${device} last saved ${last}.` : `Offline: showing what this ${device} last saved.`;
}

/** Under it: changes wait, and how many. */
export function waitingText(unsent: number): string {
  if (unsent <= 0) return "Changes you make here sync when you're back online.";
  return `${unsent} change${unsent === 1 ? '' : 's'} waiting to sync when you're back online.`;
}

/** Pages that only work with signal (they ask the server each time). */
export type SignalPage = 'phones' | 'activity' | 'data' | 'data-manage' | 'search';
export const NEEDS_SIGNAL: Record<SignalPage, string> = {
  phones: 'Server and phones',
  activity: 'Activity',
  data: 'The Data tab (and Import)',
  'data-manage': 'Manage data',
  search: 'Searching the shops',
};
