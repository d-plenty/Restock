// 0.9.3: "Pick my milk" on every phone and on the web, and which one phone in the household syncs
// the shopping list with Home Assistant. What every device has to agree on is kept in the synced
// household_settings table, as rows that aren't settings (sharedSettings.ts checkListRow):
//
//   alias:<words> → item id    "Always use this for 'milk'" (any phone or the web can save one; the
//                              Home Assistant phone's matcher uses them for voice adds)
//   keep:<line id> → true      "Keep it as just 'milk'": no "Pick my milk" on that line anywhere
//   ha:phone → device id       the phone that syncs with Home Assistant (only in a household)
//
// A list line "needs a match" when it came from Home Assistant (the Home Assistant phone makes those
// lines with an id that starts "ha-", homeAssistant.ts dbStore: the id is synced like any other, and
// older phones and both sync engines treat it as just an id), it's still not linked to a pantry item
// or a shop's product, it's still to buy on the groceries list, there are pantry items to pick from,
// and nobody has said "Keep it as just …" for it. Lines from Home Assistant that the matcher could link
// straight away are linked already, so what's left matched none or more than one item.
//
// No household (a phone on its own): the same rows work on the phone itself, and no ha:phone row is
// needed (the phone that turns Home Assistant on is the one).
//
// 0.9.4, a house (the household's owner is a Restock server, srv-…): Home Assistant runs only on the
// server (design D12). Its ha:phone row names the server when it runs it; a phone never claims the
// row there, whether the server runs it or not (HaSync.java claimHaPhone does the same).

import { allGroups, allListEntries, deleteListEntries, getKV, putKV, queryRows, runOps, updateListEntry } from './db';
import { HA_STATE, LIST_ALIASES } from './haKeys';
import { matchKey, parseLine } from './haMatch';
import { ALIAS_PREFIX, checkListRow, decode, HA_PHONE, KEEP_PREFIX } from './sharedSettings';
import type { ListEntry } from '../types';
import { background } from './undo';

/** Lines made from Home Assistant's list start with this (homeAssistant.ts dbStore.addLine). */
export const FROM_HA = 'ha-';

const TABLE = 'household_settings';
/** A line deleted at least this long ago takes its keep: row with it (not sooner: an undo brings the line back). */
const KEEP_TIDY_AFTER_MS = 60 * 60_000;

type Row = { k: string; v: string };

async function listRows(): Promise<Row[]> {
  return queryRows<Row>(`SELECT k, v FROM ${TABLE} WHERE k LIKE 'alias:%' OR k LIKE 'keep:%' OR k = ?`, [HA_PHONE]).catch(() => []);
}

// ---------- "Always use this for …" ----------

/** The aliases saved on this phone before they moved into the household's rows (0.9.3 test builds, or a backup). */
async function legacyAliases(): Promise<Record<string, string>> {
  const a = await getKV<Record<string, unknown>>(LIST_ALIASES).catch(() => undefined);
  const out: Record<string, string> = {};
  if (!a || typeof a !== 'object' || Array.isArray(a)) return out;
  for (const [k, v] of Object.entries(a)) {
    const id = checkListRow(ALIAS_PREFIX + k, v);
    if (typeof id === 'string') out[k] = id;
  }
  return out;
}

/** The saved aliases (matchKey words → item id): the household's rows, then any still kept the old way. */
export async function getAliases(): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...(await legacyAliases()) };
  for (const r of await listRows()) {
    if (!r.k.startsWith(ALIAS_PREFIX)) continue;
    const id = checkListRow(r.k, decode(r.v));
    if (typeof id === 'string') out[r.k.slice(ALIAS_PREFIX.length)] = id;
  }
  return out;
}

/** "Always use this for <words>": saved for the household (or this phone, on its own). */
export async function saveAlias(words: string, itemId: string): Promise<void> {
  const key = matchKey(words);
  const k = ALIAS_PREFIX + key;
  if (!key || checkListRow(k, itemId) === undefined) return;
  const [had] = await queryRows<{ v: string }>(`SELECT v FROM ${TABLE} WHERE k = ?`, [k]).catch(() => []);
  if (had && decode(had.v) === itemId) return;
  await runOps([{ sql: `INSERT OR REPLACE INTO ${TABLE} (k, v) VALUES (?, ?)`, params: [k, JSON.stringify(itemId)] }]);
}

/**
 * The aliases this phone kept the old way (LIST_ALIASES, on the Home Assistant phone, or from a
 * backup) move into the household's rows, once: a row already there wins (it's the household's).
 */
