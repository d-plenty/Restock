// Server mode: the browser's own copy of the household (sql.js, kept in IndexedDB per web id), and
// keeping it in step with the server: every 30 seconds while the page is open, when it comes back
// into view, and a few seconds after an edit.
//
// 0.9.4, a house (v3): the same round over /api/v3 with the session's MAC (api.ts), no webkeys/
// and no archives (round.ts); older prices come from the server when an item asks
// (serverHistory); and the specials and catalogues the phones shared are kept here (sharedSpecials).

import type { Database } from 'sql.js';
import { ensureDefaults, getKV, getSettings, householdContext, initDb, putKV, updateSettings } from '../lib/db';
import { applyRows } from '../lib/sharedSettings';
import { tidyKeeps } from '../lib/listPicks';
import { changed, onChange } from '../lib/live';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { setPhotoSource } from '../lib/receiptFiles';
import { SECTIONS, shopDef, shopsIn, type Section, type StoreChain } from '../shops';
import type { PriceReading, Settings } from '../types';
import { api, api3, type HistoryRow } from './api';
import { openWithAny, signedText, verifySig } from './crypto';
import { WebSyncEngine } from './engine';
import { syncRound, type RoundResult, type SharedSection } from './round';
import { addKeys, refreshHouseKeys, session, type Session } from './session';
import { syncDbOf } from './sqldb';

const STORE = 'files';
const dbName = (webId: string) => `restock-server-${webId}`;

function idb<T>(name: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}

/** Signing out: this browser's copy goes too. */
export async function deleteLocalCopy(webId: string): Promise<void> {
  await new Promise<void>((res) => {
    try {
      const r = indexedDB.deleteDatabase(dbName(webId));
      r.onsuccess = r.onerror = r.onblocked = () => res();
    } catch {
      res();
    }
  });
}

export interface Status {
  /** The last time a round finished. */
  at?: string;
  /** The newest phone file seen (for "Synced with your phones …"). */
  phoneAt?: string;
  busy: boolean;
  error?: string;
  unread: number;
  household?: string;
}

let status: Status = { busy: false, unread: 0 };
const listeners = new Set<() => void>();
export const syncStatus = () => status;
export function onStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setStatus(p: Partial<Status>) {
  status = { ...status, ...p };
  listeners.forEach((f) => f());
}

let raw: Database | undefined;
let engine: WebSyncEngine | undefined;
let persist: (() => void) | undefined;

/**
 * Where this browser keeps its copy of the household between visits: IndexedDB, per web id. Not for
 * a tab signed in with a phone ("this tab forgets the household when it's closed"): its copy lives in
 * memory only, so nothing of the household stays behind on a borrowed computer.
 */
export function localCopyStore(s: Session): { restore: () => Promise<Uint8Array | undefined>; persist: (bytes: Uint8Array) => Promise<void> } {
  const name = dbName(s.webId);
  if (s.viaPhone) return { restore: async () => undefined, persist: async () => undefined };
  return {
    restore: async () => {
      try {
        return (await idb<Uint8Array | undefined>(name, 'readonly', (st) => st.get('db'))) ?? undefined;
      } catch {
        return undefined;
      }
    },
    persist: async (bytes) => {
      try {
        await idb(name, 'readwrite', (st) => st.put(bytes, 'db'));
      } catch {
        // storage full or blocked: the server still has everything
      }
    },
  };
}

/** Opens (or makes) this web id's copy. Used as the app's database opener (lib/boot.ts). */
export async function openServerDatabase(s: Session): Promise<void> {
  const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([import('sql.js'), import('sql.js/dist/sql-wasm-browser.wasm?url')]);
  const driver = await createSqlJsDriver({
    load: () => initSqlJs({ locateFile: () => wasmUrl }),
    ...localCopyStore(s),
  });
  await initDb(driver);
  raw = driver.raw;
  persist = () => void driver.run('SELECT 1').catch(() => undefined);
  engine = new WebSyncEngine(syncDbOf(raw), verifySig, signedText);
  const me = 'web-' + s.webId;
  if (engine.meta('device') !== me) {
    // A fresh copy for this web id: nothing in it is this browser's own yet.
    engine.db.exec('DELETE FROM sync_log');
    engine.db.exec('DELETE FROM sync_held');
    engine.setMeta('device', me);
  }
  engine.setMeta('name', 'Web');
  if (s.ownerPub && !engine.meta('owner_pin')) engine.setMeta('owner_pin', s.ownerPub);
  const st = await getSettings();
  if (!st.onboarded) await updateSettings({ onboarded: true, privacyAccepted: st.privacyAccepted ?? new Date().toISOString(), seenHints: [...new Set([...(st.seenHints ?? []), 'tour'])] });
  setPhotoSource(serverPhoto);
  setStatus({ household: engine.householdValue('name') ?? s.household });
}

