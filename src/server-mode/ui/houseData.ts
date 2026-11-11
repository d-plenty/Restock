// 0.9.4: what the web's house pages (protocol v3) read and change, in one place: the phones on the
// server (add with a name, rename, remove; removed and left ones listed), the browsers signed in,
// activity and logs, Keep data for, the encrypted backup, the recovery key, Home Assistant on the
// server, the household's default branch per shop, and what the phones shared of the specials.

import { useCallback, useEffect, useState } from 'react';
import { getSettings, queryRows, runOps } from '../../lib/db';
import { decode } from '../../lib/sharedSettings';
import { useLive } from '../../lib/useLive';
import { activeSections, chainName, enabledIn, SECTION_NAMES, shopDef, websiteOf, type Section, type StoreChain } from '../../shops';
import { askPassword } from '../../lib/confirm';
import { api3, ApiError, isV3, serverInfo, v3Get, v3Send, type Activity, type Browser, type Confirm, type HaConfig, type HouseSettings, type Phone } from '../api';
import { sharedSpecials, type SharedSpecials } from '../live';
import { confirmPassphrase, session } from '../session';

export const house = () => isV3() && session()?.v === 3;
/** Removing phones and the server's settings need a passphrase sign-in (the server refuses a phone sign-in). */
export const canAdmin = () => !session()?.viaPhone;
export const ADMIN_NOTE = 'Signed in with a phone: sign in with the passphrase to change this.';
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 0.9.4: the dangerous admin actions ask for the passphrase again: proves it (confirmPassphrase,
 * a few seconds) and does `run` with the proof. A wrong passphrase says so.
 */
export async function withConfirm<T>(passphrase: string, run: (c: Confirm) => Promise<T>): Promise<T> {
  try {
    return await run(await confirmPassphrase(passphrase));
  } catch (e) {
    if (e instanceof ApiError && e.code === 'current') throw new Error("That isn't your passphrase.");
    throw e;
  }
}

/** As withConfirm, asking for the passphrase in a sheet first (`detail` says what happens). Undefined if cancelled. */
export async function askThenConfirm<T>(title: string, detail: string, action: string, run: (c: Confirm) => Promise<T>): Promise<T | undefined> {
  const pass = await askPassword(title, { detail: `${detail} Type your passphrase to go ahead.`, action });
  if (!pass) return undefined;
  return withConfirm(pass, run);
}

