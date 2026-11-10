import { Capacitor } from '@capacitor/core';
import { allGroups, allListEntries, deleteListEntries, getKV, getSettings, insertEntryOp, nowIso, putKV, queryRows, runOps, uid, updateListEntry } from './db';
import { activeSections } from '../shops';
import { changed, onChange } from './live';
import { emptyState, HaError, haLineId, haLists, onHaList, restApi, syncRound, type HaState, type Line, type Store, type Transport } from './haSync';
import { RestockNative } from './sql/native';
import { HA_CONFIG, HA_STATE, HA_STATUS, haPairingResets, LIST_ALIASES, LOCAL_ONLY_KV, onHaPairingReset, resetHaPairing } from './haKeys';
import {
  claimHaPhone,
  FROM_HA,
  getAliases,
  haPhone,
  keepAsWords,
  linesToPick,
  migrateAliases,
  pickItemFor,
  pickWord,
  releaseHaPhone,
  tidyKeeps,
  type HaHouse,
  type HaPhone,
} from './listPicks';
import type { ListEntry } from '../types';
import { background } from './undo';

// 0.9.3: Settings → Home Assistant. The shopping list both ways with a Home Assistant to-do list,
// straight from this phone (no Restock server). One phone per household does it (the household's
// ha:phone row names it, listPicks.ts); the others get the changes through the household's own sync,
// so nothing is added twice. Turning it on on another phone asks to move it there; the phone it
// moved from stops by itself (it keeps its token, so it can take over again).
//
// Where things are kept, and why:
// - The token: in Android, sealed with a key from Android's key store (HomeAssistant.java). It's
//   never in Restock's database, so it can't be in a backup, in household sync or in the settings a
//   joining phone takes, and it never comes back to this side once saved: Java adds it to each request.
// - The address, the list and on/off (HA_CONFIG), and which line is which item (HA_STATE): in the
//   database's key/value table under their own keys, not in Settings (whose copy goes to a joining
//   phone). Backups leave them out (backup.ts), and a restore keeps this phone's (db.ts).
// - "Always use this for milk", "Keep it as just milk" and which phone it is: the household's, in its
//   synced rows (listPicks.ts), so "Pick my milk" works on every phone and on the web. The aliases
//   go in backups too (backup.ts, as LIST_ALIASES).
//
// When it runs: while Restock is open: when it opens or comes back, every minute, and a few seconds
// after the list changes (here, or from another phone). 0.9.4: also in the background job, about
// every 15 minutes (SyncWorker), so a voice add reaches the list with Restock closed. Every round on
// the phone runs in Java (HaSync.java, the port of haSync.ts, one at a time with the background
// job's): this side asks for one with RestockNative.haRound. haSync.ts stays the reference (and is
// what the server runs); its round here (tsRound) is only for an Android side without haRound.
//
// 0.9.4, in a house (the household's owner is a Restock server): Home Assistant runs only on the
// server (design D12). This phone never claims it or runs its own; its screen says the server
// handles it (or to set it up on the server's page). The token goes to the server only sealed in
// the handover or upgrade payload (HomeAssistant.java), and is deleted here once the server runs it.

export { HA_CONFIG, HA_STATE, HA_STATUS, LIST_ALIASES, LOCAL_ONLY_KV };
export { claimHaPhone, getAliases, haPhone, keepAsWords, linesToPick, pickItemFor, pickWord, type HaHouse, type HaPhone };

/** 0.9.4: what a Java round answers (HaSync.Outcome). */
export interface HaRound {
  /** A round ran (Home Assistant on for this phone, and it's the one). */
  ran: boolean;
  /** The pairing was started afresh mid-round: another round in a moment. */
  restarted?: boolean;
  /** Another round was going for longer than the screens wait. */
  busy?: boolean;
  /** This phone is in a house: it doesn't run its own. */
  house?: boolean;
  came: number;
  went: number;
  held?: boolean;
  status: HaStatus;
}