/** A receipt photo, from the server (photos/<sha256>.bin), as base64 JPEG. */
async function serverPhoto(path: string): Promise<string | undefined> {
  const s = session();
  const sum = engine?.meta('photo:' + path);
  if (!s || !sum) return undefined;
  const bytes = await (s.v === 3 ? api3 : api).read(`photos/${sum}.bin`).catch(() => null);
  if (!bytes) return undefined;
  try {
    const m = openWithAny<{ data?: string }>(s.keys, bytes).msg;
    return typeof m.data === 'string' ? m.data : undefined;
  } catch {
    return undefined;
  }
}

/** The tabs and shops the web shows: what the household shares and has things in. */
async function fitSettings(e: WebSyncEngine): Promise<void> {
  const shared = e.householdTabs();
  const chains = new Set<string>(e.db.query('SELECT DISTINCT chain FROM products').map((r) => String(r.chain)));
  const used = new Set<string>(e.db.query('SELECT DISTINCT section FROM items').map((r) => String(r.section)));
  const st = await getSettings();
  const enabled = new Set<string>(st.enabledChains);
  for (const c of chains) if (shopDef(c)) enabled.add(c);
  const sections = { ...st.sections };
  for (const sec of SECTIONS) {
    if (sec === 'pantry') continue;
    const on = shared.has(sec) && (used.has(sec) || [...chains].some((c) => shopDef(c)?.section === sec));
    sections[sec as Exclude<Section, 'pantry'>] = on;
    if (on && ![...enabled].some((c) => shopDef(c)?.section === sec)) enabled.add(shopsIn(sec)[0].id);
  }
  // 0.9.3: the household's own settings (shops picked, tabs on) win over the fitting, so the two
  // never take turns (each save here starts another round).
  const fitted: Record<string, unknown> = { enabledChains: [...enabled], sections, customShops: st.customShops };
  const ctx = await householdContext();
  if (ctx) applyRows(fitted, [...ctx.rows].map(([k, v]) => ({ k, v })), ctx.tabs, { adult: true });
  const next = fitted.enabledChains as StoreChain[];
  const secs = fitted.sections as Settings['sections'];
  if (JSON.stringify(next) !== JSON.stringify(st.enabledChains) || secs.keg !== st.sections.keg || secs.pharmacy !== st.sections.pharmacy || JSON.stringify(fitted.customShops) !== JSON.stringify(st.customShops))
    await updateSettings({ enabledChains: next, sections: secs, customShops: fitted.customShops as Settings['customShops'], adultConfirmed: st.adultConfirmed || secs.keg }, { local: true });
  // Receipts show when the household shares them (or some came from the phones' archives).
  const receipts = e.shareReceipts() || e.db.query('SELECT 1 FROM receipts LIMIT 1').length > 0;
  if (receipts !== st.receipts.enabled) await updateSettings({ receipts: { ...st.receipts, enabled: receipts } }, { local: true });
}

let running: Promise<RoundResult | undefined> | undefined;
let applying = false;
let firstDone = false;
/** v3: when this tab last asked the server for newer keys (a file that won't open: a phone was removed). */
let keysAskedAt = 0;

/** One round now (or the one already going). */
export function syncNow(): Promise<RoundResult | undefined> {
  if (running) return running;
  running = (async () => {
    const s = session();
    if (!s || !engine) return undefined;
    setStatus({ busy: true });
    try {
      const house = s.v === 3;
      // syncRound adds a vouched-for new key (v2, webkeys/) to the keys it's handed.
      let keys = { webId: s.webId, webPriv: s.webPriv, webPub: s.webPub, keys: { ...s.keys } };
      let r = await syncRound(engine, house ? api3 : api, keys, undefined, { v3: house });
      if (!house && r.newKeys) await addKeys({ keys: keys.keys });
      // A house rekeys when a phone is removed: the server has the new key for this session.
      if (house && r.unread > 0 && Date.now() - keysAskedAt > 5 * 60_000) {
        keysAskedAt = Date.now();
        const now = (await refreshHouseKeys().catch(() => false)) ? session() : undefined;
        if (now) {
          keys = { webId: now.webId, webPriv: '', webPub: '', keys: { ...now.keys } };
          r = await syncRound(engine, api3, keys, undefined, { v3: true });
        }
      }
      if (r.shared.length) await keepShared(r.shared).catch(() => undefined);
      if (!firstDone) {
        firstDone = true;
        await ensureDefaults();
      }
      await fitSettings(engine);
      // 0.9.3: "Keep it as just …" notes of lines that are gone (an older phone deleted them, say).
      await tidyKeeps().catch(() => 0);
      persist?.();
      applying = true;
      changed();
      setTimeout(() => (applying = false), 0);
      const files = r.lastPhone ?? status.phoneAt;
      setStatus({ busy: false, at: new Date().toISOString(), phoneAt: files, error: undefined, unread: r.unread, household: engine.householdValue('name') ?? s.household });
      return r;
    } catch (e) {
      setStatus({ busy: false, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  })().finally(() => (running = undefined));
  return running;
}

let timer: ReturnType<typeof setInterval> | undefined;
let soon: ReturnType<typeof setTimeout> | undefined;
let unsub: (() => void) | undefined;
const onFocus = () => {
  if (document.visibilityState !== 'hidden') void syncNow();
};

/** While the page is open: every 30 s, on coming back to it, and 3 s after an edit. */
export function start(): void {
  stop();
  void syncNow();
  timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void syncNow();
  }, 30_000);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  unsub = onChange(() => {
    if (applying) return;
    clearTimeout(soon);
    soon = setTimeout(() => void syncNow(), 3000);
  });
}

export function stop(): void {
  clearInterval(timer);
  clearTimeout(soon);
  unsub?.();
  unsub = undefined;
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
  }
}

