// Server mode (0.9.2): taking in the phones' changes, and writing the web's own, with the same
// rules as the phones (SyncEngine.java apply/collect, SyncFolder.java readOthers/writeOwn,
// SyncHousehold.java allowed). Ported line by line; tools/sync-test/web-parity.sh checks that a
// set of files gives the same rows here as on a phone, and that phones take in the web's file.
//
// Differences from a phone, on purpose:
// - The web never makes household changes (it has no signing key) and leaves the household's and
//   loyalty cards' entries out of its own file. Household changes from the phones are checked
//   like on a phone: owner-only ones must carry the owner key's signature (pinned from the link,
//   or the first one seen, as a phone that has just joined does).
// - Loyalty card numbers are blanked as they come in: they never reach the browser's storage.
// - No receipt photos are kept here (they're fetched from the server when a receipt is opened).
// - 0.9.3: household settings (household_settings) come in like a phone's and are applied to the
//   web's own settings the same way (sharedSettings.ts, SharedSettings.java); the web never seeds
//   them (only the owner phone does). A phone's settings summary (phoneSummary.ts) is kept per
//   phone for the web's Settings → Phones.
// - 0.9.3: a file's author is its name (restock-sync-<device>.bin: the server lets each device write
//   only its own), exactly as a phone on a server reads them (SyncFolder.readOthers): a file that
//   names another device inside is passed over, and another browser's file never changes the
//   household, loyalty cards or prices (SyncFolder.webEntries).
//
// Synchronous on purpose (the sql.js database itself, not the async driver), so nothing the
// screens do can land in the middle of taking changes in.
//
// 0.9.4 (protocol v3, docs/server-protocol.md): the same engine runs on the Restock server, which is
// then the household's owner (`role: 'server'`, through the core build, src/server-core):
// - its own file leaves out only loyalty cards, and carries prices changed in the last 60 days (as a
//   phone's file on a server does), the household's rows with their signatures, and `seen`;
// - it changes the household with writeHousehold, signed with the owner key it holds;
// - it takes in from each phone only what that phone says it shares (the file's `shares`), and
//   nothing older than "Keep data for" (keepFrom); prune() drops what's older, without deletes;
// - card numbers are still blanked as they come in.
// A phone's own choice of receipts (sync_meta share_receipts, "0" = off) now counts here too.

import { isCustomSection, isLocalOnlyShop, LOCAL_ONLY_SHOPS, shopDef } from '../shops';

/** 0.9.6: the pseudo tab of records that never leave one phone (Costco's products and prices). Never in any shared set. SyncEngine.LOCAL_TAB. */
const LOCAL_TAB = 'local';

/** 0.9.6 (review H1): a list line at Costco, or with a Costco product behind it (made by an earlier 0.9.6 build). */
export function isCostcoLine(row: Row | null | undefined): boolean {
  if (!row) return false;
  if (typeof row.chain === 'string' && isLocalOnlyShop(row.chain)) return true;
  if (typeof row.product === 'string' && row.product) {
    try {
      const p = JSON.parse(row.product) as { chain?: unknown } | null;
      return !!p && typeof p === 'object' && typeof p.chain === 'string' && isLocalOnlyShop(p.chain);
    } catch {
      return false;
    }
  }
  return false;
}

/** SyncEngine.stripCostcoLine: a Costco list line goes as "Any shop": no Costco shop, price or product leaves the phone. */
export function stripCostcoLine(data: Row): void {
  if (!isCostcoLine(data)) return;
  data.chain = null;
  data.price = null;
  data.product = null;
}

/**
 * SyncEngine.keepLocalCostcoLine: a change from another device to a line this phone has at Costco
 * keeps this phone's own Costco shop, price and product when the other device left the shop as
 * "Any shop" (all it could see) and the words are the same. A shop they picked, or new words, win.
 */
export function keepLocalCostcoLine(cur: Row, merged: Row): void {
  if (!isCostcoLine(cur)) return;
  const none = (v: unknown) => v === null || v === undefined || v === '';
  if (!none(merged.chain) || !none(merged.product) || !none(merged.price)) return;
  if (String(merged.text ?? '') !== String(cur.text ?? '')) return;
  merged.chain = cur.chain ?? null;
  merged.price = cur.price ?? null;
  merged.product = cur.product ?? null;
}
import { applyRows, checkValue, keysFor, settingChangeOk, settingTab, valueOf as settingValueOf, type SettingsRoom } from '../lib/sharedSettings';
import { cleanSummary } from '../lib/phoneSummary';

export type Row = Record<string, unknown>;

/** The database as the engine needs it (sql.js in the browser). */
export interface SyncDb {
  query(sql: string, args?: unknown[]): Row[];
  exec(sql: string, args?: unknown[]): void;
  transaction(body: () => void): void;
}

/**
 * 0.15.1: the same database, answered later: the iPhone and iPad app's own SQLite, over the bridge
 * to Swift. A transaction holds the database: nothing else is written to it until it ends.
 */
export interface AsyncSyncDb {
  query(sql: string, args?: unknown[]): Promise<Row[]>;
  exec(sql: string, args?: unknown[]): Promise<void>;
  transaction(body: () => Promise<void>): Promise<void>;
  /** Holds the database while the engine does one thing (nothing else reads or writes it meanwhile). */
  exclusive?<T>(fn: () => Promise<T>): Promise<T>;
}

// 0.15.1: the engine's work is written once, as steps that each ask the database one thing (DbOp),
// and run on either kind of database: straight away (SyncDb: the server, the web) or awaited
// (AsyncSyncDb: the iPhone and iPad app). WebSyncEngine and AsyncSyncEngine run them.
export type DbOp = { k: 'q'; sql: string; args?: unknown[] } | { k: 'x'; sql: string; args?: unknown[] } | { k: 'tx'; body: Gen<void> };
export type Gen<T> = Generator<DbOp, T, unknown>;

function* qry(sql: string, args?: unknown[]): Gen<Row[]> {
  return (yield { k: 'q', sql, args }) as Row[];
}
function* run(sql: string, args?: unknown[]): Gen<void> {
  yield { k: 'x', sql, args };
}
function* txn(body: Gen<void>): Gen<void> {
  yield { k: 'tx', body };
}

/** Runs the steps on a database that answers straight away. */
export function runOn<T>(db: SyncDb, g: Gen<T>): T {
  let next = g.next();
  while (!next.done) {
    const op = next.value;
    let answer: unknown;
    try {
      if (op.k === 'q') answer = db.query(op.sql, op.args);
      else if (op.k === 'x') db.exec(op.sql, op.args);
      else db.transaction(() => runOn(db, op.body));
    } catch (e) {
      next = g.throw(e);
      continue;
    }
    next = g.next(answer);
  }
  return next.value;
}

/** Runs the steps on a database that answers later. */
export async function runOnAsync<T>(db: AsyncSyncDb, g: Gen<T>): Promise<T> {
  let next = g.next();
  while (!next.done) {
    const op = next.value;
    let answer: unknown;
    try {
      if (op.k === 'q') answer = await db.query(op.sql, op.args);
      else if (op.k === 'x') await db.exec(op.sql, op.args);
      else await db.transaction(() => runOnAsync(db, op.body));
    } catch (e) {
      next = g.throw(e);
      continue;
    }
    next = g.next(answer);
  }
  return next.value;
}

const isSteps = (f: unknown): boolean => typeof f === 'function' && Object.prototype.toString.call(f) === '[object GeneratorFunction]';

/** SyncCore's steps as plain methods, on a database that answers straight away. */
type Straight<T> = { [K in keyof T]: T[K] extends (...a: infer A) => Gen<infer R> ? (...a: A) => R : T[K] };
/** SyncCore's steps as methods that answer later. */
type Later<T> = { [K in keyof T]: T[K] extends (...a: infer A) => Gen<infer R> ? (...a: A) => Promise<R> : T[K] };