/** Loads something from the server, with Reload; `undefined` while loading. */
export function useServer<T>(load: () => Promise<T>, deps: unknown[] = []): { data?: T; error?: string; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (d) => live && (setData(d), setError(undefined)),
      (e) => live && setError(errText(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

// ---------- phones ----------

const TAB_WORD: Record<string, string> = { pantry: 'Pantry, Shopping list', keg: 'Keg', pharmacy: 'Health' };

/** "Shares Pantry, Shopping list, Keg · receipts" (what the phone said it shares, D9). */
export function sharesText(p: Phone): string {
  const s = p.shares;
  if (!s) return p.api === 2 ? 'Shares what the household shared (Restock 0.9.3)' : 'Shares nothing yet';
  const bits = (s.tabs ?? []).map((t) => TAB_WORD[t] ?? t);
  if (s.receipts) bits.push('receipts');
  if (s.cards) bits.push('loyalty cards');
  return bits.length ? `Shares ${bits.join(', ')}` : 'Shares nothing';
}

export const phoneName = (p: Phone) => p.label || p.name || 'Phone';

export function dayText(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

/** Active ones first (by name), then removed and left ones, newest first. */
export function sortPhones(list: Phone[]): Phone[] {
  const active = (p: Phone) => !p.status || p.status === 'active';
  return [...list].sort((a, b) => Number(active(b)) - Number(active(a)) || (active(a) ? phoneName(a).localeCompare(phoneName(b)) : (b.statusAt ?? '').localeCompare(a.statusAt ?? '')));
}

export const usePhonesV3 = () => useServer(async () => sortPhones(await api3.phones()));

/** An Add a phone code for a phone with this name: the whole restock-server:3 text, and when it runs out. */
export async function newPhoneCode(label: string): Promise<{ code: string; until: number }> {
  const r = await api3.addPhone(label.trim());
  const until =
    typeof r.expiresIn === 'number'
      ? Date.now() + r.expiresIn * (r.expiresIn > 100_000 ? 1 : 1000)
      : typeof r.expires === 'number'
        ? r.expires
        : r.expires
          ? Date.parse(r.expires)
          : Date.now() + 10 * 60_000;
  return { code: r.code, until };
}

// ---------- browsers ----------

export const useBrowsers = () => useServer(() => api3.browsers());
export const browserKind = (b: Browser) => (b.kind === 'phone' ? 'Signed in with a phone' : 'Signed in with the passphrase');
export const isThisBrowser = (b: Browser) => b.current === true || b.id === session()?.sid;

// ---------- activity and logs ----------

type Detail = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.length < 120 ? v : undefined);
const fileWord = (f: unknown) => {
  const n = str(f) ?? '';
  if (/^restock-sync-srv-/.test(n)) return "the server's file";
  if (/^restock-sync-web-/.test(n)) return "the web page's changes";
  if (/^restock-sync-/.test(n)) return 'its changes';
  if (n.startsWith('archive/')) return 'older prices';
  if (n.startsWith('photos/')) return 'a photo';
  if (n.startsWith('keys/')) return 'new keys';
  return 'a file';
};

/**
 * What happened, in words, from srv_log's `what` and `detail` (the server notes the one who did it
 * as `device`, and what it was done to in `detail`). Unknown ones show as they are, tidied.
 */
const ACT: Record<string, (d: Detail, name: (device: unknown) => string | undefined) => string> = {
  upload: (d) => `sent ${fileWord(d.file)}`,
  write: (d) => `sent ${fileWord(d.file)}`,
  fetch: (d) => `fetched ${fileWord(d.file)}`,
  delete: (d) => `deleted ${fileWord(d.file)}`,
  'changes-in': (d) => (typeof d.changes === 'number' ? `brought ${d.changes} change${d.changes === 1 ? '' : 's'}` : 'brought changes'),
  'phone-joined': (d) => (d.how === 'member' ? 'joined through the household' : d.how === 'bring' ? 'brought its household onto the server' : 'joined'),
  'phone-upgraded': () => 'moved to the server household',
  'phone-left': () => 'left',
  'phone-removed': (d, name) => `removed ${str(d.name) ?? name(d.device) ?? 'a phone'}`,
  'phone-renamed': (d) => `renamed a phone ${str(d.label) ?? ''}`.trim(),
  'invite-made': (d) => (str(d.label) ? `made a code to add ${str(d.label)}` : 'made a code to add a phone'),
  'signed-in': (d) => (d.kind === 'phone' ? 'signed a browser in with a phone' : 'signed in'),
  login: () => 'signed in',
  'login-failed': () => 'a wrong passphrase was tried',
  'locked-out': () => 'locked out after wrong tries',
  'browser-signed-out': () => 'signed a browser out',
  'signed-out-everywhere': () => 'signed out everywhere',
  'passphrase-changed': () => 'changed the passphrase',
  'passphrase-change-refused': () => 'was refused a new passphrase (not the current one)',
  'passphrase-reset': () => 'the passphrase was reset',
  'set-up': (d) => `set up the server${str(d.name) ? ` as ${str(d.name)}` : ''}`,
  'house-made': (d) => `made the house${str(d.name) ? ` ${str(d.name)}` : ''}`,
  'handover-code': () => 'made a handover code',
  'handover-done': () => 'took the household over from the owner phone',
  'handover-refused': () => "couldn't take the household over (nothing changed)",
  'handover-rolled-back': () => 'undid an unfinished handover (nothing changed)',
  'household-brought': () => 'brought its household onto the server',
  'household-taken-back': () => 'took the household back with the recovery key',
  'settings-changed': (d) => (d.keepMonths === null ? 'turned Auto delete off' : typeof d.keepMonths === 'number' ? `set Auto delete to after ${d.keepMonths} months` : 'changed the settings'),
  pruned: () => 'deleted data older than Auto delete keeps',
  // 0.9.5: the Data tab.
  'auto-delete-changed': (d) => (d.months === null ? 'turned Auto delete off' : typeof d.months === 'number' ? `set Auto delete to after ${d.months} month${d.months === 1 ? '' : 's'}` : 'changed Auto delete'),
  'data-deleted': (d) => `deleted ${Array.isArray(d.kinds) ? kindWords(d.kinds) : 'data'}${typeof d.before === 'string' ? ` from before ${dayText(d.before)}` : ''}`,
  'deleted-everything': () => 'deleted everything on this server',
  'phones-asked-to-resend': () => 'asked every phone to send all it has again',
  recounted: () => 'recounted the charts and sizes',
  'data-exported': () => 'downloaded an export of the data',
  'data-imported': () => 'imported products and prices from a file',
  'data-import-stopped': () => 'stopped an import (what went in stays)',
  'recovery-key-shown': () => 'looked at the recovery key',
  'backup-downloaded': () => 'downloaded an encrypted backup',
  'home-assistant-changed': (d) => (d.enabled === true ? 'turned Home Assistant on' : d.enabled === false ? 'turned Home Assistant off' : 'changed Home Assistant'),
  'home-assistant-refused': () => "was refused running Home Assistant (the server runs it)",
  'web-sign-in-approved': () => 'let a browser sign in',
  trashed: (d) => `moved ${fileWord(d.file)} to the trash (kept 30 days)`,
  'trash-emptied': () => 'emptied files over 30 days old from the trash',
  'photo-kept': () => 'let go of a photo another phone put on the server',
  merged: (d) => (typeof d.changes === 'number' ? `had ${d.changes} change${d.changes === 1 ? '' : 's'} merged` : typeof d.added === 'number' ? `had ${d.added} older price${d.added === 1 ? '' : 's'} kept` : 'had a file merged'),
  'merge-failed': (d) => `couldn't merge a file${str(d.error) ? `: ${str(d.error)}` : ''}`,
  'merge-unreadable': () => "couldn't open a file (another key?)",
  compacted: () => 'tidied old deletes',
  'home-assistant': (d) => `synced the shopping list with Home Assistant${typeof d.came === 'number' ? ` (${d.came} in, ${d.went ?? 0} out)` : ''}`,
  'home-assistant-failed': (d) => `couldn't reach Home Assistant${str(d.message) ? `: ${str(d.message)}` : ''}`,
  'server-row-updated': () => 'told the phones where it is',
};

/** What the Data tab calls each kind. */
export const KIND_NAME: Record<DataKind, string> = {
  prices: 'Price history',
  receipts: 'Receipts and photos',
  stats: 'Spending records',
  logs: 'Activity and logs',
  backups: 'Deleted files kept for 30 days',
};
const kindWords = (kinds: unknown[]) =>
  kinds
    .filter((k): k is DataKind => typeof k === 'string' && k in KIND_NAME)
    .map((k) => KIND_NAME[k].toLowerCase())
    .join(', ') || 'data';

/** "Declan's phone", "This browser", "A browser", "The server", from who did it (`device`). */
export function whoOf(a: Activity, phones: Phone[] | undefined): string {
  const d = a.device ?? a.by;
  if (!d) return a.who && a.who !== 'Web page' ? a.who : a.who === 'Web page' ? 'A browser' : 'The server';
  if (d.startsWith('srv-')) return 'The server';
  if (d.startsWith('web')) return d === `web-${session()?.webId}` ? 'This browser' : 'A browser';
  const p = phones?.find((x) => x.device === d);
  return p ? phoneName(p) : (a.who ?? 'A removed phone');
}

export function whatOf(a: Activity, phones?: Phone[]): string {
  const d: Detail = a.detail && typeof a.detail === 'object' ? (a.detail as Detail) : {};
  const name = (device: unknown) => {
    const p = phones?.find((x) => x.device === device);
    return p ? phoneName(p) : undefined;
  };
  const f = ACT[a.what];
  if (f) return f(d, name);
  return a.what.replace(/[-_]/g, ' ') + (typeof a.detail === 'string' && a.detail.length < 160 ? ` · ${a.detail}` : '');
}

/** A row about something going wrong (shown in red). */
export const isTrouble = (a: Activity) => a.kind === 'error' || /failed|refused|unreadable|locked/.test(a.what);

export const useActivity = (logs: boolean) => useServer(() => (logs ? api3.logs() : api3.activity()), [logs]);

// ---------- the server's settings ----------

// 0.9.5 (final review): 0.9.4's KEEP_CHOICES and keepLabel ("Until I delete") are gone: Auto delete's words are in lib/autoDelete.ts.

export const useHouseSettings = () => useServer<HouseSettings>(() => api3.settings());
/** `confirm`: keeping less (data is deleted) needs the passphrase again. */
export const saveHouseSettings = (s: HouseSettings, confirm?: Confirm) => api3.putSettings(s, confirm);
/** "Delete older data now" (Until I delete): prices, receipts and logs before this day. */
export const pruneBefore = (iso: string, confirm: Confirm) => api3.prune(iso, confirm);

/** The recovery key, to save (shown once the admin asks, with the passphrase again). */
export async function recoveryKey(passphrase: string): Promise<string> {
  const r = await withConfirm(passphrase, (c) => api3.recovery(c));
  const k = r.recovery ?? r.key;
  if (!k) throw new Error("The server didn't send the recovery key.");
  return k;
}

/** Downloads the encrypted backup (D15): the server seals it with this passphrase before it leaves. */
export async function downloadEncryptedBackup(passphrase: string, signIn: string): Promise<string> {
  const { bytes, name } = await withConfirm(signIn, (c) => api3.backup(passphrase, c));
  const file = name ?? `restock-server-backup-${new Date().toISOString().slice(0, 10)}.bin`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  a.download = file;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
  return file;
}

// ---------- Home Assistant on the server ----------

export const useHa = () => useServer<HaConfig>(() => api3.homeAssistant());

// ---------- the household's default branch per shop (design section 15) ----------

/**
 * `branch:<chain>` in household_settings: { name, storeNo? }. The branch phones use for that shop
 * when they haven't picked their own (each phone's own pick still wins). A store number only for
 * Coles (its prices and stock at a store).
 */
export interface DefaultBranch {
  name: string;
  storeNo?: string;
}
export const BRANCH_PREFIX = 'branch:';
const CHAIN = /^[a-z0-9-]{1,60}$/;

export function checkBranch(v: unknown): DefaultBranch | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 80) return undefined;
  const storeNo = typeof o.storeNo === 'string' && /^\d{3,5}$/.test(o.storeNo) ? o.storeNo : undefined;
  return { name: o.name.trim(), ...(storeNo ? { storeNo } : {}) };
}

export async function defaultBranches(): Promise<Map<string, DefaultBranch>> {
  const rows = await queryRows<{ k: string; v: string }>(`SELECT k, v FROM household_settings WHERE k LIKE 'branch:%'`).catch(() => []);
  const out = new Map<string, DefaultBranch>();
  for (const r of rows) {
    const b = checkBranch(decode(r.v));
    if (b) out.set(r.k.slice(BRANCH_PREFIX.length), b);
  }
  return out;
}

/** Sets (or, with null, clears) a shop's default branch for the household; it goes out with the next sync. */
export async function setDefaultBranch(chain: string, b: DefaultBranch | null): Promise<void> {
  if (!CHAIN.test(chain)) throw new Error('Not a shop Restock knows.');
  const k = BRANCH_PREFIX + chain;
  if (!b) return runOps([{ sql: 'DELETE FROM household_settings WHERE k = ?', params: [k] }]);
  const ok = checkBranch(b);
  if (!ok) throw new Error('Type the branch name, like "Coles Kirwan".');
  await runOps([{ sql: 'INSERT OR REPLACE INTO household_settings (k, v) VALUES (?, ?)', params: [k, JSON.stringify(ok)] }]);
}

/** The household's shops (the ones picked on each tab that's on), with their default branch. */
export async function branchShops(): Promise<{ section: Section; title: string; shops: { chain: StoreChain; name: string; branch?: DefaultBranch }[] }[]> {
  const [s, branches] = await Promise.all([getSettings(), defaultBranches()]);
  return activeSections(s).map((section) => ({
    section,
    title: section === 'pantry' ? 'Groceries' : SECTION_NAMES[section],
    shops: enabledIn(s.enabledChains, section).map((chain) => ({ chain, name: chainName(chain), branch: branches.get(chain) })),
  }));
}

// ---------- specials and catalogues, from what the phones shared ----------

/** The shops' own specials pages, where Restock knows them for sure. */
export const SPECIALS_URL: Partial<Record<string, string>> = {
  woolworths: 'https://www.woolworths.com.au/shop/browse/specials',
  coles: 'https://www.coles.com.au/on-special',
  aldi: 'https://www.aldi.com.au/special-buys',
};

export const https = (url: string | undefined) => {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
};

export interface ShopLinks {
  chain: StoreChain;
  name: string;
  website?: string;
  specials?: string;
  catalogue?: string;
  catalogueNote?: string;
}

/** Every shop the household follows, by tab, with its website, specials and catalogue links (like the phone). */
export async function followedShops(): Promise<{ section: Section; title: string; shops: ShopLinks[] }[]> {
  const [s, shared] = await Promise.all([getSettings(), sharedSpecials()]);
  return activeSections(s)
    .map((section) => ({
      section,
      title: section === 'pantry' ? 'Groceries' : SECTION_NAMES[section],
      shops: enabledIn(s.enabledChains, section).map((chain) => {
        const known = shopDef(chain)?.catalogue;
        const found = shared.catalogues[chain];
        return {
          chain,
          name: chainName(chain),
          website: https(websiteOf(chain)),
          specials: SPECIALS_URL[chain],
          catalogue: https(known?.url) ?? https(found?.url),
          catalogueNote: known?.note ?? found?.note,
        };
      }),
    }))
    .filter((g) => g.shops.length > 0);
}

export const useShared = () => useLive<SharedSpecials>(sharedSpecials, []);
export const useFollowed = () => useLive(followedShops, []);

// ---------- 0.9.5: the Data tab (docs/server-protocol.md "v3, 0.9.5: Data") ----------

export type DataKind = 'prices' | 'receipts' | 'stats' | 'logs' | 'backups';
export const DATA_KINDS: DataKind[] = ['prices', 'receipts', 'stats', 'logs', 'backups'];
/** The kinds Clean up and Auto delete work on (the trash empties itself after 30 days). */
export const CLEAN_KINDS: DataKind[] = ['prices', 'receipts', 'stats', 'logs'];
/** What the server wants typed in Step 2. */
export const WORD = 'DELETE';
export const WORD_ALL = 'DELETE EVERYTHING';

export interface DataSummary {
  kinds: {
    prices: { count: number; products: number; archives: number; oldest: string | null; bytes: number };
    receipts: { count: number; pinned: number; photos: number; oldest: string | null; bytes: number };
    stats: { count: number; oldest: string | null; bytes: number };
    logs: { count: number; activity: number; oldest: string | null; bytes: number };
    backups: { count: number; folders: number; oldest: string | null; bytes: number; nightly: false; keptDays: number };
  };
  total: number;
  other: number;
  database: number;
  files: number;
  measured: 'dbstat' | 'estimate';
  disk: { free: number; size: number } | null;
  autoDelete: { months: number | null; cutoff: string | null };
  resend: { at: string | null; next: string | null };
  at: string;
}

export interface TopItem {
  key: string;
  itemId: string | null;
  name: string;
  times: number;
  qty: number;
  total: number;
  lastAt: string;
  lastPaid: { price: number; chain: string | null; at: string } | null;
  usual: number | null;
  cheapest: { chain: string; price: number; productId: string; date: string } | null;
}
export interface TopPage {
  items: TopItem[];
  offset: number;
  limit: number;
  total: number;
}

export interface DataStats {
  period: number | 'all';
  from: string | null;
  to: string;
  spending: { total: number; count: number; unpriced: number; months: { month: string; total: number; count: number; unpriced: number }[] };
  shops: { chain: string | null; total: number; count: number; unpriced: number }[];
  /** 0.9.5: by shopping list (General its own), with the list's name. */
  sections: { section: string; name?: string; total: number; count: number }[];
  saved: { total: number; count: number };
  itemsTracked: number;
  productsTracked: number;
  prices: { count: number; first: string | null; inPeriod: number };
  top: TopPage;
}

export interface DataSeries {
  item: { id: string; name: string };
  period: number | 'all';
  from: string | null;
  usual: number | null;
  chains: { chain: string; productId: string; usual: number | null }[];
  weeks: { week: string; chain: string; price: number; special: boolean }[];
  paid: { at: string; chain: string | null; price: number; qty: number }[];
}

export type Row = Record<string, unknown>;
export interface RestockExport {
  format: 'restock-export';
  v: number;
  app?: string;
  version?: string;
  at: string;
  house?: { name?: string };
  autoDelete?: unknown;
  tables: Record<string, Row[] | Record<string, unknown>>;
  paged?: Record<string, { count: number; path: string; limit: number }>;
  truncated?: string[];
}

export interface Deleted {
  cutoff?: string | null;
  prices?: number;
  receipts?: number;
  photos?: number;
  archives?: number;
  stats?: number;
  logs?: number;
  backups?: number;
}

/** The chart periods: months back (the server's `period`), or everything. */
export type Period = 3 | 6 | 12 | 'all';
export const PERIODS: { value: Period; label: string }[] = [
  { value: 3, label: '3 months' },
  { value: 6, label: '6 months' },
  { value: 12, label: '12 months' },
  { value: 'all', label: 'All' },
];

const q = encodeURIComponent;
/** A 0.9.4 server has no Data paths: say so, not "404". */
export const OLD_SERVER = 'This server needs Restock server 0.9.5 or newer for the Data tab. Update it, then reload this page.';
async function newer<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) throw new Error(OLD_SERVER);
    throw e;
  }
}
/** The server's `period` for a chart period ("3", "6", "12", "all"). */
export const periodParam = (p: Period) => (p === 'all' ? 'all' : String(p));
export const data = {
  summary: () => newer(v3Get<DataSummary>('/api/v3/data/summary')),
  stats: (period: Period) => newer(v3Get<DataStats>(`/api/v3/data/stats?period=${periodParam(period)}`)),
  top: (period: Period, offset: number, limit = 10) => v3Get<TopPage>(`/api/v3/data/top?period=${periodParam(period)}&offset=${Math.max(0, offset)}&limit=${limit}`),
  series: (item: string, period: Period) => v3Get<DataSeries>(`/api/v3/data/series?item=${q(item)}&period=${periodParam(period)}`),
  exportFirst: () => v3Get<RestockExport>('/api/v3/data/export'),
  exportPage: (table: 'prices' | 'ticked', after: unknown, limit = 10000) =>
    v3Get<{ table: string; rows: Row[]; next: unknown }>(`/api/v3/data/export/${table}?limit=${limit}${after === null || after === undefined ? '' : `&after=${q(String(after))}`}`),
  /** Step 2 of a delete: `typed` and the passphrase again (`confirm`). `before` null: all of those kinds. */
  delete: (kinds: DataKind[], before: string | null, typed: string, confirm: Confirm) =>
    v3Send<{ deleted: Deleted; kinds: DataKind[]; before: string | null }>('POST', '/api/v3/data/delete', { kinds, ...(before ? { before } : {}), typed, confirm }),
  /** 0.9.5 (review): exactly what that delete would take, deleting nothing (Step 1; no passphrase). */
  count: (kinds: DataKind[], before: string | null) =>
    v3Send<{ counts: Deleted; kinds: DataKind[]; before: string | null }>('POST', '/api/v3/data/delete', { kinds, ...(before ? { before } : {}), dryRun: true }),
  deleteEverything: (typed: string, confirm: Confirm) => v3Send<{ ok: boolean; mode: string; phones: number }>('POST', '/api/v3/data/delete-everything', { typed, confirm }),
  autoDelete: () => v3Get<{ months: number | null; cutoff: string | null }>('/api/v3/data/autodelete'),
  /** Turning it on or shorter needs `typed` and `confirm`; longer or off, neither. */
  setAutoDelete: (months: number | null, typed?: string, confirm?: Confirm) =>
    v3Send<{ months: number | null; cutoff: string | null; was: number | null; deleted: Deleted | null }>('PUT', '/api/v3/data/autodelete', { months, ...(confirm ? { typed, confirm } : {}) }),
  resend: () => v3Send<{ at: string | null; next: string | null }>('POST', '/api/v3/data/resend', {}),
  recount: () => v3Send<{ added: number; removed: number; checked: number; repriced: number }>('POST', '/api/v3/data/recount', {}),
};

