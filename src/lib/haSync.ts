import { candidates, lineSummary, matchKey, parseLine, type NamedItem } from './haMatch';

// 0.9.3: the shopping list both ways with a Home Assistant to-do list. Nothing here touches the
// phone or the database directly: the requests go through a Transport (on the phone, Java's
// RestockNative.haRequest, which adds the token; in tests, anything) and Restock's side through a
// Store (homeAssistant.ts), so all of it can be tested on a computer against a pretend Home Assistant.
//
// How the two lists stay the same: a three-way merge. After each round Restock keeps, for every
// line it has paired with an item in Home Assistant, what both sides looked like then (the
// snapshot). Next round, whichever side changed since the snapshot wins; if both did, Restock does.
// - New on one side: added to the other. Lines still to buy only: ticked-off ones stay where they are.
// - Ticked in Restock ↔ completed in Home Assistant.
// - Removed on one side: removed on the other, if it hasn't changed there since. If it has, it stays.
// - Renamed in Home Assistant: a plain line takes the new words. A line linked to a pantry item
//   keeps the item's name (a new number, "3 × Milk", is taken).
// - Lines nobody has paired yet (the first time, or after a round that stopped part-way) are paired
//   by their words first, so "milk" on both lists stays one "milk", and nothing is ever added twice.
// - The safety catch: Home Assistant answering with an empty list while Restock has lines paired
//   with it (Home Assistant starting up, or a cloud to-do list not loaded yet) changes nothing that
//   round: no deletes, no adds, and what both sides looked like stays as it was. Only a second look
//   at least 2 minutes later that still finds it empty clears the paired lines (it really was
//   emptied); if the items come back, it carries on as usual. Something added on either side
//   meanwhile waits for that round, so it can't be added twice, and the next round always ends the
//   hold one way or the other.

/** A to-do item in Home Assistant. */
export interface HaItem {
  uid: string;
  summary: string;
  status: 'needs_action' | 'completed';
}

/** What Restock asks of Home Assistant's list. */
export interface HaApi {
  items(): Promise<HaItem[]>;
  add(summary: string): Promise<void>;
  update(uid: string, patch: { rename?: string; status?: HaItem['status'] }): Promise<void>;
  remove(uids: string[]): Promise<void>;
}

/** One request to Home Assistant. `path` starts with /api/. Rejects when it can't be reached at all (in words). */
export type Transport = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; text: string }>;

/** Home Assistant has to be at least this new: the REST API answers todo.get_items (?return_response) from then. */
export const MIN_HA_VERSION = '2024.8';

/** A problem talking to Home Assistant, in words for the person. `auth`: the token was turned down. */
export class HaError extends Error {
  constructor(
    message: string,
    readonly auth = false,
  ) {
    super(message);
    this.name = 'HaError';
  }
}

export const TOKEN_REFUSED =
  "Home Assistant didn't accept the token. Make a new long-lived access token in Home Assistant (your profile → Security), then paste it in here with Change.";

/** Words for an answer that wasn't a yes. */
export function haProblem(status: number, text: string, doing: string, entity?: string): HaError {
  const said = text.length > 300 ? text.slice(0, 300) : text;
  if (status === 401) return new HaError(TOKEN_REFUSED, true);
  if (status === 403)
    return new HaError(
      "Home Assistant turned Restock away. If a wrong token was tried a few times, Home Assistant may have blocked this phone: check its notifications, then try again.",
      true,
    );
  if (status === 404) return new HaError("That address doesn't look like Home Assistant. Check it's the one you open Home Assistant with, like http://homeassistant.local:8123.");
  if (status === 400 && /return_response|responses/i.test(said))
    return new HaError(`Restock needs Home Assistant ${MIN_HA_VERSION} or newer for the shopping list. Update Home Assistant, then try again.`);
  // An item taken off or changed in Home Assistant while Restock was syncing (not the list itself).
  if (status === 400 && /unable to find|item_not_found/i.test(said))
    return new HaError('Something on the list changed in Home Assistant while Restock was syncing. Restock will try again in a minute.');
  if (status === 400 && entity) return new HaError(`Home Assistant couldn't find the list ${entity}. Pick the list again below.`);
  if (status >= 300 && status < 400) return new HaError('Home Assistant sent Restock somewhere else. Check the address (maybe it needs https://).');
  if (status >= 500) return new HaError(`Home Assistant had a problem (${status}). Restock will try again in a minute.`);
  return new HaError(`Home Assistant answered ${status} when Restock tried to ${doing}.`);
}

function json<T>(r: { status: number; text: string }, doing: string, entity?: string): T {
  if (r.status < 200 || r.status >= 300) throw haProblem(r.status, r.text, doing, entity);
  try {
    return JSON.parse(r.text) as T;
  } catch {
    throw new HaError("That address answered, but not like Home Assistant does. Check it's the address you open Home Assistant with.");
  }
}