/** The phones' names, from the household record (member:<device>). */
export function memberNames(): Map<string, string> {
  const out = new Map<string, string>();
  if (!engine) return out;
  for (const r of engine.db.query("SELECT k, v FROM household WHERE k LIKE 'member:%'")) {
    try {
      out.set(String(r.k).slice(7), (JSON.parse(String(r.v)) as { name?: string }).name ?? 'Phone');
    } catch {
      out.set(String(r.k).slice(7), 'Phone');
    }
  }
  return out;
}

export function householdInfo(): { name?: string; owner?: string; tabs: string[]; receipts: boolean } {
  if (!engine) return { tabs: [], receipts: false };
  return {
    name: engine.householdValue('name') ?? undefined,
    owner: engine.householdValue('owner') ?? undefined,
    tabs: [...engine.householdTabs()],
    receipts: engine.shareReceipts(),
  };
}

// ---------- 0.9.4: what the phones shared, and the server's history ----------

const SHARED = 'server-shared-specials';

export interface SharedSpecials {
  /** chain → the newest half-price list a phone fetched there. */
  lists: Record<string, { chain: string; at?: string; device: string; items: Record<string, unknown>[] }>;
  /** chain → the catalogue link a phone found. */
  catalogues: Record<string, { url?: string; note?: string; at?: string; device: string }>;
}

const newer = (a?: string, b?: string) => (a ?? '') >= (b ?? '');

/** Keeps the newest list per shop, and each shop's catalogue link, from what the round opened. */
export async function keepShared(found: SharedSection[]): Promise<void> {
  const was = (await getKV<SharedSpecials>(SHARED).catch(() => undefined)) ?? { lists: {}, catalogues: {} };
  const next: SharedSpecials = { lists: { ...was.lists }, catalogues: { ...was.catalogues } };
  for (const f of found) {
    for (const l of f.specials) {
      const have = next.lists[l.chain];
      if (!have || newer(l.at, have.at)) next.lists[l.chain] = { chain: l.chain, at: l.at, device: f.device, items: l.items };
    }
    for (const [chain, c] of Object.entries(f.catalogues)) {
      const have = next.catalogues[chain];
      if (!have || newer(f.at, have.at)) next.catalogues[chain] = { ...c, at: f.at, device: f.device };
    }
  }
  await putKV(SHARED, next);
  changed();
}

/** What the phones shared: the shops' half-price lists and catalogue links (empty until one shares). */
export async function sharedSpecials(): Promise<SharedSpecials> {
  return (await getKV<SharedSpecials>(SHARED).catch(() => undefined)) ?? { lists: {}, catalogues: {} };
}

const bool = (v: unknown) => v === true || v === 1;

/** One product's prices from the server's history (v3; years of them), as readings. Empty on v2. */
export async function serverHistory(productId: string, from: string): Promise<PriceReading[]> {
  if (session()?.v !== 3) return [];
  const rows: HistoryRow[] = await api3.history(productId, from).catch(() => []);
  return rows
    .filter((r) => typeof r.date === 'string' && typeof r.price === 'number')
    .map((r) => ({
      productId,
      date: r.date,
      price: r.price,
      wasPrice: (r.wasPrice ?? r.was_price) ?? undefined,
      isSpecial: bool(r.isSpecial ?? r.is_special),
      memberOnly: bool(r.memberOnly ?? r.member_only),
      promo: r.promo ?? undefined,
      source: 'auto' as const,
    }));
}

/** "Download a backup": the browser's copy as a Restock backup file (no card numbers: the web never has them). */
export async function downloadBackup(): Promise<void> {
  const { backupJson, EVERYTHING } = await import('../lib/backup');
  const json = await backupJson({ ...EVERYTHING, receiptPhotos: false });
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `restock-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