/**
 * The full export file: the first answer, with every page of prices and ticked items fetched and
 * put in as `tables.prices` and `tables.ticked` (and `paged` dropped). `onStep` says how far it is.
 */
export async function fullExport(onStep?: (what: string) => void): Promise<RestockExport> {
  const first = await data.exportFirst();
  const tables = { ...first.tables };
  for (const t of ['prices', 'ticked'] as const) {
    const count = first.paged?.[t]?.count ?? 0;
    const rows: Row[] = [];
    let after: unknown = null;
    // A keyset page at a time; at most 1,000 pages (10 million rows) so a bad answer can't loop.
    for (let i = 0; i < 1000; i++) {
      onStep?.(`${t === 'prices' ? 'Prices' : 'Ticked items'}: ${rows.length.toLocaleString('en-AU')} of ${count.toLocaleString('en-AU')}`);
      const page = await data.exportPage(t, after);
      rows.push(...(Array.isArray(page.rows) ? page.rows : []));
      if (page.next === null || page.next === undefined || page.next === after || !page.rows?.length) break;
      after = page.next;
    }
    tables[t] = rows;
  }
  const out: RestockExport = { ...first, tables };
  delete out.paged;
  return out;
}

/** Every item of "What you buy most" for the period (50 a page, at most 200 pages). */
export async function allTop(period: Period): Promise<TopItem[]> {
  const out: TopItem[] = [];
  for (let i = 0; i < 200; i++) {
    const p = await data.top(period, out.length, 50);
    out.push(...p.items);
    if (!p.items.length || out.length >= p.total) break;
  }
  return out;
}

/** "That isn't your passphrase." and the server's own words, for a failed Step 2 (what was typed stays). */
export function deleteError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'current') return "That isn't your passphrase. Nothing was deleted.";
    if (e.code === 'typed') return `${e.message} Nothing was deleted.`;
    if (e.code === 'confirm') return 'Type your passphrase again. Nothing was deleted.';
    if (e.status === 429) return e.message;
    if (e.status === 403 && session()?.viaPhone) return ADMIN_NOTE;
    return `${e.message} Nothing was deleted.`;
  }
  return errText(e);
}

/** "Restock 0.9.4 server · v3", for About. */
export const serverLine = () => {
  const i = serverInfo();
  return i?.version ? `Restock server ${i.version}` : 'Restock server';
};