export async function migrateAliases(): Promise<number> {
  const legacy = await legacyAliases();
  const raw = await getKV<unknown>(LIST_ALIASES).catch(() => undefined);
  if (raw === undefined) return 0;
  const have = new Set((await listRows()).map((r) => r.k));
  const ops = Object.entries(legacy)
    .filter(([k]) => !have.has(ALIAS_PREFIX + k))
    .map(([k, id]) => ({ sql: `INSERT OR REPLACE INTO ${TABLE} (k, v) VALUES (?, ?)`, params: [ALIAS_PREFIX + k, JSON.stringify(id)] }));
  ops.push({ sql: 'DELETE FROM kv WHERE key = ?', params: [LIST_ALIASES] });
  await runOps(ops);
  return ops.length - 1;
}

/** For a backup: the aliases as the old kv entry (a restore moves them back into rows with migrateAliases). */
export async function aliasesForBackup(): Promise<Record<string, string> | undefined> {
  const a = await getAliases();
  return Object.keys(a).length ? a : undefined;
}

// ---------- "Pick my milk" ----------

/** The word on the button: "Pick my milk" for a line "2 milk". */
export const pickWord = (text: string) => parseLine(text).name;

/** Lines that came from Home Assistant and showed "Pick my …" on the Home Assistant phone before the button went everywhere (test builds). */
async function legacyPicks(): Promise<Set<string>> {
  const s = await getKV<{ pick?: unknown }>(HA_STATE).catch(() => undefined);
  return new Set(Array.isArray(s?.pick) ? s.pick.filter((x): x is string => typeof x === 'string') : []);
}

/** Whether a list line needs "Pick my …" (see the top of this file). */
export function needsMatch(e: ListEntry, keeps: ReadonlySet<string>, legacy: ReadonlySet<string> = new Set()): boolean {
  return (
    (e.id.startsWith(FROM_HA) || legacy.has(e.id)) &&
    !e.groupId &&
    !e.product &&
    !e.checked &&
    // 0.9.5: or on General, where what matched nothing goes.
    ((e.section ?? 'pantry') === 'pantry' || e.section === 'general') &&
    !keeps.has(e.id) &&
    !!e.text.trim()
  );
}

/** The lines that show "Pick my …", on any phone and on the web. */
export async function linesToPick(): Promise<Set<string>> {
  const [entries, groups, rows, legacy] = await Promise.all([allListEntries(), allGroups(), listRows(), legacyPicks()]);
  if (!groups.some((g) => (g.section ?? 'pantry') === 'pantry')) return new Set();
  const keeps = new Set(rows.filter((r) => r.k.startsWith(KEEP_PREFIX) && checkListRow(r.k, decode(r.v)) === true).map((r) => r.k.slice(KEEP_PREFIX.length)));
  return new Set(entries.filter((e) => needsMatch(e, keeps, legacy)).map((e) => e.id));
}

/** Drops a line from the old local "Pick my" list (test builds), if it's there. */
async function dropLegacy(entryId: string): Promise<void> {
  const s = await getKV<{ pick?: unknown }>(HA_STATE).catch(() => undefined);
  if (s && Array.isArray(s.pick) && s.pick.includes(entryId)) await putKV(HA_STATE, { ...s, pick: s.pick.filter((x) => x !== entryId) });
}

/**
 * Picked: the line becomes that pantry item (or, if the item is already on the list still to buy,
 * that line gets one more, as adding it in Restock does). It syncs like any change to the list, and
 * the Home Assistant phone sends the item's name to Home Assistant at its next round. `always`: these
 * words are that item from now on, for the whole household.
 *
 * The line as it is now, not as the sheet was opened with it: another phone may have ticked it off
 * (then it's only linked, never folded into another line and deleted) or deleted it meanwhile (then
 * nothing changes on the list, and no other line gets one more). False when the line has gone.
 */
export async function pickItemFor(entry: ListEntry, group: { id: string; name: string }, always: boolean): Promise<boolean> {
  if (always) await saveAlias(pickWord(entry.text), group.id);
  const all = await allListEntries();
  const now = all.find((e) => e.id === entry.id);
  await dropLegacy(entry.id);
  if (!now) return false;
  const already = all.find((e) => e.id !== now.id && e.groupId === group.id && !e.checked);
  if (already && !now.checked) {
    await updateListEntry(already.id, { qty: Math.max(1, already.qty ?? 1) + Math.max(1, now.qty ?? 1) });
    await deleteListEntries([now.id]);
  } else {
    // 0.9.5: a line from General moves to the item's own list.
    const tab = now.section === 'general' ? ((await allGroups()).find((g) => g.id === group.id)?.section ?? 'pantry') : undefined;
    await updateListEntry(now.id, { groupId: group.id, text: group.name, ...(tab ? { section: tab } : {}) });
  }
  return true;
}