/** The Home Assistant calls of RestockNative that are new in 0.9.4 (HomeAssistant.java, HaSync.java). */
interface HaNative {
  haRound(opts: { manual?: boolean }): Promise<HaRound>;
  haResetPairing(): Promise<void>;
}
const haNative = () => RestockNative as unknown as HaNative;

export const DEFAULT_LIST = 'todo.shopping_list';

export interface HaConfig {
  enabled: boolean;
  /** "http://homeassistant.local:8123", tidied (tidyAddress). */
  address: string;
  /** The to-do entity ("todo.shopping_list"). */
  entity: string;
}

export interface HaStatus {
  /** The last round that worked. */
  okAt?: string;
  /** The last round's problem, in words; cleared when one works. */
  error?: string;
  /** The token was turned down: Restock stops trying by itself until it's changed or Try again is tapped. */
  auth?: boolean;
  /**
   * Home Assistant's list came back empty while Restock had lines paired with it (Home Assistant
   * starting up, say): nothing was changed, and it's looked at again in a minute (haSync.ts).
   */
  held?: boolean;
}

export const haAvailable = () => Capacitor.isNativePlatform();

/** 0.9.4: this phone is in a house (its household's owner is a Restock server). */
async function inHouse(): Promise<boolean> {
  const [o] = await queryRows<{ v: string }>("SELECT v FROM household WHERE k = 'owner'").catch(() => []);
  return !!o?.v?.startsWith('srv-');
}

/**
 * This phone's settings. 0.9.4: in a house it's never on here (the server does it, or nobody does),
 * whatever was saved: what was saved stays as it was until the server runs Home Assistant, so the
 * upgrade can still hand it over (HomeAssistant.java handoverPayload, through ServerSync.haSource).
 */
export async function getHaConfig(): Promise<HaConfig> {
  const c = (await getKV<Partial<HaConfig>>(HA_CONFIG)) ?? {};
  return {
    enabled: c.enabled === true && !(await inHouse()),
    address: typeof c.address === 'string' ? c.address : '',
    entity: typeof c.entity === 'string' && /^todo\.[a-z0-9_]+$/.test(c.entity) ? c.entity : DEFAULT_LIST,
  };
}

/**
 * Saves a change. A new address or list starts the pairing afresh: the next round pairs lines by
 * their words, so nothing on either list is removed or added twice. Turning it off and on again
 * keeps the pairing, so what was taken off one list while it was off comes off the other too.
 */