/** The to-do list `entity` through Home Assistant's REST API (todo.get_items, add_item, update_item, remove_item). */
export function restApi(t: Transport, entity: string): HaApi {
  const call = async (service: string, body: Record<string, unknown>, doing: string) => {
    const r = await t('POST', `/api/services/todo/${service}`, { entity_id: entity, ...body });
    if (r.status < 200 || r.status >= 300) throw haProblem(r.status, r.text, doing, entity);
  };
  return {
    async items() {
      const r = await t('POST', '/api/services/todo/get_items?return_response', { entity_id: entity });
      const out = json<{ service_response?: Record<string, { items?: unknown[] }> }>(r, 'read the list', entity);
      const raw = out?.service_response?.[entity]?.items;
      if (!Array.isArray(raw)) throw new HaError(`Home Assistant didn't send the list ${entity}. Pick the list again below.`);
      return raw
        .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
        .filter((i) => typeof i.uid === 'string' && typeof i.summary === 'string')
        .map((i) => ({ uid: i.uid as string, summary: i.summary as string, status: i.status === 'completed' ? 'completed' : 'needs_action' }));
    },
    add: (summary) => call('add_item', { item: summary }, 'add to the list'),
    update: (uid, patch) => call('update_item', { item: uid, ...patch }, 'change the list'),
    remove: (uids) => call('remove_item', { item: uids }, 'take something off the list'),
  };
}