/** "Keep it as just milk": the button goes on every phone and the web, and the line stays as it is. */
export async function keepAsWords(entryId: string): Promise<void> {
  const k = KEEP_PREFIX + entryId;
  if (checkListRow(k, true) === true) await runOps([{ sql: `INSERT OR REPLACE INTO ${TABLE} (k, v) VALUES (?, ?)`, params: [k, 'true'] }]);
  await dropLegacy(entryId);
}

/**
 * keep: rows of lines that are gone (deleted at least an hour ago, so an undo still finds its row),
 * tidied away. On the Home Assistant phone each round and on the web after each sync, so a line an
 * older phone deleted takes its row with it too. Answers how many went.
 */
export async function tidyKeeps(now = Date.now()): Promise<number> {
  const gone = await queryRows<{ k: string }>(
    `SELECT s.k AS k FROM ${TABLE} s JOIN sync_log l ON l.tbl = 'list_entries' AND l.pk = substr(s.k, 6) AND l.deleted = 1 AND l.stamp < ?
     WHERE s.k LIKE 'keep:%' AND NOT EXISTS (SELECT 1 FROM list_entries e WHERE e.id = substr(s.k, 6))`,
    [now - KEEP_TIDY_AFTER_MS],
  ).catch(() => []);
  // 0.9.5 (final review): never part of an action someone is doing (its Undo leaves this alone).
  if (gone.length) await background(() => runOps(gone.map((g) => ({ sql: `DELETE FROM ${TABLE} WHERE k = ?`, params: [g.k] }))));
  return gone.length;
}

// ---------- the one Home Assistant phone ----------

export interface HaPhone {
  /** This device is in a household (only then is there one Home Assistant phone to agree on). */
  inHousehold: boolean;
  /** This device's sync id. */
  me: string;
  /** The phone the household's row names (when it's still in the household). */
  device?: string;
  /** Its name in the household ("Declan's phone"), or "another phone" while its member entry isn't here yet. */
  name?: string;
  /** This phone is the one (or isn't in a household, where it's always its own). */
  mine: boolean;
  /** The row names a phone that has left the household (or was removed): another phone may take over. */
  left?: boolean;
  /**
   * 0.9.4: the household is a house (its owner is a Restock server). Home Assistant runs only on the
   * server there; this phone never claims it or runs its own.
   */
  house?: HaHouse;
}

/** 0.9.4: a house, for the Home Assistant screen. */
export interface HaHouse {
  /** The house's name ("Declan and Sarah"). */
  name?: string;
  /** The household's ha:phone row names the server: it runs Home Assistant for every phone and browser. */
  serverRuns: boolean;
  /** Where the server's page is, from its owner-signed `server` row (at home, and away if it has one). */
  home?: string;
  away?: string;
}