function facade<T extends object>(core: T, run: (g: Gen<unknown>) => unknown, own: Record<string, unknown>): unknown {
  return new Proxy(core, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in own) return own[prop];
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (isSteps(v)) return (...a: unknown[]) => run((v as (...a: unknown[]) => Gen<unknown>).apply(target, a));
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

export interface Entry {
  tbl: string;
  pk: string;
  stamp: number;
  device?: string;
  deleted?: boolean | string;
  created?: number;
  row?: Row | null;
  sig?: string | null;
  moved?: boolean | string;
  /** 0.9.4: the device that made the record (sync_log.origin), when known. */
  origin?: string | null;
}

export interface SyncFileMessage {
  format?: string;
  v?: number;
  device?: string;
  name?: string;
  keyv?: number;
  at?: string;
  top?: number;
  seen?: Record<string, number>;
  entries?: Entry[];
  photos?: Record<string, string>;
  /** 0.9.3: a phone's settings summary (its file on a Restock server only; phoneSummary.ts). */
  summary?: unknown;
  /** 0.9.4: what this phone shares with a v3 server (its file on a v3 server only). */
  shares?: Shares;
}

/** 0.9.4: what a phone shares with its server (docs/server-protocol.md "v3"). */
export interface Shares {
  /** The tabs it shares ("pantry" is the groceries: pantry and shopping list). */
  tabs: string[];
  receipts: boolean;
  cards: boolean;
}

/** 0.9.4: the engine's options. */
export interface EngineOptions {
  /**
   * 'web' (the default): the web app. 'server': the Restock server, the household's owner.
   * 'phone' (0.13.2): the iPhone and iPad app, a phone of the household like an Android one
   * (SyncEngine.java, SyncFolder.java): its file carries recent prices and the household's rows it
   * holds, loyalty cards only when it shares them, and cards that come in are kept whole.
   */
  role?: 'web' | 'server' | 'phone';
  /** Server: signs a household change's text (signedText) with the owner key; base64url DER. */
  sign?: (text: string, ownerPriv: string | null) => string;
  /**
   * Server: the oldest date kept ("Keep data for"), an ISO time (keepCutoff), or null to keep
   * everything. Asked each time a file comes in, so a changed setting counts from the next file.
   */
  keepFrom?: () => string | null;
  /** Phone: false for a file that carries no prices (a picked folder); a server's file carries the last 60 days'. */
  prices?: boolean;
}

/** 0.9.4: the household's owner-signed `server` row (where the house is, its kex key, Keep data for). */
export interface ServerRow {
  v: 3;
  sid: string;
  home: string;
  away?: string | null;
  kex: string;
  keepMonths: number | null;
}

/** 0.9.4: "Keep data for" choices, in months (null: Until I delete). 0.9.4 phones only understand these. */
export const KEEP_MONTHS = [3, 6, 9, 12] as const;
/** 0.9.5: Auto delete (0.9.4's "Keep data for"): any whole number of months from 1 to 120 (null: off). As SyncHousehold.keepMonthsOk. */
export const keepMonthsOk = (m: unknown): m is number => typeof m === 'number' && Number.isInteger(m) && m >= 1 && m <= 120;
/** 0.9.4: a month for "Keep data for": a year's 365.25 days over 12, in ms (the same in Java and Node). */
export const MONTH_MS = 2_629_800_000;

/**
 * 0.9.4: the cut-off for "Keep data for" `keepMonths` at `now` (ms): an ISO time; data dated before it
 * goes (prices by `date`, receipts by `scanned_at`, archive months wholly before it, logs by `at`).
 * null (off), or a value that isn't a whole number of months from 1 to 120 (0.9.5): no cut-off.
 */
export function keepCutoff(keepMonths: number | null | undefined, now: number = Date.now()): string | null {
  if (!keepMonthsOk(keepMonths) || !Number.isFinite(now)) return null;
  return new Date(now - keepMonths * MONTH_MS).toISOString();
}

/** 0.9.4: a `server` row's value, checked; null when it isn't one. */
export function parseServerRow(v: string | null | undefined): ServerRow | null {
  if (!v) return null;
  try {
    const m = JSON.parse(v) as Partial<ServerRow>;
    if (!m || m.v !== 3 || typeof m.sid !== 'string' || typeof m.home !== 'string' || typeof m.kex !== 'string') return null;
    const keep = keepMonthsOk(m.keepMonths) ? m.keepMonths : null;
    return { v: 3, sid: m.sid, home: m.home, away: typeof m.away === 'string' ? m.away : null, kex: m.kex, keepMonths: keep };
  } catch {
    return null;
  }
}

/** 0.9.4: a file's `shares`, checked; null when it has none (a 0.9.3 phone, the web: take what it sends). */
export function parseShares(raw: unknown): Shares | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { tabs?: unknown; receipts?: unknown; cards?: unknown };
  const tabs = Array.isArray(r.tabs) ? ALL_TABS.filter((t) => (r.tabs as unknown[]).includes(t)) : [];
  return { tabs, receipts: r.receipts === true, cards: r.cards === true };
}

/** Mirrors SyncEngine.TABLES. */
export const TABLES: [string, string][] = [
  ['categories', 'id'],
  ['products', 'id'],
  ['items', 'id'],
  ['list_entries', 'id'],
  ['cards', 'id'],
  ['prices', "product_id || '|' || date"],
  ['household', 'k'],
  ['receipts', 'id'],
  // 0.9.3: household-wide settings.
  ['household_settings', 'k'],
];
export const CLOCK_SLACK_MS = 24 * 3600 * 1000;
export const OLD_DELETE_MS = 180 * 24 * 3600 * 1000;
export const DELETE_WINS = new Set(['items', 'list_entries', 'products', 'categories', 'cards', 'receipts']);
export const ALL_TABS = ['pantry', 'keg', 'pharmacy'];
/** 0.10.3: Baby and Pets records are shared with Groceries (SyncEngine.java shared). */
export const sharedTab = (t: string): string => (isCustomSection(t) ? 'pantry' : t);
/** 0.9.5: sync_meta lists_v once catchUpLists has read everything again (SyncEngine.LISTS_V). */
export const LISTS_V = '95';
export const LOCAL_PRODUCT_COLUMNS = new Set(['in_stock', 'stock_at', 'in_stock_2']);
/** What the web's own file never carries (SyncFolder.writeOwn leaves prices out; the rest is the web's choice). */
export const WEB_LEAVES_OUT = ['prices', 'household', 'cards'];
/** 0.9.4: what the server's own file never carries (card numbers never reach it anyway). */
export const SERVER_LEAVES_OUT = ['cards'];
/** 0.9.4: prices changed this recently go in the server's own file (as a phone's on a server, SyncFolder). */
export const SERVER_PRICES_MS = 60 * 24 * 3600 * 1000;
/** 0.9.4: deletes older than this that every phone has seen are tidied away (SyncEngine.COMPACT_AFTER_MS). */
export const COMPACT_AFTER_MS = 90 * 24 * 3600 * 1000;
/** What a browser's file can't change, wherever it came from (SyncFolder.WEB_LEAVES_OUT, webEntries). */
const NOT_FROM_A_BROWSER = new Set(['household', 'cards', 'prices']);
const PREFIX = 'restock-sync-';
const SUFFIX = '.bin';

const keyOf = (tbl: string) => TABLES.find((t) => t[0] === tbl)?.[1];
/** 0.9.4: what a device id in an entry's `origin` can look like (SyncEngine.ORIGIN). */
const ORIGIN = /^[A-Za-z0-9._-]{1,80}$/;
const truthy = (v: unknown) => v === true || v === 'true';
const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

function str(row: Row | null | undefined, k: string): string | null {
  if (!row) return null;
  const v = row[k];
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
}

/** SyncEngine.newer: the later stamp wins; a tie goes to the larger device id. */
export const newer = (stamp: number, device: string, mineStamp: number, mineDevice: string) =>
  stamp > mineStamp || (stamp === mineStamp && device > mineDevice);

export function parseTabs(s: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (s === null || s === undefined) {
    ALL_TABS.forEach((t) => out.add(t));
    return out;
  }
  for (const t of s.split(',')) {
    const x = t.trim();
    if (ALL_TABS.includes(x)) out.add(x);
  }
  return out;
}

export const joinTabs = (tabs: Set<string>) => ALL_TABS.filter((t) => tabs.has(t)).join(',');

/** The one way the web asks whether a household change may come in (SyncHousehold.allowed). */
export type SigCheck = (pub: string, text: string, sig: string) => boolean;

export class SyncCore {
  private customTabs?: Map<string, string>;
  readonly role: 'web' | 'server' | 'phone';

  constructor(
    private readonly verify: SigCheck,
    private readonly signedText: (e: Entry) => string,
    private readonly now: () => number = () => Date.now(),
    private readonly opts: EngineOptions = {},
  ) {
    this.role = opts.role ?? 'web';
  }

  // ---------- this browser ----------

  *meta(key: string): Gen<string | null> {
    const r = (yield* qry('SELECT value FROM sync_meta WHERE key = ?', [key]));
    return r.length ? (r[0].value as string | null) : null;
  }