/** Home Assistant's version ("2024.8.1") and its to-do lists, for Test connection and the list picker. */
export async function haLists(t: Transport): Promise<{ version?: string; lists: { id: string; name: string }[] }> {
  const config = json<{ version?: unknown }>(await t('GET', '/api/config'), 'connect');
  const states = json<unknown[]>(await t('GET', '/api/states'), 'see the lists');
  const lists = (Array.isArray(states) ? states : [])
    .filter((s): s is { entity_id: string; attributes?: { friendly_name?: unknown } } => !!s && typeof (s as { entity_id?: unknown }).entity_id === 'string')
    .filter((s) => s.entity_id.startsWith('todo.'))
    .map((s) => ({ id: s.entity_id, name: typeof s.attributes?.friendly_name === 'string' ? s.attributes.friendly_name : s.entity_id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { version: typeof config.version === 'string' ? config.version : undefined, lists };
}

/** True for a version older than MIN_HA_VERSION ("2024.7.4"); false when it can't tell. */
export function tooOld(version: string | undefined): boolean {
  const m = version?.match(/^(\d{4})\.(\d{1,2})/);
  if (!m) return false;
  const [y, mo] = MIN_HA_VERSION.split('.').map(Number);
  return Number(m[1]) < y || (Number(m[1]) === y && Number(m[2]) < mo);
}

// ---------- the merge ----------

/** One side as it was at the last round: the words Home Assistant shows, and ticked or not. */
export interface Side {
  s: string;
  c: boolean;
}

/** A Restock line and the Home Assistant item it's paired with, and what both looked like last round. */
export interface HaPair {
  id: string;
  uid: string;
  r: Side;
  h: Side;
}

/** Kept on the Home Assistant phone only (never synced or backed up). */
export interface HaState {
  pairs: HaPair[];
  /**
   * Lines that showed "Pick my milk" on this phone only (0.9.3 test builds; still honoured). Lines
   * made from Home Assistant's list now say so in their id, for every phone (listPicks.ts).
   */
  pick: string[];
  /** When Home Assistant's list was first seen empty while lines were paired with it (ms): the safety catch. */
  emptySince?: number;
  /** The last look that still found it empty (ms): the two looks must be close together. */
  emptyLast?: number;
}

/** How long the safety catch waits before an empty Home Assistant list clears the paired lines. */
export const EMPTY_HOLD_MS = 2 * 60_000;
/**
 * Looks further apart than this don't confirm each other: an empty list seen before Restock was
 * closed and again hours later (Home Assistant restarting both times) starts the wait afresh.
 */
export const EMPTY_GAP_MS = 30 * 60_000;

export const emptyState = (): HaState => ({ pairs: [], pick: [] });

/** A line on Restock's grocery list (the Pantry tab's). */
export interface Line {
  id: string;
  text: string;
  qty: number;
  checked: boolean;
  groupId?: string;
}

/** Restock's side. */
export interface Store {
  /** The grocery list's lines. */
  lines(): Promise<Line[]>;
  /** Pantry items (the Pantry tab's), for matching and their names. */
  items(): Promise<NamedItem[]>;
  /** Saved "Always use this for …" words (matchKey → item id). */
  aliases(): Promise<Record<string, string>>;
  addLine(l: Omit<Line, 'id'>): Promise<string>;
  updateLine(id: string, patch: Partial<Omit<Line, 'id'>>): Promise<void>;
  removeLines(ids: string[]): Promise<void>;
  loadState(): Promise<HaState>;
  saveState(s: HaState): Promise<void>;
}

export interface RoundResult {
  /** Changes that came into Restock, and that went to Home Assistant. */
  came: number;
  went: number;
  /** Home Assistant's list came back empty while lines were paired with it: nothing was changed (the safety catch). */
  held?: boolean;
}

const done = (h: HaItem) => h.status === 'completed';
const sameSide = (a: Side, b: Side) => a.s === b.s && a.c === b.c;

/** What Home Assistant shows for a Restock line: its pantry item's name (or its words), with how many. */
export function summaryOf(l: Line, names: Map<string, string>): string {
  return lineSummary((l.groupId ? names.get(l.groupId) : undefined) ?? l.text, l.qty);
}

/**
 * The key a line or item pairs on by its words: number left out, plurals aside. Words with no
 * letters or numbers at all ("🍌") pair on themselves, so they're never sent again every round.
 */
const pairKey = (text: string) => {
  const p = parseLine(text);
  return p.key || p.name.toLowerCase().replace(/\s+/g, ' ').trim();
};

/**
 * One round: reads Home Assistant's list, brings both lists together, and saves where things are.
 * Throws HaError (or the transport's error) when Home Assistant can't be reached or says no; what
 * was done until then is kept, and the next round carries on from there without doubling anything.
 * `now`: the clock, for the safety catch (ms).
 */
export async function syncRound(api: HaApi, store: Store, now: number = Date.now()): Promise<RoundResult> {
  const items = await api.items();
  const [lines, pantry, aliases, before] = await Promise.all([store.lines(), store.items(), store.aliases(), store.loadState()]);
  // The safety catch: an empty list from Home Assistant while lines on Restock's list are paired with it.
  const onList = new Set(lines.map((l) => l.id));
  if (!items.length && before.pairs.some((p) => onList.has(p.id))) {
    const since = before.emptySince;
    const last = before.emptyLast ?? since;
    // The first time, a clock that went backwards, or the last empty look was long ago: note when,
    // and change nothing.
    if (since === undefined || last === undefined || since > now || last > now || now - last > EMPTY_GAP_MS) {
      await store.saveState({ ...before, emptySince: now, emptyLast: now });
      return { came: 0, went: 0, held: true };
    }
    // Looked at again too soon: still nothing (but remember this look).
    if (now - since < EMPTY_HOLD_MS) {
      await store.saveState({ ...before, emptyLast: now });
      return { came: 0, went: 0, held: true };
    }
    // Still empty 2 minutes or more later: it was emptied. The round below clears the paired lines
    // (those unchanged here since), and the save at the end forgets when it was first seen.
  }
  const names = new Map(pantry.map((g) => [g.id, g.name]));
  const byId = new Map(lines.map((l) => [l.id, l]));
  const byUid = new Map(items.map((h) => [h.uid, h]));
  const state: HaState = { pairs: [], pick: [...before.pick] };
  const out: RoundResult = { came: 0, went: 0 };
  const pairedIds = new Set<string>();
  const pairedUids = new Set<string>();
  const keep = (p: HaPair) => {
    state.pairs.push(p);
    pairedIds.add(p.id);
    pairedUids.add(p.uid);
  };
  // Pairs not looked at yet stay as they were, so a round that stops part-way loses nothing.
  let rest = [...before.pairs];
  const save = async () => {
    const seen = new Set(state.pairs.map((p) => p.id));
    const pairs = [...state.pairs, ...rest.filter((p) => !seen.has(p.id) && !pairedUids.has(p.uid))];
    const live = new Set((await store.lines()).filter((l) => !l.groupId).map((l) => l.id));
    await store.saveState({ pairs, pick: [...new Set(state.pick)].filter((id) => live.has(id)) });
  };

  try {
    // 1. Lines paired before.
    while (rest.length) {
      const p = rest[0];
      const r = byId.get(p.id);
      const h = byUid.get(p.uid);
      if (!r && !h) {
        rest = rest.slice(1);
        continue;
      }
      if (!r) {
        // Gone from Restock. Off Home Assistant's list too, unless it changed there since.
        if (sameSide({ s: h!.summary, c: done(h!) }, p.h)) {
          await api.remove([h!.uid]);
          // Gone from Home Assistant now too: not something new there to bring back onto Restock's list.
          byUid.delete(h!.uid);
          out.went++;
        }
        rest = rest.slice(1);
        continue;
      }
      if (!h) {
        // Gone from Home Assistant. Off Restock's list too, unless it changed here since.
        if (sameSide({ s: summaryOf(r, names), c: r.checked }, p.r)) {
          await store.removeLines([r.id]);
          byId.delete(r.id);
          out.came++;
        }
        rest = rest.slice(1);
        continue;
      }
      const rs: Side = { s: summaryOf(r, names), c: r.checked };
      const hs: Side = { s: h.summary, c: done(h) };
      // Ticks.
      const rTick = rs.c !== p.r.c;
      const hTick = hs.c !== p.h.c;
      if (hTick && !rTick && hs.c !== rs.c) {
        await store.updateLine(r.id, { checked: hs.c });
        r.checked = rs.c = hs.c;
        out.came++;
      } else if (rs.c !== hs.c) {
        await api.update(h.uid, { status: rs.c ? 'completed' : 'needs_action' });
        hs.c = rs.c;
        out.went++;
      }
      // Words.
      const rText = rs.s !== p.r.s;
      const hText = hs.s !== p.h.s;
      if (hText && !rText) {
        const said = parseLine(hs.s);
        const item = r.groupId ? names.get(r.groupId) : undefined;
        if (!r.groupId || item === undefined) {
          if (said.name !== r.text || said.qty !== r.qty) {
            await store.updateLine(r.id, { text: said.name, qty: said.qty });
            r.text = said.name;
            r.qty = said.qty;
            out.came++;
          }
          rs.s = summaryOf(r, names);
        } else if (said.key === matchKey(item)) {
          if (said.qty !== r.qty) {
            await store.updateLine(r.id, { qty: said.qty });
            r.qty = said.qty;
            out.came++;
          }
          rs.s = summaryOf(r, names);
        } else {
          // Linked to a pantry item: it keeps the item's name.
          await api.update(h.uid, { rename: rs.s });
          hs.s = rs.s;
          out.went++;
        }
      } else if (rText && rs.s !== hs.s) {
        await api.update(h.uid, { rename: rs.s });
        hs.s = rs.s;
        out.went++;
      }
      keep({ id: r.id, uid: h.uid, r: rs, h: hs });
      rest = rest.slice(1);
    }

    // 2. Lines nobody has paired: pair the same words first (open with open, ticked with ticked first).
    const looseItems = () => items.filter((h) => !pairedUids.has(h.uid) && byUid.has(h.uid));
    const looseLines = () => [...byId.values()].filter((l) => !pairedIds.has(l.id));
    const pairUp = async (h: HaItem, r: Line) => {
      const rs: Side = { s: summaryOf(r, names), c: r.checked };
      const hs: Side = { s: h.summary, c: done(h) };
      if (rs.c !== hs.c) {
        // Still to buy on either side: still to buy on both.
        if (rs.c) {
          await store.updateLine(r.id, { checked: false });
          r.checked = rs.c = false;
          out.came++;
        } else {
          await api.update(h.uid, { status: 'needs_action' });
          hs.c = false;
          out.went++;
        }
      }
      keep({ id: r.id, uid: h.uid, r: rs, h: hs });
    };
    const byWords = async () => {
      for (const sameTick of [true, false]) {
        for (const h of looseItems()) {
          const k = pairKey(h.summary);
          if (!k) continue;
          const r = looseLines().find((l) => pairKey(summaryOf(l, names)) === k && (!sameTick || l.checked === done(h)));
          if (r) await pairUp(h, r);
        }
      }
    };
    await byWords();

    // 3. New in Home Assistant (still to buy): onto Restock's list, linked to a pantry item if it's clearly one.
    for (const h of looseItems()) {
      if (done(h) || !h.summary.trim()) continue;
      const said = parseLine(h.summary);
      const found = candidates(h.summary, pantry, aliases);
      const one = found.length === 1 ? found[0] : undefined;
      // "2 Minute Noodles" is an item, not two of "Minute Noodles".
      const whole = one && matchKey(one.name) === matchKey(h.summary);
      const line: Omit<Line, 'id'> = one
        ? { text: one.name, qty: whole ? 1 : said.qty, checked: false, groupId: one.id }
        : { text: said.name, qty: said.qty, checked: false };
      const id = await store.addLine(line);
      const added: Line = { id, ...line };
      byId.set(id, added);
      keep({ id, uid: h.uid, r: { s: summaryOf(added, names), c: false }, h: { s: h.summary, c: false } });
      out.came++;
    }

    // 4. New in Restock (still to buy): onto Home Assistant's list. Its new item is paired by its words afterwards.
    const sent: Line[] = [];
    for (const l of looseLines()) {
      if (l.checked || !summaryOf(l, names).trim()) continue;
      await api.add(summaryOf(l, names));
      sent.push(l);
      out.went++;
    }
    if (sent.length) {
      for (const h of await api.items()) {
        if (!byUid.has(h.uid)) {
          byUid.set(h.uid, h);
          items.push(h);
        }
      }
      await byWords();
    }
  } finally {
    await save();
  }
  return out;
}