/** A server row's address, if it's a web address (it's signed by the house, but shown as a link). */
const webAddress = (v: unknown): string | undefined => (typeof v === 'string' && /^https?:\/\/[^\s/?#]+/i.test(v) ? v : undefined);

/** 0.9.4: a house's own record (its owner is a srv- device), or undefined in any other household. */
function houseOf(rows: { k: string; v: string }[], device: string | undefined): HaHouse | undefined {
  const owner = rows.find((r) => r.k === 'owner')?.v;
  if (!owner?.startsWith('srv-')) return undefined;
  const out: HaHouse = { serverRuns: !!device?.startsWith('srv-') };
  const name = rows.find((r) => r.k === 'name')?.v?.trim();
  if (name) out.name = name;
  try {
    const s = JSON.parse(rows.find((r) => r.k === 'server')?.v ?? 'null') as { v?: unknown; home?: unknown; away?: unknown } | null;
    if (s && s.v === 3) {
      const home = webAddress(s.home);
      const away = webAddress(s.away);
      if (home) out.home = home;
      if (away) out.away = away;
    }
  } catch {
    // no server row yet
  }
  return out;
}

/** Which phone syncs with Home Assistant, as this device sees it. */
export async function haPhone(): Promise<HaPhone> {
  const [meRow] = await queryRows<{ value: string }>("SELECT value FROM sync_meta WHERE key = 'device'").catch(() => []);
  const me = meRow?.value ?? '';
  const household = await queryRows<{ k: string; v: string }>(
    "SELECT k, v FROM household WHERE k IN ('owner', 'name', 'server') OR k LIKE 'member:%' OR k LIKE 'removed:%'",
  ).catch(() => []);
  const inHousehold = household.some((r) => r.k === 'owner');
  if (!inHousehold) return { inHousehold, me, mine: true };
  const [row] = await queryRows<{ v: string }>(`SELECT v FROM ${TABLE} WHERE k = ?`, [HA_PHONE]).catch(() => []);
  const device = row ? checkListRow(HA_PHONE, decode(row.v)) : undefined;
  const house = houseOf(household, typeof device === 'string' ? device : undefined);
  if (typeof device !== 'string') return { inHousehold, me, mine: false, ...(house ? { house } : {}) };
  const server = device.startsWith('srv-');
  const member = household.find((r) => r.k === 'member:' + device);
  if (!member && !server) {
    // Gone for sure (its member entry deleted, or removed by the owner), or just not here yet.
    const [del] = await queryRows<{ n: number }>("SELECT COUNT(*) AS n FROM sync_log WHERE tbl = 'household' AND pk = ? AND deleted = 1", ['member:' + device]).catch(() => [{ n: 0 }]);
    const removed = household.some((r) => r.k === 'removed:' + device);
    if (removed || Number(del?.n ?? 0) > 0) return { inHousehold, me, mine: false, left: true, ...(house ? { house } : {}) };
  }
  let name = server ? 'your server' : 'another phone';
  if (member && !server) {
    try {
      const n = (JSON.parse(member.v) as { name?: unknown }).name;
      if (typeof n === 'string' && n.trim()) name = n.trim();
    } catch {
      // an odd entry
    }
  }
  return { inHousehold, me, device, name, mine: device === me, ...(house ? { house } : {}) };
}

/**
 * This phone becomes the household's Home Assistant phone (nothing to do outside a household).
 * `quietly`: only if no phone is named yet, as the oldest possible change (like the owner's seed of
 * the household settings), so a phone that's named on another phone but hasn't reached this one
 * yet still wins: used when Home Assistant was already on here before there was a row. Otherwise
 * (Turn on, Move it here) a change made now, which wins over what's there.
 *
 * 0.9.4: never in a house (its server does it, or nobody does): answers false there, true otherwise.
 */
export async function claimHaPhone(opts: { quietly?: boolean } = {}): Promise<boolean> {
  const who = await haPhone();
  if (who.house) return false;
  if (!who.inHousehold || !who.me || who.me.startsWith('web-') || who.mine) return true;
  const v = JSON.stringify(who.me);
  // Quietly only while there's nothing at all for the row here yet; a row that's there but no use
  // (a phone that left, a value that isn't right) is simply replaced.
  const [noted] = opts.quietly ? await queryRows<{ n: number }>('SELECT COUNT(*) AS n FROM sync_log WHERE tbl = ? AND pk = ?', [TABLE, HA_PHONE]).catch(() => [{ n: 1 }]) : [];
  if (!opts.quietly || who.device || who.left || Number(noted?.n ?? 1) > 0) {
    if (who.device && opts.quietly) return true;
    await runOps([{ sql: `INSERT OR REPLACE INTO ${TABLE} (k, v) VALUES (?, ?)`, params: [HA_PHONE, v] }]);
    return true;
  }
  await runOps([
    { sql: "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')" },
    { sql: `INSERT OR IGNORE INTO ${TABLE} (k, v) VALUES (?, ?)`, params: [HA_PHONE, v] },
    {
      sql: "INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq, sig, created) VALUES (?, ?, 1, ?, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log), NULL, 1)",
      params: [TABLE, HA_PHONE, who.me],
    },
    { sql: "DELETE FROM sync_meta WHERE key = 'applying'" },
  ]);
  return true;
}

/**
 * Home Assistant turned off on the phone that did it: the household's row goes, so the next phone
 * to turn it on just takes it (nobody's asked to move it from a phone that isn't doing it).
 * 0.9.4: not in a house: the row is the server's to change there.
 */
export async function releaseHaPhone(): Promise<void> {
  const who = await haPhone();
  if (!who.inHousehold || !who.device || !who.mine || who.house) return;
  await runOps([{ sql: `DELETE FROM ${TABLE} WHERE k = ?`, params: [HA_PHONE] }]);
}