export async function saveHaConfig(patch: Partial<HaConfig>): Promise<HaConfig> {
  const was = await getHaConfig();
  const next = { ...was, ...patch };
  const fresh = next.address !== was.address || next.entity !== was.entity;
  // A round already under way (for the old list) doesn't save its pairing over the fresh one.
  if (fresh) resetHaPairing();
  // 0.9.4: both at once, so a round in Java (the background job's) never reads the new list with the old pairing.
  await runOps([
    { sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', params: [HA_CONFIG, JSON.stringify(next)] },
    ...(fresh ? [{ sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', params: [HA_STATE, JSON.stringify(emptyState())] }] : []),
  ]);
  if (next.address !== was.address || next.entity !== was.entity || next.enabled !== was.enabled) await setStatus({});
  // 0.9.3: turned off on the household's Home Assistant phone: it isn't the one any more.
  if (was.enabled && !next.enabled) await releaseHaPhone().catch(() => undefined);
  if (next.enabled) requestHaSync('soon');
  return next;
}

// The status is kept in memory for the screen, and saved when it changes (a problem, or one fixed)
// or every 10 minutes: a save every minute would have every screen read the database again.
let status: HaStatus | undefined;
const statusListeners = new Set<(s: HaStatus) => void>();

export async function getHaStatus(): Promise<HaStatus> {
  return status ?? (status = (await getKV<HaStatus>(HA_STATUS)) ?? {});
}

/** The Home Assistant screen hears about each round. */
export function onHaStatus(fn: (s: HaStatus) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/** 0.9.4: a status Java worked out (and saved): kept for the screens, not saved again. */
function heardStatus(s: HaStatus): void {
  status = s;
  statusListeners.forEach((fn) => fn(s));
}

async function setStatus(s: HaStatus): Promise<void> {
  const saved = (await getKV<HaStatus>(HA_STATUS)) ?? {};
  status = s;
  statusListeners.forEach((fn) => fn(s));
  const stale = !saved.okAt || !s.okAt || Date.parse(s.okAt) - Date.parse(saved.okAt) > 600_000;
  if (saved.error !== s.error || !!saved.auth !== !!s.auth || !!saved.held !== !!s.held || (s.okAt !== saved.okAt && stale)) await putKV(HA_STATUS, s);
}

/**
 * An address as typed, tidied: "homeassistant.local:8123" → "http://homeassistant.local:8123",
 * "abc.ui.nabu.casa" → "https://abc.ui.nabu.casa", and anything after the address itself (a
 * dashboard's path, say) left off. Undefined if it isn't a web address.
 */
export function tidyAddress(typed: string): string | undefined {
  let t = typed.trim();
  if (!t) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    const host = t.split(/[/:?#]/)[0].toLowerCase();
    const home = /\.(local|lan|home|internal|home\.arpa)$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !host.includes('.');
    t = (home ? 'http://' : 'https://') + t;
  }
  try {
    const u = new URL(t);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** A long-lived access token: one line, no spaces (Home Assistant's are about 180 letters, numbers, dots, "-" and "_"). */
export function cleanToken(typed: string): string | undefined {
  const t = typed.trim().replace(/^Bearer\s+/i, '');
  return /^[A-Za-z0-9._~+/=-]{20,2000}$/.test(t) ? t : undefined;
}

// ---------- the phone's side ----------

/** Words for what Java couldn't do (it can't reach Home Assistant, the certificate, plain http away from home). */
export function reachText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? '');
  if (/only uses http:\/\//i.test(m))
    return 'Restock only uses http:// for a Home Assistant at home (like http://192.168.1.50:8123 or homeassistant.local) or on Tailscale. Away from home, use its https:// address, such as your Nabu Casa one.';
  if (/couldn't find that server/i.test(m))
    return "Couldn't find Home Assistant at that address. If homeassistant.local doesn't work on this phone, use its IP address instead, like http://192.168.1.50:8123.";
  if (/couldn't reach|broke off|took too long/i.test(m))
    return "Couldn't reach Home Assistant. Check the address, and that this phone is on your home Wi-Fi (or use your Nabu Casa or Tailscale address).";
  if (/certificate/i.test(m)) return "Home Assistant's security certificate wasn't accepted, so Restock didn't connect. Check the https:// address.";
  if (/token/i.test(m)) return m;
  return m.replace(/\bthe server\b/g, 'Home Assistant').replace(/\bThe server\b/g, 'Home Assistant') || "Couldn't reach Home Assistant.";
}

/**
 * Requests through Java (HomeAssistant.java): it adds the saved token, and keeps to the same rule
 * as sync: plain http only to an address at home or on Tailscale, https everywhere else. `token`:
 * one typed in but not saved yet (Test connection).
 */
export function phoneTransport(address: string, token?: string): Transport {
  return async (method, path, body) => {
    try {
      const r = await RestockNative.haRequest({ address, method, path, body: body === undefined ? undefined : JSON.stringify(body), token });
      return { status: r.status, text: r.body ?? '' };
    } catch (e) {
      throw new HaError(reachText(e));
    }
  };
}

/** The pairing was started afresh after this round began (a new address or list, a restore): it stops before changing anything. */
export class PairingRestarted extends Error {
  constructor() {
    super('Home Assistant’s pairing was started afresh. Trying again.');
    this.name = 'PairingRestarted';
  }
}

/**
 * Restock's side, in the database: the grocery list's and General's lines (and ones made from Home
 * Assistant's list, wherever they went), and the items of the tabs that are on (0.9.5: Keg and Health too).
 * `resets`: haPairingResets() when the round began (before its config was read). If the pairing
 * is started afresh after that, the round stops before changing anything, and doesn't save its
 * pairing (made for the old list or the old database) over the fresh one.
 */
export function dbStore(resets?: number): Store {
  let since = resets;
  const toLine = (e: ListEntry): Line => ({ id: e.id, text: e.text, qty: Math.max(1, e.qty ?? 1), checked: e.checked, groupId: e.groupId });
  return {
    async lines() {
      const groups = new Map((await allGroups()).map((g) => [g.id, g.section ?? 'pantry']));
      return (await allListEntries()).filter((e) => onHaList(e.id, (e.groupId ? groups.get(e.groupId) : undefined) ?? e.section ?? 'pantry')).map(toLine);
    },
    async items() {
      const on = activeSections(await getSettings());
      return (await allGroups()).filter((g) => on.includes(g.section ?? 'pantry')).map((g) => ({ id: g.id, name: g.name, section: g.section ?? 'pantry' }));
    },
    aliases: getAliases,
    async addLine(l, itemUid) {
      // Made from Home Assistant's list: the "ha-" says so on every phone and the web (listPicks.ts).
      // 0.9.4: made from an item, its id comes from the list and the item (haLineId), added only if
      // it isn't there yet (another runner made it), as HaSync.java's DbStore does.
      const id = itemUid ? haLineId((await getHaConfig()).entity, itemUid) : FROM_HA + uid();
      const op = insertEntryOp({ id, text: l.text, qty: l.qty, groupId: l.groupId, section: l.section ?? 'pantry', checked: l.checked, createdAt: nowIso() });
      // 0.9.5 (final review): a round's writes wait for (and are never part of) an action someone is doing.
      await background(() => runOps([{ ...op, sql: op.sql.replace('INSERT INTO', 'INSERT OR IGNORE INTO') }]));
      return id;
    },
    async updateLine(id, patch) {
      await background(() => updateListEntry(id, patch));
    },
    async removeLines(ids) {
      await background(() => deleteListEntries(ids));
    },
    async loadState() {
      if (since === undefined) since = haPairingResets();
      const s = await getKV<HaState>(HA_STATE);
      if (since !== haPairingResets()) throw new PairingRestarted();
      if (!s || !Array.isArray(s.pairs)) return emptyState();
      const out: HaState = { pairs: s.pairs, pick: Array.isArray(s.pick) ? s.pick : [] };
      if (typeof s.emptySince === 'number' && Number.isFinite(s.emptySince)) out.emptySince = s.emptySince;
      if (typeof s.emptyLast === 'number' && Number.isFinite(s.emptyLast)) out.emptyLast = s.emptyLast;
      return out;
    },
    async saveState(s) {
      const was = await getKV<HaState>(HA_STATE);
      if (since !== undefined && since !== haPairingResets()) return;
      if (JSON.stringify(was) !== JSON.stringify(s)) await putKV(HA_STATE, s);
    },
  };
}

// ---------- when it runs ----------

let running: Promise<void> | undefined;
let lastPrint = '';
let timer: ReturnType<typeof setTimeout> | undefined;

/** What the grocery list looks like to Home Assistant, to tell whether a change needs sending. */
async function listPrint(): Promise<string> {
  const store = dbStore();
  const [lines, items] = await Promise.all([store.lines(), store.items()]);
  const names = new Map(items.map((g) => [g.id, g.name]));
  return JSON.stringify(lines.map((l) => [l.id, l.text, l.qty, l.checked, l.groupId ? names.get(l.groupId) : '']));
}

/**
 * Whether this phone is still the household's Home Assistant phone (listPicks.ts haPhone). With Home
 * Assistant on here and no phone named yet, this phone takes it, quietly (a phone named elsewhere that
 * hasn't reached this one yet still wins); a phone named that has left the household, this one takes
 * over. Another phone named: Home Assistant goes off here (the token stays, so it can take over again
 * with Move it here) and the Home Assistant screen says which phone does it.
 */
export async function stillTheHaPhone(): Promise<boolean> {
  const who = await haPhone();
  // 0.9.4: never in a house (HaSync.java stillTheHaPhone is the same).
  if (who.house) return false;
  if (who.mine) return true;
  if (who.device) {
    await saveHaConfig({ enabled: false });
    return false;
  }
  await claimHaPhone({ quietly: true });
  return (await haPhone()).mine;
}

/** "Home Assistant syncs through Alex's phone": a phone's name as the screens say it. */
export function phoneLabel(name: string | undefined): string {
  const n = (name ?? '').trim();
  if (!n || n === 'another phone') return 'another phone';
  // 0.9.4: the household's row names the server (listPicks.ts haPhone).
  if (n === 'your server') return n;
  return /phone$/i.test(n) ? n : `${n}'s phone`;
}

/**
 * Turn on (or Move it here): this phone becomes the household's Home Assistant phone, and Home
 * Assistant goes on here. Taking it over from another phone starts the pairing afresh (the next
 * round pairs both lists by their words, so nothing is removed or added twice): this phone's notes
 * from the last time it did it are out of date.
 */
/** 0.9.4: why a phone in a house can't turn on its own Home Assistant. */
export const HOUSE_RUNS_IT = 'In a server household, Home Assistant runs on your server, so every phone and browser shares one list. Set it up on your server’s page.';

export async function takeHomeAssistant(): Promise<HaConfig> {
  const who = await haPhone();
  // 0.9.4: never in a house (D12).
  if (who.house) throw new Error(HOUSE_RUNS_IT);
  if (!who.mine) {
    // Another phone named, or the last change to the row was another phone's (it took it and has
    // since turned it off, or left): it synced with Home Assistant after this phone last did.
    const [last] = who.device ? [] : await queryRows<{ device: string }>("SELECT device FROM sync_log WHERE tbl = 'household_settings' AND pk = ?", ['ha:phone']).catch(() => []);
    if (who.device || (last && last.device !== who.me)) {
      resetHaPairing();
      await putKV(HA_STATE, emptyState());
    }
    await claimHaPhone();
  }
  return saveHaConfig({ enabled: true });
}

/** The round in TypeScript, on this side (haSync.ts with dbStore): only for an Android side without haRound. */
async function tsRound(opts: { manual?: boolean }): Promise<void> {
  const resets = haPairingResets();
  const c = await getHaConfig();
  if (!c.enabled || !c.address || !haAvailable()) return;
  // 0.9.3: one phone per household (another phone took over: this one stops here).
  if (!(await stillTheHaPhone())) return;
  const st = await getHaStatus();
  if (st.auth && !opts.manual) return;
  try {
    await migrateAliases().catch(() => 0);
    const r = await syncRound(restApi(phoneTransport(c.address), c.entity), dbStore(resets));
    lastPrint = await listPrint();
    // Held (Home Assistant's list came back empty): not counted as synced, nothing went wrong either.
    await setStatus(r.held ? { okAt: st.okAt, held: true } : { okAt: nowIso() });
    await tidyKeeps().catch(() => 0);
  } catch (e) {
    // The list or the database changed under it: a fresh round with the new one in a moment.
    if (e instanceof PairingRestarted) return requestHaSync('soon');
    const err = e instanceof HaError ? e : new HaError(reachText(e));
    await setStatus({ okAt: st.okAt, error: err.message, auth: err.auth || undefined });
  }
}

/** True for Capacitor's answer to a method the Android side doesn't have. */
const unimplemented = (e: unknown) => (e as { code?: unknown })?.code === 'UNIMPLEMENTED' || /not implemented/i.test(String((e as Error)?.message ?? ''));

/** 0.9.4: one round in Java (HaSync.java), the same as the background job's. Answers false if Java can't. */
async function javaRound(opts: { manual?: boolean }): Promise<boolean> {
  const c = (await getKV<Partial<HaConfig>>(HA_CONFIG)) ?? {};
  // "Always use this for …" saved the old way move into the household's rows first.
  if (c.enabled) await migrateAliases().catch(() => 0);
  let r: HaRound;
  try {
    r = await haNative().haRound({ manual: !!opts.manual });
  } catch (e) {
    if (unimplemented(e)) return false;
    throw e;
  }
  if (r.came > 0) changed();
  if (r.ran || r.house) lastPrint = await listPrint();
  if (r.ran && !r.status?.error) await tidyKeeps().catch(() => 0);
  heardStatus(r.status ?? {});
  // The list or the database changed under it: a fresh round with the new one in a moment.
  if (r.restarted) requestHaSync('soon');
  return true;
}

/**
 * One round now, if Home Assistant is on for this phone. `manual` (Sync now, Try again) also runs
 * after the token was turned down, which the automatic ones don't, so a wrong token isn't tried
 * over and over (Home Assistant can block a phone that does that).
 */
export async function runHaSync(opts: { manual?: boolean } = {}): Promise<HaStatus> {
  // One round at a time: another one waits for it, then looks again.
  while (running) await running;
  running = (async () => {
    if (!haAvailable()) return;
    if (!(await javaRound(opts))) await tsRound(opts);
  })()
    .catch((e) => console.error('Home Assistant sync failed', e))
    .finally(() => (running = undefined));
  await running;
  return getHaStatus();
}

/** A round in a moment ('soon', after a change) or straight away. */
export function requestHaSync(when: 'soon' | 'now' = 'soon'): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(
    () => {
      timer = undefined;
      void runHaSync().catch((e) => console.error('Home Assistant sync failed', e));
    },
    when === 'now' ? 0 : 4000,
  );
}

let wired = false;

/**
 * Once at start-up (App.tsx): a round now, when Restock comes back, every minute while it's open,
 * and a few seconds after the list changes, here or from another phone. Does nothing until Home
 * Assistant is turned on for this phone.
 */
export function wireHomeAssistant(onResume: (fn: () => void) => () => void): () => void {
  if (wired || !haAvailable()) return () => undefined;
  wired = true;
  // 0.9.4: Java's round stops (or doesn't save) when the pairing is started afresh on this side.
  const offReset = onHaPairingReset(() => void haNative().haResetPairing().catch(() => undefined));
  // "Always use this for …" saved the old way on this phone move into the household's rows.
  void migrateAliases().catch(() => 0);
  requestHaSync('now');
  const off = onResume(() => requestHaSync('now'));
  const every = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') requestHaSync('now');
  }, 60_000);
  // Only when the list itself changed (the rounds' own notes, and price checks, change the database
  // too), looked at a moment after the last change so a burst of writes is one look.
  let look: ReturnType<typeof setTimeout> | undefined;
  const offChange = onChange(() => {
    if (look) clearTimeout(look);
    look = setTimeout(() => {
      look = undefined;
      void (async () => {
        const c = await getKV<Partial<HaConfig>>(HA_CONFIG);
        if (!c?.enabled) return;
        const now = await listPrint();
        if (now !== lastPrint) {
          lastPrint = now;
          requestHaSync('soon');
        }
      })().catch(() => undefined);
    }, 1000);
  });
  return () => {
    wired = false;
    offReset();
    off();
    clearInterval(every);
    if (look) clearTimeout(look);
    offChange();
  };
}

// ---------- the settings screen ----------

/** Test connection: Home Assistant's version and to-do lists, with the token typed in (or the saved one). */
export async function testHomeAssistant(address: string, token?: string) {
  return haLists(phoneTransport(address, token));
}

export async function saveHaToken(token: string, address: string): Promise<void> {
  if ((await haPhone()).house) throw new Error(HOUSE_RUNS_IT);
  await RestockNative.haSaveToken({ token, address });
  const st = await getHaStatus();
  // A new token: Restock tries again by itself.
  if (st.auth) await setStatus({ ...st, auth: undefined, error: undefined });
  requestHaSync('now');
}

export async function haTokenSaved(): Promise<boolean> {
  if (!haAvailable()) return false;
  return (await RestockNative.haHasToken().catch(() => ({ saved: false }))).saved;
}

/** Remove: the token is forgotten and Home Assistant is turned off on this phone. */
export async function removeHaToken(): Promise<void> {
  await RestockNative.haForgetToken();
  await saveHaConfig({ enabled: false });
}