  *setMeta(key: string, value: string | null): Gen<void> {
    if (value === null) (yield* run('DELETE FROM sync_meta WHERE key = ?', [key]));
    else (yield* run('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, value]));
  }

  *device(): Gen<string> {
    return (yield* this.meta('device')) ?? '';
  }

  *householdValue(k: string): Gen<string | null> {
    const r = (yield* qry('SELECT v FROM household WHERE k = ?', [k]));
    return r.length ? (r[0].v as string | null) : null;
  }

  *shareCards(): Gen<boolean> {
    return (yield* this.meta('share_cards')) === '1';
  }

  /** 0.9.4: the household shares receipts and this device hasn't turned them off (share_receipts "0"). */
  *shareReceipts(): Gen<boolean> {
    return (yield* this.householdValue('receipts')) === '1' && (yield* this.meta('share_receipts')) !== '0';
  }

  *householdTabs(): Gen<Set<string>> {
    return parseTabs((yield* this.householdValue('tabs')));
  }

  *tabs(): Gen<Set<string>> {
    const t = parseTabs((yield* this.meta('tabs')));
    const h = (yield* this.householdTabs());
    return new Set([...t].filter((x) => h.has(x)));
  }

  /** SyncEngine.releaseHeld: the plain deletes held back for a tab not synced, taken in once it is. */
  *releaseHeld(): Gen<number> {
    const mine = (yield* this.tabs());
    const go: Entry[] = [];
    const done: [string, string][] = [];
    for (const r of (yield* qry('SELECT tbl, pk, entry FROM sync_held'))) {
      const tbl = String(r.tbl);
      const pk = String(r.pk);
      const key = keyOf(tbl);
      let e: Entry | null = null;
      try {
        e = JSON.parse(String(r.entry)) as Entry;
      } catch {
        e = null;
      }
      if (key && e && typeof e === 'object') {
        const cur = (yield* qry(`SELECT * FROM ${tbl} WHERE ${key} = ?`, [pk]));
        const tab = cur.length ? (yield* this.tabOf(tbl, cur[0])) : null;
        if (tab !== null && !mine.has(tab)) continue;
        go.push(e);
      }
      done.push([tbl, pk]);
    }
    const n = go.length ? (yield* this.apply(go)) : 0;
    for (const [tbl, pk] of done) (yield* run('DELETE FROM sync_held WHERE tbl = ? AND pk = ?', [tbl, pk]));
    return n;
  }

  /**
   * SyncEngine.catchUpLists (0.9.5): the first time this version syncs, every other device's file is
   * read again, once. A 0.9.4 web page or server passed over General list lines (a tab it didn't
   * know); read again, they come in now. Nothing of this device's is sent again. True when there
   * was something to read again.
   * 0.9.5 (review): a file read again unchanged (the sum it had: `catchup:folder_seen:<name>`) only
   * brings General lines that aren't here at all (catchUpEntries): an old file (a browser signed out
   * long ago, a stale cloud copy) still holds records deleted so long ago that the delete was tidied
   * away, and must not bring them back. A file that changed since is read as always.
   */
  *catchUpLists(): Gen<boolean> {
    if ((yield* this.meta('lists_v')) === LISTS_V) return false;
    const any = (yield* qry("SELECT 1 FROM sync_meta WHERE key LIKE 'folder_seen:%' LIMIT 1")).length > 0;
    if (any)
      (yield* txn((function* (this: SyncCore) {
        (yield* run("INSERT OR REPLACE INTO sync_meta (key, value) SELECT 'catchup:' || key, value FROM sync_meta WHERE key LIKE 'folder_seen:%'"));
        (yield* run("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'folder_ver:%'"));
      }).call(this)));
    (yield* this.setMeta('lists_v', LISTS_V));
    return any;
  }

  /** 0.9.5 (review): is this file being read again by catchUpLists, unchanged (`sum` as it was)? */
  *catchingUp(name: string, sum: string): Gen<boolean> {
    const was = (yield* this.meta('catchup:folder_seen:' + name));
    return was !== null && was === sum;
  }

  /**
   * 0.9.5 (review), SyncEngine.catchUpEntries: what a catch-up read takes from a file: only General
   * list lines (section 'general') this device has never had (no row, no change noted). Nothing else.
   */
  *catchUpEntries(entries: Entry[] | null | undefined): Gen<Entry[]> {
    const out: Entry[] = [];
    for (const x of Array.isArray(entries) ? entries : []) {
      if (!x || typeof x !== 'object' || x.tbl !== 'list_entries' || typeof x.pk !== 'string' || truthy(x.deleted)) continue;
      const row = x.row && typeof x.row === 'object' ? x.row : null;
      if (!row || str(row, 'section') !== 'general' || String(row.id ?? '') !== x.pk) continue;
      if ((yield* qry('SELECT 1 FROM list_entries WHERE id = ?', [x.pk])).length) continue;
      if ((yield* qry("SELECT 1 FROM sync_log WHERE tbl = 'list_entries' AND pk = ?", [x.pk])).length) continue;
      out.push(x);
    }
    return out;
  }

  /** SyncEngine.noteTabs: sharing more now? Go through everything again. */
  *noteTabs(): Gen<boolean> {
    (yield* this.resendCostcoLines());
    const caught = (yield* this.catchUpLists());
    const now = (yield* this.tabs());
    const was = (yield* this.meta('tabs_eff'));
    const before = was === null ? null : parseTabs(was);
    const receipts = (yield* this.shareReceipts());
    const rwas = (yield* this.meta('receipts_eff'));
    const receiptsOn = receipts && rwas !== '1';
    const again = (before !== null && ![...now].every((t) => before.has(t))) || receiptsOn;
    if (again) {
      (yield* txn((function* (this: SyncCore) {
        (yield* run('UPDATE sync_peers SET got = 0'));
        (yield* run('UPDATE sync_log SET seq = seq + (SELECT COALESCE(MAX(seq), 0) FROM sync_log)'));
        // 0.9.5 (review): a full read again (catch-up markers too: everything is read as always).
        (yield* run("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'folder_ver:%' OR key LIKE 'catchup:%'"));
      }).call(this)));
      (yield* this.releaseHeld());
    }
    const j = joinTabs(now);
    if (j !== was) {
      (yield* this.setMeta('tabs_eff', j));
      // 0.9.3: syncing another tab (or one fewer): its household settings apply from now.
      (yield* this.applySharedSettings());
    }
    const r = receipts ? '1' : '0';
    if (r !== rwas) (yield* this.setMeta('receipts_eff', r));
    return again || caught;
  }

  *chainTab(chain: string | null): Gen<string | null> {
    if (!chain) return null;
    // 0.9.6: Costco is one phone's own: a "tab" no device ever shares (SyncEngine.LOCAL_TAB).
    if (isLocalOnlyShop(chain)) return LOCAL_TAB;
    const def = shopDef(chain);
    // 0.10.3: Baby and Pets shops are shared with Groceries (SyncEngine.java shared).
    if (def) return sharedTab(def.section);
    if (!this.customTabs) {
      this.customTabs = new Map();
      try {
        const r = (yield* qry("SELECT value FROM kv WHERE key = 'settings'"));
        const list = r.length ? (JSON.parse(String(r[0].value)) as { customShops?: { id?: string; section?: string }[] }).customShops : undefined;
        if (Array.isArray(list)) for (const c of list) if (c && typeof c === 'object') this.customTabs.set(String(c.id ?? ''), c.section ?? 'pantry');
      } catch {
        // no settings yet
      }
    }
    const t = this.customTabs.get(chain);
    return t === undefined ? null : sharedTab(t);
  }

  *tabOf(tbl: string, row: Row | null | undefined): Gen<string | null> {
    const t = (yield* this.tabOfRaw(tbl, row));
    return t === null ? null : sharedTab(t);
  }

  private *tabOfRaw(tbl: string, row: Row | null | undefined): Gen<string | null> {
    switch (tbl) {
      case 'categories':
      case 'items':
        return str(row, 'section') ?? 'pantry';
      case 'list_entries': {
        // 0.9.6 (review H1): a line an earlier build put at Costco is an ordinary line, shared as
        // "Any shop" (stripCostcoLine), never on Costco's own tab: ticks and deletes still reach everyone.
        // 0.9.5: a General line (section 'general') is shared with the groceries.
        const s = str(row, 'section');
        if (s !== null) return s === 'general' ? 'pantry' : s;
        const item = str(row, 'item_id');
        if (item !== null) {
          const r = (yield* qry('SELECT section FROM items WHERE id = ?', [item]));
          return r.length ? str(r[0], 'section') : null;
        }
        const chain = str(row, 'chain');
        return chain !== null && !isLocalOnlyShop(chain) ? (yield* this.chainTab(chain)) : 'pantry';
      }
      case 'products':
        return (yield* this.chainTab(str(row, 'chain')));
      case 'receipts':
        return str(row, 'section') ?? 'pantry';
      case 'prices': {
        const r = (yield* qry('SELECT chain FROM products WHERE id = ?', [str(row, 'product_id')]));
        return r.length ? (yield* this.chainTab(str(r[0], 'chain'))) : null;
      }
      case 'household_settings':
        return settingTab(str(row, 'k') ?? '', str(row, 'v'));
      default:
        return null;
    }
  }

  // ---------- other devices ----------

  *notePeer(peer: string, name: string | null): Gen<void> {
    if (!peer) return;
    (yield* run('INSERT OR IGNORE INTO sync_peers (device, got) VALUES (?, 0)', [peer]));
    if (name !== null) (yield* run('UPDATE sync_peers SET name = ? WHERE device = ?', [name, peer]));
  }

  *setSeen(peer: string, seen: number): Gen<void> {
    if (!peer || seen <= 0) return;
    const max = num((yield* qry('SELECT COALESCE(MAX(seq), 0) AS top FROM sync_log'))[0].top);
    const v = Math.min(seen, max);
    (yield* run('INSERT OR IGNORE INTO sync_peers (device, got) VALUES (?, 0)', [peer]));
    (yield* run('UPDATE sync_peers SET seen = ? WHERE device = ? AND seen < ?', [v, peer, v]));
  }

  *markSynced(peer: string, when: string): Gen<void> {
    (yield* run('UPDATE sync_peers SET synced_at = ? WHERE device = ?', [when, peer]));
  }

  // ---------- what changed here ----------

  /** SyncEngine.collect (the full version). */
  *collect(since: number, exclude: string | null, limit: number, allowed: Set<string> | null, where: string, moves: boolean, oldestDelete: number) {
    if (!allowed) allowed = (yield* this.tabs());
    let rows = (yield* qry(`SELECT tbl, pk, stamp, device, deleted, seq, sig, created, origin FROM sync_log WHERE seq > ?${where} ORDER BY seq LIMIT ?`, [since, limit + 1]));
    const more = rows.length > limit;
    if (more) rows = rows.slice(0, limit);
    const cards = (yield* this.shareCards());
    const receipts = (yield* this.shareReceipts());
    const entries: Entry[] = [];
    let top = since;
    for (const r of rows) {
      top = Math.max(top, num(r.seq));
      const tbl = String(r.tbl);
      const key = keyOf(tbl);
      const pk = String(r.pk);
      if (!key || (exclude !== null && exclude === r.device)) continue;
      if (tbl === 'cards' && !cards) continue;
      if (tbl === 'receipts' && !receipts) continue;
      if (pk.startsWith('demo-')) continue;
      const e: Entry = { tbl, pk, stamp: num(r.stamp), device: String(r.device), created: num(r.created) };
      if (typeof r.origin === 'string' && r.origin) e.origin = r.origin;
      const deleted = num(r.deleted) !== 0;
      if (deleted && oldestDelete > 0 && num(r.stamp) < oldestDelete) continue;
      e.deleted = deleted;
      if (!deleted) {
        const row = (yield* qry(`SELECT * FROM ${tbl} WHERE ${key} = ?`, [pk]));
        if (!row.length) continue;
        const data = { ...row[0] };
        const tab = (yield* this.tabOf(tbl, data));
        if (tab === LOCAL_TAB) continue; // 0.9.6: Costco stays on its phone, not even as a "moved" record
        if (tab !== null && !allowed.has(tab)) {
          // 0.9.3: a household setting of a tab this pair doesn't share is left out, never sent as moved.
          if (!moves || tbl === 'prices' || tbl === 'household_settings') continue;
          e.deleted = true;
          e.moved = true;
          entries.push(e);
          continue;
        }
        if (tbl === 'prices') delete data.id;
        if (tbl === 'products') for (const c of LOCAL_PRODUCT_COLUMNS) delete data[c];
        if (tbl === 'items') (yield* this.stripCostcoPicks(data));
        if (tbl === 'list_entries') stripCostcoLine(data);
        e.row = data;
      }
      if (tbl === 'household') {
        const sig = r.sig === null || r.sig === undefined ? null : String(r.sig);
        if (sig !== null) e.sig = sig;
      }
      entries.push(e);
    }
    return { entries, top, more };
  }

  private *logEntry(tbl: string, pk: string, stamp: number, device: string, deleted: boolean, sig: string | null, created: number, origin: string | null): Gen<void> {
    (yield* run(
      'INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq, sig, created, origin) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log), ?, ?, ?)',
      [tbl, pk, stamp, device, deleted ? 1 : 0, sig, created, origin],
    ));
  }

  /**
   * 0.9.4 (SyncEngine.originOf): who made a record, as noted when a change to it comes in. A record
   * that's here (and not deleted) keeps its own, unless the change made it again (a newer `created`);
   * a new one, or one made again, takes the entry's `origin`, or, from a device that doesn't send one,
   * the entry's own device when that change was the one that made it (stamp = created). Never filled
   * in later, so nobody can claim a record they didn't make. On the server, a file claiming that its
   * own phone made a record someone else changed last isn't believed (`from`: the file's phone).
   */
  private originOf(e: Entry, stamp: number, device: string, deleted: boolean, created: number, had: Row | null, from: string | null): string | null {
    const hadOrigin = had !== null && typeof had.origin === 'string' && had.origin ? had.origin : null;
    if (had !== null && num(had.deleted) === 0 && (deleted || created <= num(had.created))) return hadOrigin;
    if (deleted) return hadOrigin;
    let claim = typeof e.origin === 'string' && ORIGIN.test(e.origin) ? e.origin : created > 0 && stamp === created && ORIGIN.test(device) ? device : null;
    if (claim !== null && from !== null && claim === from && device !== from) claim = null;
    return claim;
  }

  /** 0.9.4, the server: the phone whose file is being taken in (for originOf). */
  private applyingFrom: string | null = null;

  // ---------- taking in another device's changes ----------

  /** SyncEngine.apply. Returns how many records changed here. */
  *apply(entries: Entry[] | null | undefined): Gen<number> {
    let changed = 0;
    if (!entries || !entries.length) return 0;
    const columns = new Map<string, Set<string>>();
    const mine = (yield* this.tabs());
    const now = this.now();
    const receipts = (yield* this.shareReceipts());
    let settings = false;
    const room = (yield* this.settingsRoom());
    (yield* txn((function* (this: SyncCore) {
      (yield* run("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')"));
      let clock = 0;
      for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        const tbl = typeof e.tbl === 'string' ? e.tbl : '';
        const key = keyOf(tbl);
        if (!key) continue;
        if (typeof e.pk !== 'string') throw new Error('an entry without pk');
        const pk = e.pk;
        if (pk.startsWith('demo-')) continue;
        const stamp = Math.trunc(Number(e.stamp));
        if (!Number.isFinite(stamp)) throw new Error('an entry without stamp');
        const device = typeof e.device === 'string' ? e.device : e.device === undefined || e.device === null ? '' : String(e.device);
        const deleted = truthy(e.deleted);
        if (tbl === 'household' && !(yield* this.householdChangeAllowed(pk, device, e))) continue;
        if (tbl === 'receipts' && !receipts) continue;
        // 0.13.2, a phone: loyalty cards only when this phone shares its own (SyncEngine.apply).
        if (tbl === 'cards' && this.role === 'phone' && !(yield* this.shareCards())) continue;
        // 0.9.3: household settings only of a sensible size and shape, and not without end.
        if (tbl === 'household_settings' && !settingChangeOk(pk, e.row, deleted, room)) continue;
        if (stamp > now + CLOCK_SLACK_MS) (yield* this.setMeta('clock_warn', device));
        else clock = Math.max(clock, stamp);
        const hadRows = (yield* qry('SELECT stamp, device, deleted, created, origin FROM sync_log WHERE tbl = ? AND pk = ?', [tbl, pk]));
        const had = hadRows.length ? hadRows[0] : null;
        let wins = had === null || newer(stamp, device, num(had.stamp), String(had.device ?? ''));
        const created = Math.trunc(num(e.created));
        const hadDeleted = had !== null && num(had.deleted) !== 0;
        if (had !== null && DELETE_WINS.has(tbl)) {
          // 0.9.4: a "moved" delete (the record's own stamp) wins only if it's newer too (SyncEngine.apply).
          if (deleted && !hadDeleted) wins = (!truthy(e.moved) || wins) && stamp > num(had.created);
          else if (!deleted && hadDeleted) wins = created > num(had.stamp);
        }
        if (tbl === 'list_entries' && !deleted && had !== null && !hadDeleted) {
          if ((yield* this.mergeListLine(e, stamp, device, created, wins, had, mine, columns))) changed++;
          continue;
        }
        if (!wins) continue;
        if (deleted && truthy(e.moved)) {
          if (tbl === 'household_settings') continue;
          const cur = (yield* qry(`SELECT * FROM ${tbl} WHERE ${key} = ?`, [pk]));
          if (!cur.length) continue;
          const tab = (yield* this.tabOf(tbl, cur[0]));
          if (tab === null || !mine.has(tab)) continue;
        } else if (deleted) {
          // 0.9.4: a plain delete of a record here on a tab this device doesn't sync stays out, like
          // the tab's changes (SyncEngine.apply): what someone took off the server is only for the
          // devices sharing that tab.
          const cur = (yield* qry(`SELECT * FROM ${tbl} WHERE ${key} = ?`, [pk]));
          const tab = cur.length ? (yield* this.tabOf(tbl, cur[0])) : null;
          if (tab === LOCAL_TAB) continue; // 0.9.6: nobody else has Costco's records to delete
          if (tab !== null && !mine.has(tab)) {
            // Held until this device syncs that tab again (releaseHeld), so it still goes then, even
            // if the others have tidied the delete away by then (review fix).
            (yield* run('INSERT OR REPLACE INTO sync_held (tbl, pk, entry) VALUES (?, ?, ?)', [tbl, pk, JSON.stringify(e)]));
            continue;
          }
        }
        const row = e.row && typeof e.row === 'object' ? e.row : null;
        if (!deleted) {
          const tab = (yield* this.tabOf(tbl, row));
          if (tab !== null && !mine.has(tab)) continue;
        }
        if (deleted) {
          (yield* run(`DELETE FROM ${tbl} WHERE ${key} = ?`, [pk]));
        } else {
          if (row === null) continue;
          if (tbl === 'items') (yield* this.keepLocalCostcoPicks(pk, row));
          (yield* this.writeRow(tbl, tbl === 'cards' && this.role !== 'phone' ? stripCard(row) : row, (yield* this.columnsOf(tbl, columns))));
        }
        (yield* this.logEntry(tbl, pk, stamp, device, deleted, e.sig === null || e.sig === undefined ? null : String(e.sig), created, this.originOf(e, stamp, device, deleted, created, had, this.applyingFrom)));
        if (tbl === 'household_settings') settings = true;
        changed++;
      }
      const was = (yield* this.meta('clock'));
      let cur = was === null ? 0 : Number(was) || 0;
      if (cur > now + CLOCK_SLACK_MS) cur = 0;
      (yield* this.setMeta('clock', String(Math.min(Math.max(clock, cur), now + CLOCK_SLACK_MS))));
      // 0.9.3: household settings that came in change the settings here (SyncEngine.apply).
      if (settings) (yield* this.applySharedSettings());
      (yield* run("DELETE FROM sync_meta WHERE key = 'applying'"));
    }).call(this)));
    return changed;
  }

  // ---------- 0.9.6: picks at Costco stay on their phone (SyncEngine.stripCostcoPicks) ----------

  private *costcoIds(): Gen<Set<string>> {
    if (!LOCAL_ONLY_SHOPS.length) return new Set(); // 0.9.7: Costco is shared like any shop
    return new Set((yield* qry("SELECT id FROM products WHERE chain = 'costco'")).map((r) => String(r.id)));
  }

  private idList(v: unknown): string[] {
    try {
      const a: unknown = JSON.parse(typeof v === 'string' && v ? v : '[]');
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  }

  /** An item sent to another device goes without its Costco picks (those products never leave this phone). */
  *stripCostcoPicks(data: Row): Gen<void> {
    const gone = (yield* this.costcoIds());
    if (!gone.size) return;
    // 0.9.6 (review L2): only the Costco part goes. A usual pick at Costco is left out of the record
    // altogether (items are updated in place), so every other phone keeps its own usual pick; lists
    // without a Costco product in them go as they are (null stays null).
    if (typeof data.usual_product_id === 'string' && gone.has(data.usual_product_id)) delete data.usual_product_id;
    for (const col of ['same_product_ids', 'alt_product_ids']) {
      const ids = this.idList(data[col]);
      if (ids.some((id) => gone.has(id))) data[col] = JSON.stringify(ids.filter((id) => !gone.has(id)));
    }
  }

  /** An item that came in keeps this phone's own Costco picks (what the sender has never had). */
  *keepLocalCostcoPicks(pk: string, row: Row): Gen<void> {
    const mine = (yield* this.costcoIds());
    if (!mine.size) return;
    const cur = (yield* qry('SELECT usual_product_id, same_product_ids, alt_product_ids FROM items WHERE id = ?', [pk]))[0];
    if (!cur) return;
    if (typeof cur.usual_product_id === 'string' && mine.has(cur.usual_product_id) && (row.usual_product_id === null || row.usual_product_id === undefined)) row.usual_product_id = cur.usual_product_id;
    for (const col of ['same_product_ids', 'alt_product_ids']) {
      if (!(col in row)) continue; // not sent: what is here stays (items are updated in place)
      const theirs = this.idList(row[col]);
      for (const id of this.idList(cur[col])) if (mine.has(id) && !theirs.includes(id)) theirs.push(id);
      row[col] = JSON.stringify(theirs);
    }
  }

  /** 0.9.3: the household_settings table as it is, for settingChangeOk (counted once, when first asked). */
  private *settingsRoom(): Gen<SettingsRoom> {
    // 0.15.1: the keys are read once, up front (the checks themselves can't wait for the database);
    // each row taken in is added to them, so they stay what the table holds.
    const keys = new Set((yield* qry('SELECT k FROM household_settings')).map((r) => String(r.k)));
    const counts = new Map<string, number>();
    return {
      has: (k) => keys.has(k),
      count: (prefix) => {
        let n = counts.get(prefix);
        if (n === undefined) {
          n = 0;
          for (const k of keys) if (k.startsWith(prefix)) n++;
          counts.set(prefix, n);
        }
        return n;
      },
      added: (k) => {
        if (keys.has(k)) return;
        keys.add(k);
        for (const [p, n] of counts) if (k.startsWith(p)) counts.set(p, n + 1);
      },
    };
  }


  /**
   * 0.9.3: the household's settings rows, applied to the stored settings for the tabs synced here
   * (SharedSettings.apply). Nothing when there are no settings yet. True when they changed.
   */
  *applySharedSettings(): Gen<boolean> {
    const r = (yield* qry("SELECT value FROM kv WHERE key = 'settings'"));
    if (!r.length) return false;
    let s: Record<string, unknown>;
    try {
      const parsed = JSON.parse(String(r[0].value)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      s = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    const rows = (yield* qry('SELECT k, v FROM household_settings ORDER BY k')).map((x) => ({ k: String(x.k), v: String(x.v) }));
    // The web app takes the household's Keg tab as it is (fitSettings confirms 18+ for it).
    if (!rows.length || !applyRows(s, rows, (yield* this.tabs()), { adult: true })) return false;
    (yield* run("INSERT OR REPLACE INTO kv (key, value) VALUES ('settings', ?)", [JSON.stringify(s)]));
    this.customTabs = undefined;
    return true;
  }

  private *columnsOf(tbl: string, cache: Map<string, Set<string>>): Gen<Set<string>> {
    let cols = cache.get(tbl);
    if (!cols) {
      cols = new Set((yield* qry(`PRAGMA table_info(${tbl})`)).map((c) => String(c.name)));
      cache.set(tbl, cols);
    }
    return cols;
  }

  /**
   * 0.9.6 (review H1), SyncEngine.resendCostcoLines: once, list lines an earlier 0.9.6 build kept back
   * because they were at Costco go out again (as "Any shop", stripCostcoLine), with the change that
   * was kept back, so the others catch up with ticks and edits made since.
   */
  *resendCostcoLines(): Gen<void> {
    if ((yield* this.meta('costco_lines')) !== null) return;
    (yield* txn((function* (this: SyncCore) {
      const ids = (yield* qry("SELECT id FROM list_entries WHERE chain = 'costco' OR product LIKE '%\"chain\":\"costco\"%'")).map((r) => String(r.id));
      for (const id of ids)
        (yield* run("UPDATE sync_log SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log) WHERE tbl = 'list_entries' AND pk = ? AND deleted = 0", [id]));
      (yield* this.setMeta('costco_lines', '1'));
    }).call(this)));
  }

  /** SyncEngine.mergeListLine: the tick and the quantity each keep whichever changed last. */
  private *mergeListLine(e: Entry, stamp: number, device: string, created: number, wins: boolean, had: Row, mine: Set<string>, columns: Map<string, Set<string>>): Gen<boolean> {
    const inRow = e.row && typeof e.row === 'object' ? e.row : null;
    if (!inRow) return false;
    const pk = e.pk;
    const curRows = (yield* qry('SELECT * FROM list_entries WHERE id = ?', [pk]));
    if (!curRows.length) return false;
    const cur = curRows[0];
    const tab = (yield* this.tabOf('list_entries', inRow));
    if (tab !== null && !mine.has(tab)) return false;
    const lc = num(cur.checked_at),
      ic = num(inRow.checked_at),
      lq = num(cur.qty_at),
      iq = num(inRow.qty_at);
    let merged: Row;
    let ours: boolean;
    if (wins) {
      merged = { ...inRow };
      keepLocalCostcoLine(cur, merged);
      ours = false;
      if (lc > ic) {
        merged.checked = cur.checked;
        merged.checked_at = lc;
        ours = true;
      }
      if (lq > iq) {
        merged.qty = cur.qty;
        merged.qty_at = lq;
        ours = true;
      }
    } else {
      merged = { ...cur };
      let any = false;
      if (ic > lc) {
        merged.checked = inRow.checked;
        merged.checked_at = ic;
        any = true;
      }
      if (iq > lq) {
        merged.qty = inRow.qty;
        merged.qty_at = iq;
        any = true;
      }
      if (!any) return false;
      ours = true;
    }
    (yield* this.writeRow('list_entries', merged, (yield* this.columnsOf('list_entries', columns))));
    const origin = typeof had.origin === 'string' && had.origin ? had.origin : null;
    if (!ours) (yield* this.logEntry('list_entries', pk, stamp, device, false, null, created, origin));
    else (yield* this.logEntry('list_entries', pk, Math.max(stamp, num(had.stamp)) + 1, (yield* this.device()), false, null, Math.max(created, num(had.created)), origin));
    return true;
  }

  /** SyncEngine.householdChangeAllowed with SyncHousehold.allowed: signatures checked once the owner key is known. */
  *householdChangeAllowed(pk: string, byDevice: string, entry: Entry): Gen<boolean> {
    const pin = (yield* this.meta('owner_pin'));
    const deleted = truthy(entry.deleted);
    const row = entry.row && typeof entry.row === 'object' ? entry.row : null;
    const v = row === null || row.v === null || row.v === undefined ? null : String(row.v);
    if (pin === null) {
      const ok = (yield* this.legacyAllowed(pk, byDevice, entry));
      if (ok && pk === 'owner_pub' && !deleted && v !== null) (yield* this.setMeta('owner_pin', v));
      return ok;
    }
    const sig = entry.sig === null || entry.sig === undefined ? null : String(entry.sig);
    const byOwner = sig !== null && this.verify(pin, this.signedText(entry), sig);
    if (ownerOnly(pk)) {
      if (!byOwner) return false;
      if (pk === 'owner_pub' && !deleted && v !== null) (yield* this.setMeta('owner_pin', v));
      return true;
    }
    if (pk.startsWith('member:')) {
      if (byOwner) return true;
      const cur = (yield* this.householdValue(pk));
      let pub: string | null = null;
      if (cur !== null) {
        try {
          const m = JSON.parse(cur) as { pub?: unknown };
          pub = typeof m.pub === 'string' ? m.pub : null;
        } catch {
          // an odd entry
        }
      }
      if (pub) return sig !== null && this.verify(pub, this.signedText(entry), sig);
      return byDevice === pk.slice('member:'.length);
    }
    return (yield* this.legacyAllowed(pk, byDevice, entry));
  }

  /**
   * Could only the household have written this file? A phone's (not a web's, not a removed phone's)
   * file that carries a household change signed by the owner key this browser pinned, or, before an
   * owner key is known, a household change exactly as this browser already has it. Nobody without
   * the household's data can make either, so a new serverKey that opens such a file is the real one
   * (webkeys/ files are sealed to the web's public key, which anyone can do).
   */
  *vouches(m: SyncFileMessage, name: string): Gen<boolean> {
    const device = typeof m.device === 'string' ? m.device : '';
    // 0.9.3: only a phone's own file (its name says whose it is).
    if (!device || fileDevice(name) !== device || device.startsWith('web-') || (yield* this.householdValue('removed:' + device)) !== null) return false;
    const pin = (yield* this.meta('owner_pin'));
    for (const x of Array.isArray(m.entries) ? m.entries : []) {
      if (!x || typeof x !== 'object' || x.tbl !== 'household' || typeof x.pk !== 'string') continue;
      if (pin !== null) {
        const sig = x.sig === null || x.sig === undefined ? null : String(x.sig);
        if (sig !== null && this.verify(pin, this.signedText(x), sig)) return true;
        continue;
      }
      const had = (yield* qry("SELECT stamp, device FROM sync_log WHERE tbl = 'household' AND pk = ?", [x.pk]));
      if (had.length && num(had[0].stamp) === Math.trunc(Number(x.stamp)) && String(had[0].device ?? '') === String(x.device ?? '')) return true;
    }
    return false;
  }

  *legacyAllowed(pk: string, byDevice: string, entry: Entry): Gen<boolean> {
    const owner = (yield* this.householdValue('owner'));
    if (owner === null || owner === byDevice || pk === 'member:' + byDevice) return true;
    if ((yield* this.householdValue('handover:' + byDevice)) === null) return false;
    if (pk === 'handover:' + byDevice) return true;
    if (pk !== 'owner' || truthy(entry.deleted)) return false;
    const row = entry.row && typeof entry.row === 'object' ? entry.row : null;
    return row !== null && byDevice === String(row.v ?? '');
  }

  private *writeRow(tbl: string, row: Row, cols: Set<string>): Gen<void> {
    const names: string[] = [];
    const values: unknown[] = [];
    for (const c of Object.keys(row)) {
      if (!cols.has(c) || (tbl === 'prices' && c === 'id')) continue;
      names.push(c);
      values.push(sqlValue(row[c]));
    }
    if (!names.length) return;
    const q = names.map(() => '?').join(', ');
    const list = names.join(', ');
    if (tbl === 'prices') {
      (yield* run(`INSERT INTO prices (${list}) SELECT ${q} WHERE NOT EXISTS (SELECT 1 FROM prices WHERE product_id = ? AND date = ?)`, [
        ...values,
        String(row.product_id ?? ''),
        String(row.date ?? ''),
      ]));
    } else if (tbl === 'products') {
      const sets: string[] = [];
      const vals: unknown[] = [];
      names.forEach((n, i) => {
        if (LOCAL_PRODUCT_COLUMNS.has(n) || n === 'id') return;
        sets.push(`${n} = ?`);
        vals.push(values[i]);
      });
      const id = String(row.id ?? '');
      if ((yield* qry('SELECT 1 FROM products WHERE id = ?', [id])).length) {
        if (sets.length) (yield* run(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]));
      } else {
        const n2: string[] = [];
        const v2: unknown[] = [];
        names.forEach((n, i) => {
          if (LOCAL_PRODUCT_COLUMNS.has(n)) return;
          n2.push(n);
          v2.push(values[i]);
        });
        (yield* run(`INSERT INTO products (${n2.join(', ')}) VALUES (${n2.map(() => '?').join(', ')})`, v2));
      }
    } else if (tbl === 'items' && (yield* qry('SELECT 1 FROM items WHERE id = ?', [String(row.id ?? '')])).length) {
      const sets: string[] = [];
      const vals: unknown[] = [];
      names.forEach((n, i) => {
        if (n === 'id') return;
        sets.push(`${n} = ?`);
        vals.push(values[i]);
      });
      if (!sets.length) return;
      (yield* run(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`, [...vals, String(row.id ?? '')]));
    } else {
      (yield* run(`INSERT OR REPLACE INTO ${tbl} (${list}) VALUES (${q})`, values));
    }
  }

  /** SyncEngine.tidyCategories: one of each name per tab (the smaller id), as ordinary changes. */
  *tidyCategories(): Gen<number> {
    let merged = 0;
    (yield* txn((function* (this: SyncCore) {
      const rows = (yield* qry('SELECT id, name, section FROM categories ORDER BY section, lower(trim(name)), id'));
      let lastKey: string | null = null;
      let keep: string | null = null;
      for (const r of rows) {
        // Java's toLowerCase(Locale.ROOT) and trim(); SQLite's lower() only does ASCII, as before.
        const k = `${String(r.section ?? '')}|${javaTrim(String(r.name ?? '')).toLowerCase()}`;
        if (k !== lastKey) {
          lastKey = k;
          keep = String(r.id);
          continue;
        }
        const gone = String(r.id);
        (yield* run('UPDATE items SET category_id = ? WHERE category_id = ?', [keep, gone]));
        (yield* run('UPDATE list_entries SET category_id = ? WHERE category_id = ?', [keep, gone]));
        (yield* run('DELETE FROM categories WHERE id = ?', [gone]));
        merged++;
      }
    }).call(this)));
    return merged;
  }

  // ---------- the folder (SyncFolder) ----------

  /**
   * Takes in one device's file (SyncFolder.readOthers, for one file already opened). `sum` is
   * the file's hash, so the same file isn't taken in twice. Returns the number of changes, or -1
   * when the file was passed over (this browser's own, a removed phone, or one that names another
   * device inside than its name says).
   */
  *takeFile(name: string, sum: string, m: SyncFileMessage, at: string): Gen<number> {
    const me = (yield* this.device());
    const seenKey = 'folder_seen:' + name;
    // 0.9.3: who wrote it is the file's name (the server lets each device write only its own), as on
    // a phone: a file that names another device inside is passed over, so nobody can pose as a phone
    // (or another browser) by what they put in their file.
    const device = fileDevice(name) ?? '';
    if (!device || m.device !== device || device === me || (yield* this.householdValue('removed:' + device)) !== null) {
      (yield* this.setMeta(seenKey, sum));
      return -1;
    }
    // 0.9.5 (review): read again unchanged by catchUpLists: only General lines never had here.
    const catchKey = 'catchup:' + seenKey;
    if ((yield* this.meta(catchKey)) !== null) {
      const unchanged = (yield* this.meta(catchKey)) === sum;
      (yield* this.setMeta(catchKey, null));
      if (unchanged) {
        let n = 0;
        let few = (yield* this.catchUpEntries(m.entries));
        if (this.role === 'server' && few.length) few = (yield* this.serverFilter(few, device, device.startsWith('web-') ? null : parseShares(m.shares)));
        this.applyingFrom = this.role === 'server' ? device : null;
        try {
          n = few.length ? (yield* this.apply(few)) : 0;
        } finally {
          this.applyingFrom = null;
        }
        this.lastDropped = 0;
        (yield* this.setMeta(seenKey, sum));
        return n;
      }
    }
    // Another browser's file can't change the household, loyalty cards or prices (as on a phone).
    let entries = device.startsWith('web-') && Array.isArray(m.entries) ? m.entries.filter((x) => !x || typeof x !== 'object' || !NOT_FROM_A_BROWSER.has(String(x.tbl))) : m.entries;
    // 0.9.4, the server: only what that phone shares (D9), and nothing older than Keep data for (D14).
    if (this.role === 'server' && Array.isArray(entries)) {
      const shares = device.startsWith('web-') ? null : parseShares(m.shares);
      if (shares) (yield* this.setMeta('phone_shares:' + device, JSON.stringify(shares)));
      const before = entries.length;
      entries = (yield* this.serverFilter(entries, device, shares));
      this.lastDropped = before - entries.length;
    }
    let n: number;
    this.applyingFrom = this.role === 'server' ? device : null;
    try {
      n = (yield* this.apply(entries));
    } finally {
      this.applyingFrom = null;
    }
    if (n > 0) (yield* this.tidyCategories());
    (yield* this.notePeer(device, typeof m.name === 'string' ? m.name : null));
    // 0.9.3: a phone's own settings, for Settings → Phones (only phones on a server send one), from
    // that phone's own file (checked above), so another browser can't put words in a phone's mouth.
    const summary = device.startsWith('web-') ? null : cleanSummary((m as { summary?: unknown }).summary);
    const sentAt = typeof m.at === 'string' && m.at.length <= 40 && !Number.isNaN(Date.parse(m.at)) ? m.at : null;
    if (summary) (yield* this.setMeta('phone_summary:' + device, JSON.stringify({ name: typeof m.name === 'string' ? m.name.slice(0, 80) : null, at: sentAt, summary })));
    const theirTop = Math.trunc(num(m.top));
    if (theirTop > 0) {
      const gotKey = 'folder_got:' + device;
      const had = (yield* this.meta(gotKey));
      if (had === null || Number(had) < theirTop) (yield* this.setMeta(gotKey, String(theirTop)));
    }
    if (m.seen && typeof m.seen === 'object') (yield* this.setSeen(device, Math.trunc(num(m.seen[me]))));
    (yield* this.markSynced(device, at));
    (yield* this.setMeta(seenKey, sum));
    return n;
  }

  /** 0.9.4, the server: how many entries the last takeFile passed over (outside shares, or too old), for its log. */
  lastDropped = 0;

  /**
   * 0.9.4, the server: a phone's entries, less what it doesn't share (`shares`; none: everything,
   * as a 0.9.3 phone or the web sends only what it shares) and what's older than Keep data for.
   * - A record of a tab, receipts or cards it doesn't share: passed over, and so is a "moved"
   *   delete of one (it only says the phone stopped sharing it, D11).
   * - A plain delete of one is taken only when this phone made that record (its `origin` here):
   *   "Also take what this phone shared off the server" takes back what it added, never what other
   *   people added, even ones it changed last; a record whose maker isn't known stays.
   * - Prices dated before the cut-off, unless the product has no price here as new (the latest stays,
   *   as pruneHistory keeps it), and receipts scanned before it, unless pinned.
   */
  *serverFilter(entries: Entry[], device: string, shares: Shares | null): Gen<Entry[]> {
    const cut = this.opts.keepFrom?.() ?? null;
    const tabs = shares ? new Set(shares.tabs) : null;
    const out: Entry[] = [];
    // Each product's newest price in this file (an old one is the latest only if nothing newer comes).
    const newest = new Map<string, string>();
    if (cut !== null)
      for (const x of entries) {
        if (!x || typeof x !== 'object' || x.tbl !== 'prices' || truthy(x.deleted) || !x.row || typeof x.row !== 'object') continue;
        const pid = str(x.row, 'product_id');
        const date = str(x.row, 'date');
        if (pid !== null && date !== null && date > (newest.get(pid) ?? '')) newest.set(pid, date);
      }
    for (const x of entries) {
      if (!x || typeof x !== 'object' || typeof x.tbl !== 'string' || typeof x.pk !== 'string') {
        out.push(x);
        continue;
      }
      const tbl = x.tbl;
      const key = keyOf(tbl);
      const deleted = truthy(x.deleted);
      const row = x.row && typeof x.row === 'object' ? x.row : null;
      if (shares && tabs && key && tbl !== 'household') {
        const flag = tbl === 'receipts' ? shares.receipts : tbl === 'cards' ? shares.cards : true;
        let tab: string | null;
        let cur: Row | null = null;
        if (!deleted) tab = (yield* this.tabOf(tbl, row));
        else {
          const r = (yield* qry(`SELECT * FROM ${tbl} WHERE ${key} = ?`, [x.pk]));
          cur = r.length ? r[0] : null;
          tab = cur ? (yield* this.tabOf(tbl, cur)) : null;
        }
        const ok = flag && (tab === null || tabs.has(tab));
        if (!ok) {
          if (!deleted || truthy(x.moved)) continue;
          const log = (yield* qry('SELECT origin FROM sync_log WHERE tbl = ? AND pk = ?', [tbl, x.pk]));
          if (!log.length || typeof log[0].origin !== 'string' || log[0].origin !== device) continue;
        }
      }
      if (cut !== null && !deleted && row) {
        if (tbl === 'prices') {
          const date = str(row, 'date');
          const pid = str(row, 'product_id');
          if (date !== null && date < cut) {
            if (pid !== null && (newest.get(pid) ?? '') > date) continue;
            if ((yield* qry('SELECT 1 FROM prices WHERE product_id = ? AND date >= ? LIMIT 1', [pid, date])).length) continue;
          }
        } else if (tbl === 'receipts') {
          const at = str(row, 'scanned_at');
          if (at !== null && at < cut && num(row.pinned) === 0) continue;
        }
      }
      out.push(x);
    }
    return out;
  }

  // ---------- 0.9.4: the server, as the household's owner ----------

  /**
   * The server changes the household (`v` null: deletes the row). Written through the triggers like
   * any change here (stamped, noted as this device's), then signed with the owner key: the signature
   * covers the stamp the change was noted with (SyncHousehold.signed), as a phone's collect signs.
   * Returns the entry as it goes out in the server's file.
   */
  *writeHousehold(k: string, v: string | null): Gen<Entry | null> {
    // 0.13.2: and a phone that is its household's owner (an iCloud household's first device: ios/folderHouse.ts).
    if ((this.role !== 'server' && this.role !== 'phone') || !this.opts.sign) throw new Error('Only the household\'s owner signs household changes.');
    const sign = this.opts.sign;
    let out: Entry | null = null;
    (yield* txn((function* (this: SyncCore) {
      if ((yield* this.meta('applying')) !== null) throw new Error('writeHousehold while taking changes in');
      const had = (yield* this.householdValue(k));
      if (v === null) {
        if (had === null) return;
        (yield* run('DELETE FROM household WHERE k = ?', [k]));
      } else {
        if (had === v) return;
        (yield* run('INSERT OR REPLACE INTO household (k, v) VALUES (?, ?)', [k, v]));
      }
      const log = (yield* qry("SELECT stamp, created FROM sync_log WHERE tbl = 'household' AND pk = ?", [k]));
      if (!log.length) throw new Error('the change was not noted');
      const stamp = num(log[0].stamp);
      const e: Entry = { tbl: 'household', pk: k, stamp, device: (yield* this.device()), deleted: v === null, created: num(log[0].created), ...(v === null ? {} : { row: { k, v } }) };
      // 0.15.1: with this device's owner key, when it keeps one (an iCloud household's first device).
      e.sig = sign(this.signedText(e), yield* this.meta('owner_priv'));
      (yield* run("UPDATE sync_log SET sig = ? WHERE tbl = 'household' AND pk = ?", [e.sig, k]));
      out = e;
    }).call(this)));
    return out;
  }

  /**
   * 0.13.2 (SharedSettings.seed): the household's settings rows made from this device's own settings,
   * where the household has none yet. Only the household's owner phone does it, or the first phone of
   * a new house (sync_meta seed_settings). Stamped 1, so any row another phone already wrote wins.
   */
  *seedSettings(): Gen<number> {
    const owner = (yield* this.householdValue('owner'));
    if (!((owner !== null && owner === (yield* this.device())) || (yield* this.meta('seed_settings')) === '1')) return 0;
    let s: Record<string, unknown> | null = null;
    try {
      const r = (yield* qry("SELECT value FROM kv WHERE key = 'settings'"));
      const v: unknown = r.length ? JSON.parse(String(r[0].value)) : null;
      s = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      s = null;
    }
    if (!s) return 0;
    const have = new Set<string>();
    for (const r of (yield* qry('SELECT k FROM household_settings'))) have.add(String(r.k));
    // Rows already noted (another phone's, or a delete) count as there too.
    for (const r of (yield* qry("SELECT pk FROM sync_log WHERE tbl = 'household_settings'"))) have.add(String(r.pk));
    const add: [string, string][] = [];
    for (const k of keysFor(s, (yield* this.tabs()))) {
      if (have.has(k)) continue;
      const v = settingValueOf(s, k);
      if (v === undefined || v === null || checkValue(k, v) === undefined) continue;
      add.push([k, JSON.stringify(v)]);
    }
    if (!add.length) return 0;
    const me = (yield* this.device());
    (yield* txn((function* (this: SyncCore) {
      (yield* run("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')"));
      for (const [k, v] of add) {
        (yield* run('INSERT OR IGNORE INTO household_settings (k, v) VALUES (?, ?)', [k, v]));
        (yield* this.logEntry('household_settings', k, 1, me, false, null, 1, null));
      }
      (yield* run("DELETE FROM sync_meta WHERE key = 'applying'"));
    }).call(this)));
    return add.length;
  }

  /** 0.9.4: the household's `server` row, checked (null without one). */
  *serverRow(): Gen<ServerRow | null> {
    return parseServerRow((yield* this.householdValue('server')));
  }

  /** 0.9.4: what a phone last said it shares (from its file on a v3 server), or null. */
  *sharesOf(device: string): Gen<Shares | null> {
    const v = (yield* this.meta('phone_shares:' + device));
    if (v === null) return null;
    try {
      return parseShares(JSON.parse(v));
    } catch {
      return null;
    }
  }

  /**
   * 0.9.4, the server's "Keep data for" (D14): prices dated before `cutoff` (each product's latest
   * stays), and receipts scanned before it (not pinned), with their change notes, without telling
   * anyone (no deletes go out: each phone keeps its own window). Returns what went, so the server can
   * move the receipts' photos to the trash.
   */
  *prune(cutoff: string): Gen<{ prices: number; receipts: { id: string; photo: string | null; pages: string | null }[] }> {
    const out = { prices: 0, receipts: [] as { id: string; photo: string | null; pages: string | null }[] };
    (yield* txn((function* (this: SyncCore) {
      (yield* run("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')"));
      const where = `date < ? AND source <> 'demo' AND date < (SELECT MAX(q.date) FROM prices q WHERE q.product_id = prices.product_id)`;
      out.prices = num((yield* qry(`SELECT COUNT(*) AS n FROM prices WHERE ${where}`, [cutoff]))[0].n);
      if (out.prices) (yield* run(`DELETE FROM prices WHERE ${where}`, [cutoff]));
      for (const r of (yield* qry("SELECT id, photo, pages FROM receipts WHERE scanned_at < ? AND pinned = 0 AND id NOT LIKE 'demo-%'", [cutoff]))) {
        out.receipts.push({ id: String(r.id), photo: str(r, 'photo'), pages: str(r, 'pages') });
      }
      for (const r of out.receipts) {
        (yield* run('DELETE FROM receipts WHERE id = ?', [r.id]));
        (yield* run("DELETE FROM sync_log WHERE tbl = 'receipts' AND pk = ?", [r.id]));
      }
      (yield* run("DELETE FROM sync_meta WHERE key = 'applying'"));
    }).call(this)));
    return out;
  }

  /**
   * 0.9.4, the server (SyncEngine.compact): deletes older than 90 days that every member phone has
   * seen (household member: rows, which only active phones have; this device left out), never the
   * household's own. Returns how many went.
   */
  *compact(now: number = this.now()): Gen<number> {
    const me = (yield* this.device());
    const top = num((yield* qry('SELECT COALESCE(MAX(seq), 0) AS top FROM sync_log'))[0].top);
    let upTo = top;
    for (const m of (yield* qry("SELECT k FROM household WHERE k LIKE 'member:%'"))) {
      const d = String(m.k).slice('member:'.length);
      if (d === me) continue;
      const r = (yield* qry('SELECT seen FROM sync_peers WHERE device = ?', [d]));
      upTo = Math.min(upTo, r.length ? num(r[0].seen) : 0);
    }
    if (upTo <= 0) return 0;
    const skip = ["'_seq'", "'household'"];
    if (!(yield* this.shareCards())) skip.push("'cards'");
    if (!(yield* this.shareReceipts())) skip.push("'receipts'");
    const where = `deleted = 1 AND tbl NOT IN (${skip.join(', ')}) AND stamp < ? AND seq <= ?`;
    const before = now - COMPACT_AFTER_MS;
    let gone = 0;
    (yield* txn((function* (this: SyncCore) {
      gone = num((yield* qry(`SELECT COUNT(*) AS n FROM sync_log WHERE ${where}`, [before, upTo]))[0].n);
      if (!gone) return;
      (yield* run("INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq) VALUES ('_seq', 'floor', 0, '', 1, ?)", [top]));
      (yield* run(`DELETE FROM sync_log WHERE ${where}`, [before, upTo]));
    }).call(this)));
    return gone;
  }

  /** Whether a file needs reading again (SyncFolder: same version or same contents as last time: no). */
  *fresh(name: string, version: string | null): Gen<boolean> {
    return version === null || version !== (yield* this.meta('folder_ver:' + name));
  }

  *noteVersion(name: string, version: string | null): Gen<void> {
    if (version !== null) (yield* this.setMeta('folder_ver:' + name, version));
  }

  *seenSum(name: string): Gen<string | null> {
    return (yield* this.meta('folder_seen:' + name));
  }

  /**
   * This browser's own file, when something changed since it was last written (SyncFolder.writeOwn),
   * or null. `keyv` is the key version it will be sealed with.
   */
  *ownFile(keyv: number, at: string, present: boolean): Gen<{ msg: SyncFileMessage; mark: string } | null> {
    const top = num((yield* qry('SELECT COALESCE(MAX(seq), 0) AS top FROM sync_log'))[0].top);
    const mark = `${top}/${keyv}/${[...(yield* this.tabs())].join(',')}/${(yield* this.shareCards())}/${(yield* this.shareReceipts())}`;
    if (mark === (yield* this.meta('folder_top')) && present) return null;
    const oldest = this.now() - OLD_DELETE_MS;
    const server = this.role === 'server';
    const phone = this.role === 'phone';
    // A phone leaves nothing out by name: collect() already drops its cards and receipts unless it shares them.
    const leaves = server ? SERVER_LEAVES_OUT : phone ? [] : WEB_LEAVES_OUT;
    let where = leaves.length ? ` AND tbl NOT IN (${leaves.map((t) => `'${t}'`).join(', ')})` : '';
    // 0.9.4: the server's file carries recent prices, as a phone's file on a server does.
    if (server || (phone && this.opts.prices !== false)) where += ` AND (tbl <> 'prices' OR stamp > ${Math.trunc(this.now() - SERVER_PRICES_MS)})`;
    // A phone's file in a picked folder (iCloud Drive) carries no prices, to stay small (SyncFolder.writeOwn).
    else if (phone) where += ` AND tbl <> 'prices'`;
    const c = (yield* this.collect(0, null, 5_000_000, null, where, true, oldest));
    let fileTop = top;
    const left = (yield* qry("SELECT MIN(seq) AS s FROM sync_log WHERE deleted = 1 AND tbl <> '_seq' AND stamp < ?", [oldest]));
    if (left.length && left[0].s !== null && left[0].s !== undefined) fileTop = Math.min(fileTop, num(left[0].s) - 1);
    const seen: Record<string, number> = {};
    for (const r of (yield* qry("SELECT key, value FROM sync_meta WHERE key LIKE 'folder_got:%'"))) {
      const v = Number(r.value);
      if (Number.isFinite(v) && /^-?\d+$/.test(String(r.value))) seen[String(r.key).slice('folder_got:'.length)] = v;
    }
    const msg: SyncFileMessage = {
      top: fileTop,
      seen,
      format: 'restock-sync',
      v: 1,
      device: (yield* this.device()),
      name: (yield* this.meta('name')) ?? (server ? 'Server' : phone ? 'iPhone' : 'Web'),
      keyv,
      at,
      entries: c.entries,
    };
    return { msg, mark };
  }

  /**
   * 0.9.5 (review): how many of this browser's own changes no file it wrote has carried yet (made
   * since ownFile's last mark): what Sign out would lose (the PWA, offline).
   */
  *unsent(): Gen<number> {
    const sent = Number(String((yield* this.meta('folder_top')) ?? '0').split('/')[0]) || 0;
    return num((yield* qry("SELECT COUNT(*) AS n FROM sync_log WHERE seq > ? AND device = ? AND tbl NOT IN ('_seq', 'prices', 'household', 'cards')", [sent, (yield* this.device())]))[0]?.n);
  }

  /** After the own file was written (the mark ownFile gave, so edits made meanwhile still go next time). */
  *wroteOwn(mark: string): Gen<void> {
    (yield* this.setMeta('folder_top', mark));
  }

  /**
   * archive/<device>/<month>.bin: prices (only added, once per product and time) and receipts a
   * phone moved off itself. Not noted as changes here: they belong to the phone that kept them.
   */
  *takeArchive(m: { prices?: Row[]; receipts?: Row[] }): Gen<number> {
    let n = 0;
    const columns = new Map<string, Set<string>>();
    // 0.9.4, the server: nothing older than Keep data for (each product's latest price aside).
    const cut = this.role === 'server' ? (this.opts.keepFrom?.() ?? null) : null;
    const newest = new Map<string, string>();
    if (cut !== null)
      for (const p of Array.isArray(m.prices) ? m.prices : [])
        if (p && typeof p === 'object' && typeof p.product_id === 'string' && typeof p.date === 'string' && p.date > (newest.get(p.product_id) ?? '')) newest.set(p.product_id, p.date);
    (yield* txn((function* (this: SyncCore) {
      (yield* run("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')"));
      for (const p of Array.isArray(m.prices) ? m.prices : []) {
        if (!p || typeof p !== 'object' || typeof p.product_id !== 'string' || typeof p.date !== 'string') continue;
        const before = (yield* qry('SELECT 1 FROM prices WHERE product_id = ? AND date = ?', [p.product_id, p.date])).length;
        if (before) continue;
        if (cut !== null && p.date < cut && ((newest.get(p.product_id) ?? '') > p.date || (yield* qry('SELECT 1 FROM prices WHERE product_id = ? AND date >= ? LIMIT 1', [p.product_id, p.date])).length)) continue;
        (yield* this.writeRow('prices', p, (yield* this.columnsOf('prices', columns))));
        n++;
      }
      for (const r of Array.isArray(m.receipts) ? m.receipts : []) {
        if (!r || typeof r !== 'object' || typeof r.id !== 'string' || r.id.startsWith('demo-')) continue;
        if ((yield* qry('SELECT 1 FROM receipts WHERE id = ?', [r.id])).length) continue;
        if (cut !== null && typeof r.scanned_at === 'string' && r.scanned_at < cut && num(r.pinned) === 0) continue;
        // A receipt deleted on a phone since stays deleted.
        const log = (yield* qry("SELECT deleted FROM sync_log WHERE tbl = 'receipts' AND pk = ?", [r.id]));
        if (log.length && num(log[0].deleted) !== 0) continue;
        (yield* this.writeRow('receipts', r, (yield* this.columnsOf('receipts', columns))));
        n++;
      }
      (yield* run("DELETE FROM sync_meta WHERE key = 'applying'"));
    }).call(this)));
    return n;
  }
}

/** The engine on a database that answers straight away (the server, the web): every method answers at once. */
export interface WebSyncEngine extends Straight<SyncCore> {
  readonly db: SyncDb;
  /** The engine's own steps, for running inside another one. */
  readonly core: SyncCore;
}
type EngineArgs<D> = [db: D, verify: SigCheck, signedText: (e: Entry) => string, now?: () => number, opts?: EngineOptions];
// A function called with `new` that answers an object gives that object: the facade over the engine.
export const WebSyncEngine = function (...[db, verify, signedText, now = () => Date.now(), opts = {}]: EngineArgs<SyncDb>) {
  const core = new SyncCore(verify, signedText, now, opts);
  return facade(core, (g) => runOn(db, g), { db, core });
} as unknown as new (...a: EngineArgs<SyncDb>) => WebSyncEngine;

/**
 * 0.15.1: the engine on a database that answers later (the iPhone and iPad app's own SQLite). Each
 * thing it does holds the database; `db.transaction` (and `hold`) holds it for several, all or nothing.
 * While something holds it, the engine's calls go straight through (they're part of it); the app's own
 * reads and writes wait.
 */
export interface AsyncSyncEngine extends Later<SyncCore> {
  readonly db: AsyncSyncDb;
  readonly core: SyncCore;
  /** Several things as one: nothing else writes meanwhile, and if one fails none of them stays. */
  hold<T>(fn: () => Promise<T>): Promise<T>;
}
export const AsyncSyncEngine = function (...[db, verify, signedText, now = () => Date.now(), opts = {}]: EngineArgs<AsyncSyncDb>) {
  {
    const core = new SyncCore(verify, signedText, now, opts);
    let holding = 0;
    const alone = <T>(fn: () => Promise<T>): Promise<T> => (holding || !db.exclusive ? fn() : db.exclusive(fn));
    const hold = <T>(fn: () => Promise<T>): Promise<T> =>
      alone(async () => {
        holding++;
        try {
          let out: T | undefined;
          await db.transaction(async () => {
            out = await fn();
          });
          return out as T;
        } finally {
          holding--;
        }
      });
    const own: AsyncSyncDb = {
      query: (sql, args) => alone(() => db.query(sql, args)),
      exec: (sql, args) => alone(() => db.exec(sql, args)),
      transaction: (body) => hold(body),
    };
    return facade(core, (g) => alone(() => runOnAsync(db, g)), { db: own, core, hold });
  }
} as unknown as new (...a: EngineArgs<AsyncSyncDb>) => AsyncSyncEngine;

/** SyncHousehold.ownerOnly. */
export function ownerOnly(pk: string): boolean {
  return (
    pk === 'name' ||
    pk === 'owner' ||
    pk === 'tabs' ||
    pk === 'owner_pub' ||
    pk === 'recovery' ||
    pk === 'hid' ||
    pk === 'receipts' ||
    // 0.9.4: where the household's server is (protocol v3).
    pk === 'server' ||
    pk.startsWith('removed:') ||
    pk.startsWith('handover:')
  );
}

/** A loyalty card as the web keeps it: its shop and name, never its number. */
export function stripCard(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'number' || /barcode|code|number|pin/i.test(k)) continue;
    out[k] = v;
  }
  out.number = '';
  return out;
}

function sqlValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** Java's String.trim(): strips characters up to U+0020 only. */
function javaTrim(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) <= 0x20) a++;
  while (b > a && s.charCodeAt(b - 1) <= 0x20) b--;
  return s.slice(a, b);
}

/** Is this a phone's (or another browser's) changes file? */
export function isSyncFile(name: string): boolean {
  return name.startsWith(PREFIX) && name.endsWith(SUFFIX) && !name.startsWith('restock-sync-keys');
}

/**
 * 0.9.3: whose changes file this is, by its name ("restock-sync-<device>.bin", a browser's
 * "restock-sync-web-<webId>.bin"), or null when it isn't one (SyncFolder.fileFor, the other way).
 */
export function fileDevice(name: string): string | null {
  if (!isSyncFile(name)) return null;
  const d = name.slice(PREFIX.length, name.length - SUFFIX.length);
  return /^[A-Za-z0-9_-]{1,80}$/.test(d) ? d : null;
}

/**
 * 0.9.4: the file names a v3 server allows (docs/server-protocol.md "v3"): v2's, less the owner
 * phone's keys file and webkeys/, plus keys/<device>.bin (written by the server only).
 */
export function allowedNameV3(name: string): boolean {
  return (
    /^restock-sync-[A-Za-z0-9_-]{1,80}\.bin$/.test(name) ||
    /^archive\/[A-Za-z0-9_-]{1,80}\/\d{4}-(0[1-9]|1[0-2])\.bin$/.test(name) ||
    /^photos\/[0-9a-f]{64}\.bin$/.test(name) ||
    /^keys\/[A-Za-z0-9_-]{1,80}\.bin$/.test(name)
  );
}

/** 0.9.4: the server's own file, restock-sync-srv-<sid>.bin. */
export const serverFileName = (sid: string) => `${PREFIX}srv-${sid}${SUFFIX}`;

/** The file names the server allows (docs/server-protocol.md "Files"). */
export function allowedName(name: string): boolean {
  return (
    /^restock-sync-[A-Za-z0-9_-]{1,80}\.bin$/.test(name) ||
    /^restock-sync-keys-[A-Za-z0-9_-]{1,80}\.json$/.test(name) ||
    /^archive\/[A-Za-z0-9_-]{1,80}\/\d{4}-(0[1-9]|1[0-2])\.bin$/.test(name) ||
    /^photos\/[0-9a-f]{64}\.bin$/.test(name) ||
    /^webkeys\/[A-Za-z0-9_-]{1,80}\.bin$/.test(name)
  );
}

export const webFileName = (webId: string) => `${PREFIX}web-${webId}${SUFFIX}`;
