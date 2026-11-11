// 0.9.3: household-wide settings, the rules (no database here, so the phone app, the web app's
// engine and the tests all use the same code). SharedSettings.java is the phones' twin: change
// both together (tools/sync-test web-parity checks they agree).
//
// They're kept in the synced household_settings table, one row per setting (k → v, v is JSON):
//
//   shopAroundMin         number (0–1000)          "Shop around" only when it saves at least this
//   defaultThresholdPct   number (1–90)            alert level for new items
//   listCompare           "unit" | "price"         the list's cheapest: per 100 g, or shelf price
//   productOrder          "size" | "cheapest" | "name"
//   recalls.enabled       true | false             recall alerts
//   tab:keg, tab:pharmacy true | false             the tab switched on
//   shop:<chain>          { on }                   a built-in shop picked (on) or not, for its tab
//   shop:custom-…         { on, shop, removed? }   a shop someone added: its name, website, tab
//
// - One row per setting and per shop, and the later change wins per row (sync's usual rule), so
//   two people changing different settings, or picking different shops, both keep their change.
//   Anyone in the household (and the web app) may change them; no owner signature.
// - Which shop (chain) is picked is the household's; the branch (StoreChoice: primary and second
//   store, store numbers, map ids) stays each phone's own, so a chain the household turns on keeps
//   this phone's branch for it (or none yet). There's no "main shop" in the settings beyond the
//   branch picked as Primary, which is a branch, so it stays on the phone.
// - Only the tabs this phone syncs (the household shares them and the phone takes them): shop:
//   and tab: rows of any other tab are never stored or applied here, so they don't overwrite the
//   phone's own choices for that tab.
// - The owner phone seeds the rows once, from its own settings (SharedSettings.java seed), as the
//   oldest possible change (stamp 1), so any real change made anywhere wins over the seed.
// - Leaving the household (or being removed) deletes the rows on that phone and keeps its
//   settings as they are now (alias: and keep: rows below stay, as they're about its own things).
//
// The same table also carries a few rows that aren't settings (the shopping list's, listPicks.ts).
// applyRows passes over them (checkValue says no), and so does SharedSettings.java; phones on
// 0.9.2 or older never see the table at all. Checked strictly by checkListRow:
//
//   alias:<words>         "<item id>"              "Always use this for 'milk'": these words (haMatch
//                                                  matchKey) are that pantry item, on every phone
//   keep:<line id>        true                     "Keep it as just 'milk'": that list line shows no
//                                                  "Pick my milk" button anywhere (goes with the line)
//   ha:phone              "<device id>"            the one phone in the household that syncs the
//                                                  shopping list with Home Assistant
//
// 0.9.4: one more kind of setting, written by the web app (never seeded):
//
//   branch:<chain>        { name, storeNo? }       the household's default branch of a shop, used by
//                                                  a phone that hasn't picked its own (StoreChoice
//                                                  primary empty, or still the default it took)

import { SHOPS, isLocalOnlyShop, shopDef, type CustomShop, type Section } from '../shops';
import { siteOf } from './site';

export const ALL_TABS: Section[] = ['pantry', 'keg', 'pharmacy'];

/** Settings that are the household's (a row each), besides the shops and tabs. */
export const SCALAR_KEYS = ['shopAroundMin', 'defaultThresholdPct', 'listCompare', 'productOrder', 'recalls.enabled'] as const;
export type ScalarKey = (typeof SCALAR_KEYS)[number];

/** What a missing setting means (types.ts DEFAULT_SETTINGS). */
export const DEFAULTS = {
  shopAroundMin: 1,
  defaultThresholdPct: 10,
  listCompare: 'unit',
  productOrder: 'size',
  'recalls.enabled': true,
  enabledChains: ['woolworths', 'coles', 'aldi'],
} as const;

const CUSTOM_ID = /^custom-[A-Za-z0-9_-]{1,40}$/;
const ORIGIN = /^https?:\/\/[^\s/?#]+/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** A built-in shop's id (not one people added). */
// 0.9.6: Costco is this phone's own (shops.ts LOCAL_ONLY_SHOPS), never a household shop.
export const builtIn = (id: string): boolean => !id.startsWith('custom-') && !!shopDef(id) && !isLocalOnlyShop(id);

/** The built-in shops on a tab, in shops.ts order. */
export const builtInsOn = (tab: string): string[] => SHOPS.filter((s) => s.section === tab && !isLocalOnlyShop(s.id)).map((s) => s.id);

/** A row's value, decoded, or undefined when it isn't JSON. */
export function decode(v: string | null | undefined): unknown {
  if (typeof v !== 'string') return undefined;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The host of an address a shop row may carry (lower case, without its port), or undefined: not
 * http(s), a sign-in part (user@), or no dot in it (as site.ts asHttps turns those down).
 */
function hostOf(url: string): string | undefined {
  const m = ORIGIN.exec(url);
  if (!m) return undefined;
  const auth = m[0].replace(/^https?:\/\//i, '');
  if (auth.includes('@')) return undefined;
  const host = auth.replace(/:\d*$/, '').toLowerCase();
  return host.includes('.') ? host : undefined;
}

/** A shop someone added, as a row carries it, checked (SharedSettings.java checkShop). */
export function checkShop(v: unknown, id: string): CustomShop | undefined {
  if (!isObj(v) || v.id !== id || !CUSTOM_ID.test(id)) return undefined;
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  let website = typeof v.website === 'string' ? v.website.trim() : '';
  const section = typeof v.section === 'string' && (ALL_TABS as string[]).includes(v.section) ? (v.section as Section) : undefined;
  const host = hostOf(website);
  if (!name || name.length > 80 || !website || website.length > 500 || !host || !section) return undefined;
  // As settingsCheck.ts keeps it: an http address moves to https.
  if (/^http:\/\//i.test(website)) website = 'https://' + website.slice(7);
  const out: CustomShop = { id: id as CustomShop['id'], name, website, section, createdAt: '' };
  // Its search page only on its own site (site.ts searchOnSite: the same site, so www. or
  // search. of it too), with {q} where the words go; an http one moves to https.
  let search: string | undefined;
  if (typeof v.search === 'string') {
    const s = v.search.trim();
    const sh = s.length <= 500 && s.includes('{q}') ? hostOf(s) : undefined;
    if (sh && siteOf(sh) === siteOf(host)) search = s.replace(/^http:\/\//i, 'https://');
  }
  const createdAt = typeof v.createdAt === 'string' && v.createdAt.length <= 40 ? v.createdAt : '';
  // The order settingsCheck.ts writes them in.
  return search !== undefined ? { id: out.id, name, website, section, search, createdAt } : { id: out.id, name, website, section, createdAt };
}

const SHOP_FIELDS = ['id', 'name', 'website', 'section', 'search', 'createdAt'] as const;
/** The same shop, field by field (a missing search is the same as none). */
export function sameShop(a: Obj, b: Obj): boolean {
  return SHOP_FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));
}

export const BRANCH_PREFIX = 'branch:';

/** 0.9.4: a branch:<chain> row's value, checked (SharedSettings.java checkBranch), or undefined. */
export function checkBranch(k: string, v: unknown): { name: string; storeNo?: string } | undefined {
  if (!k.startsWith(BRANCH_PREFIX)) return undefined;
  const id = k.slice(BRANCH_PREFIX.length);
  if (!builtIn(id) && !CUSTOM_ID.test(id)) return undefined;
  if (!isObj(v) || typeof v.name !== 'string') return undefined;
  const name = v.name.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return undefined;
  if (v.storeNo === undefined || v.storeNo === null) return { name };
  return typeof v.storeNo === 'string' && /^[A-Za-z0-9 _-]{1,16}$/.test(v.storeNo) ? { name, storeNo: v.storeNo } : undefined;
}

/** A setting's value as it may be applied, or undefined when it can't be (wrong kind, out of range, unknown key). */
export function checkValue(k: string, v: unknown): unknown {
  switch (k) {
    case 'shopAroundMin':
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000 ? v : undefined;
    case 'defaultThresholdPct':
      return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 90 ? v : undefined;
    case 'listCompare':
      return v === 'unit' || v === 'price' ? v : undefined;
    case 'productOrder':
      return v === 'size' || v === 'cheapest' || v === 'name' ? v : undefined;
    case 'recalls.enabled':
    case 'tab:keg':
    case 'tab:pharmacy':
      return typeof v === 'boolean' ? v : undefined;
  }
  if (k.startsWith(BRANCH_PREFIX)) return checkBranch(k, v);
  if (!k.startsWith('shop:') || !isObj(v) || typeof v.on !== 'boolean') return undefined;
  const id = k.slice(5);
  if (builtIn(id)) return { on: v.on };
  const shop = checkShop(v.shop, id);
  if (!shop) return undefined;
  return v.removed === true ? { on: false, removed: true, shop } : { on: v.on, shop };
}

// ---------- the shopping list's rows (not settings) ----------

export const ALIAS_PREFIX = 'alias:';
export const KEEP_PREFIX = 'keep:';
export const HA_PHONE = 'ha:phone';
/** Ids of items, list lines and phones: what Restock makes (uuids, "ha-" + a uuid, 16 hex), nothing odd. */
const ROW_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** An alias's words as matchKey leaves them: letters and numbers of any language, single spaces. */
const WORDS = /^[\p{L}\p{N}\p{M}]+(?: [\p{L}\p{N}\p{M}]+)*$/u;

/** A row of the shopping list's (alias:, keep:, ha:phone) rather than a setting. */
export const isListRow = (k: string): boolean => k.startsWith(ALIAS_PREFIX) || k.startsWith(KEEP_PREFIX) || k === HA_PHONE;

/**
 * A shopping-list row's value as it may be used (the item id, true, the device id), or undefined
 * when the row isn't right: an odd key, a value of the wrong kind or shape, a sample item or line
 * (they never leave the phone that has them), a browser named as the Home Assistant phone.
 */
export function checkListRow(k: string, v: unknown): string | true | undefined {
  if (k.startsWith(ALIAS_PREFIX)) {
    const words = k.slice(ALIAS_PREFIX.length);
    if (!words || words.length > 80 || !WORDS.test(words) || words !== words.toLowerCase()) return undefined;
    return typeof v === 'string' && ROW_ID.test(v) && !v.startsWith('demo-') ? v : undefined;
  }
  if (k.startsWith(KEEP_PREFIX)) {
    const id = k.slice(KEEP_PREFIX.length);
    return ROW_ID.test(id) && !id.startsWith('demo-') && v === true ? true : undefined;
  }
  if (k === HA_PHONE) return typeof v === 'string' && ROW_ID.test(v) && !v.startsWith('web-') ? v : undefined;
  return undefined;
}

// ---------- what another device's change to the table may be ----------

/** The longest key, and value (its JSON text), a row may have (a shop someone added is well under). */
export const ROW_KEY_MAX = 200;
export const ROW_VALUE_MAX = 4000;
/** How many alias: rows, and how many keep: rows, a device takes in; and how many rows in all. */
export const LIST_ROWS_MAX = 2000;
export const ROWS_MAX = 5000;

/** What a change needs to know about the table as it is now (one per apply, so it's counted once). */
export interface SettingsRoom {
  has(k: string): boolean;
  /** Rows whose key starts with `prefix` ('' for all of them). */
  count(prefix: string): number;
  /** A new row was taken in. */
  added(k: string): void;
}

/** A shopping-list row's key as Restock makes it (alias: words, keep: a line id, ha:phone). */
function listKeyOk(k: string): boolean {
  if (k === HA_PHONE) return true;
  // Any value that's right will do: only the key is looked at here.
  return checkListRow(k, k.startsWith(KEEP_PREFIX) ? true : 'x') !== undefined;
}

/**
 * 0.9.3: whether a change to household_settings that came from another device (or a browser) is
 * taken in (WebSyncEngine.apply; SharedSettings.java acceptable is the same, line by line). Rows of
 * settings this version doesn't know still come across (a newer phone's), within the sizes above;
 * the shopping list's rows only exactly as Restock writes them; and a flood of new rows stops at
 * the limits (a row already there can always change, and a delete always goes).
 */
export function settingChangeOk(pk: string, row: unknown, deleted: boolean, room: SettingsRoom): boolean {
  if (!pk || pk.length > ROW_KEY_MAX) return false;
  const list = isListRow(pk);
  if (list && !listKeyOk(pk)) return false;
  if (deleted) return true;
  if (!row || typeof row !== 'object') return false;
  const { k, v } = row as { k?: unknown; v?: unknown };
  if (k !== pk || typeof v !== 'string' || v.length > ROW_VALUE_MAX) return false;
  if (list) {
    const ok = checkListRow(pk, decode(v));
    if (ok === undefined || v !== JSON.stringify(ok)) return false;
  }
  // 0.9.4: a default branch only of the right shape.
  if (pk.startsWith(BRANCH_PREFIX) && checkBranch(pk, decode(v)) === undefined) return false;
  if (room.has(pk)) return true;
  const kind = pk.startsWith(ALIAS_PREFIX) ? ALIAS_PREFIX : pk.startsWith(KEEP_PREFIX) ? KEEP_PREFIX : '';
  if ((kind && room.count(kind) >= LIST_ROWS_MAX) || room.count('') >= ROWS_MAX) return false;
  room.added(pk);
  return true;
}

/** Which tab a row is about (tab: and shop: rows), or null when it's the whole household's. */
export function settingTab(k: string, v: string | null | undefined): string | null {
  if (k.startsWith('tab:')) return k.slice(4);
  // 0.9.4: a default branch is about its shop's tab (a shop someone added: left alone).
  if (k.startsWith(BRANCH_PREFIX)) {
    const b = k.slice(BRANCH_PREFIX.length);
    return builtIn(b) ? shopDef(b)!.section : 'unknown';
  }
  if (!k.startsWith('shop:')) return null;
  const id = k.slice(5);
  if (builtIn(id)) return shopDef(id)!.section;
  const d = decode(v);
  const shop = isObj(d) ? d.shop : undefined;
  const sec = isObj(shop) && typeof shop.section === 'string' ? shop.section : null;
  // A row that doesn't say: no tab this phone shares (so it's left alone).
  return sec ?? 'unknown';
}

/** The same row value (a shop's fields compared one by one). */
function same(a: unknown, b: unknown): boolean {
  if (isObj(a) && isObj(b)) {
    if (a.on !== b.on || (a.removed === true) !== (b.removed === true)) return false;
    if (isObj(a.shop) || isObj(b.shop)) return isObj(a.shop) && isObj(b.shop) && sameShop(a.shop, b.shop);
    return true;
  }
  return a === b;
}

/**
 * Applies the household's rows to a settings object (stored or merged), for the tabs this phone
 * syncs. Changes the object; true when something changed. A missing field counts as its default,
 * and is only written when a row changes it. The rows go in key order, so every phone ends up with
 * the same order of shops. SharedSettings.java apply is the same, line by line.
 * The Keg tab is only switched on where this device has said it's 18 or over (adultConfirmed), or
 * `opts.adult` (the web app, and the household's own view of its settings).
 */
export function applyRows(s: Obj, rows: { k: string; v: string }[], tabs: ReadonlySet<string>, opts: { adult?: boolean } = {}): boolean {
  let changed = false;
  const adult = opts.adult ?? s.adultConfirmed === true;
  const sorted = [...rows].sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  for (const { k, v } of sorted) {
    const val = checkValue(k, decode(v));
    if (val === undefined) continue;
    const tab = settingTab(k, v);
    if (tab !== null && !tabs.has(tab)) continue;
    if (k === 'recalls.enabled') {
      const r = isObj(s.recalls) ? s.recalls : {};
      const now = typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS['recalls.enabled'];
      if (now !== val) {
        s.recalls = { ...r, enabled: val };
        changed = true;
      }
    } else if ((SCALAR_KEYS as readonly string[]).includes(k)) {
      const now = s[k] ?? DEFAULTS[k as ScalarKey];
      if (now !== val) {
        s[k] = val;
        changed = true;
      }
    } else if (k.startsWith('tab:')) {
      const sec = isObj(s.sections) ? s.sections : {};
      // 18+: Keg isn't shown on a phone that hasn't confirmed it (switching it off always applies).
      if (k === 'tab:keg' && val === true && !adult) continue;
      if ((sec[tab!] === true) !== val) {
        s.sections = { keg: sec.keg === true, pharmacy: sec.pharmacy === true, [tab!]: val };
        changed = true;
      }
    } else if (k.startsWith(BRANCH_PREFIX)) {
      // 0.9.4: the household's default branch, only where this phone hasn't picked its own.
      const id = k.slice(BRANCH_PREFIX.length);
      const b = val as { name: string; storeNo?: string };
      const stores = isObj(s.stores) ? s.stores : {};
      const cur = isObj(stores[id]) ? stores[id] : {};
      if (!cur.primary || cur.primary === cur.householdBranch) {
        const next: Obj = { ...cur, primary: b.name, householdBranch: b.name };
        if (id === 'coles' && b.storeNo && (!cur.branchStoreNo || cur.branchStoreNo === cur.householdStoreNo)) {
          next.branchStoreNo = b.storeNo;
          next.householdStoreNo = b.storeNo;
        }
        if (JSON.stringify(next) !== JSON.stringify(cur)) {
          s.stores = { ...stores, [id]: next };
          changed = true;
        }
      }
    } else {
      const id = k.slice(5);
      const x = val as { on: boolean; removed?: boolean; shop?: CustomShop };
      const chains: string[] = Array.isArray(s.enabledChains)
        ? (s.enabledChains as unknown[]).filter((c): c is string => typeof c === 'string')
        : [...DEFAULTS.enabledChains];
      if (x.on && !chains.includes(id)) {
        s.enabledChains = [...chains, id];
        changed = true;
      } else if (!x.on && chains.includes(id)) {
        s.enabledChains = chains.filter((c) => c !== id);
        changed = true;
      }
      if (x.shop) {
        const list: Obj[] = Array.isArray(s.customShops) ? (s.customShops as unknown[]).filter(isObj) : [];
        const at = list.findIndex((c) => c.id === id);
        const shop = x.shop as unknown as Obj;
        let next: Obj[] | undefined;
        if (x.removed) {
          if (at >= 0) next = list.filter((c) => c.id !== id);
        } else if (at < 0) next = [...list, shop];
        else if (!sameShop(list[at], shop)) next = list.map((c, i) => (i === at ? shop : c));
        if (next) {
          s.customShops = next;
          changed = true;
        }
      }
    }
  }
  return changed;
}

/** The value a row would have for this setting, from a settings object (merged settings). */
function valueOf(s: Obj, k: string): unknown {
  if (k === 'recalls.enabled') return isObj(s.recalls) && typeof s.recalls.enabled === 'boolean' ? s.recalls.enabled : DEFAULTS['recalls.enabled'];
  if ((SCALAR_KEYS as readonly string[]).includes(k)) return s[k] ?? DEFAULTS[k as ScalarKey];
  if (k.startsWith('tab:')) return isObj(s.sections) ? s.sections[k.slice(4)] === true : false;
  const id = k.slice(5);
  const chains: readonly unknown[] = Array.isArray(s.enabledChains) ? (s.enabledChains as unknown[]) : DEFAULTS.enabledChains;
  const on = chains.includes(id);
  if (builtIn(id)) return { on };
  const shop = (Array.isArray(s.customShops) ? (s.customShops as unknown[]) : []).find((c) => isObj(c) && c.id === id);
  return shop ? { on, shop: checkShop(shop, id) } : undefined;
}

/** Every household setting key a settings object has, for these tabs. */
export function keysFor(s: Obj, tabs: ReadonlySet<string>): string[] {
  const out: string[] = [...SCALAR_KEYS];
  for (const t of ['keg', 'pharmacy']) if (tabs.has(t)) out.push('tab:' + t);
  for (const t of ALL_TABS) if (tabs.has(t)) for (const id of builtInsOn(t)) out.push('shop:' + id);
  for (const c of Array.isArray(s.customShops) ? (s.customShops as unknown[]) : [])
    if (isObj(c) && typeof c.id === 'string' && typeof c.section === 'string' && tabs.has(c.section) && checkShop(c, c.id)) out.push('shop:' + c.id);
  return out;
}

/**
 * The rows to write when this phone's settings change from `before` to `next` (the Settings
 * screens): only household settings that changed, for the tabs it syncs, and only where the row
 * doesn't already say so. A shop someone added that's gone from `next` is written as removed.
 */
export function changedRows(before: Obj, next: Obj, tabs: ReadonlySet<string>, have: ReadonlyMap<string, string>): [string, string][] {
  const out: [string, string][] = [];
  const keys = new Set([...keysFor(before, tabs), ...keysFor(next, tabs)]);
  for (const k of keys) {
    const a = valueOf(before, k);
    let b = valueOf(next, k);
    if (same(a, b)) continue;
    if (b === undefined) {
      // A shop someone added, deleted on this phone.
      const shop = (a as { shop?: CustomShop } | undefined)?.shop;
      if (!shop) continue;
      b = { on: false, removed: true, shop };
    }
    if (checkValue(k, b) === undefined) continue;
    const tab = settingTab(k, JSON.stringify(b));
    if (tab !== null && !tabs.has(tab)) continue;
    const had = have.get(k);
    if (had !== undefined && same(checkValue(k, decode(had)), checkValue(k, b))) continue;
    out.push([k, JSON.stringify(b)]);
  }
  return out;
}

/** The tabs a phone syncs: what it picked (sync_meta "tabs", all if not set) of what the household shares (household "tabs"). */
export function syncedTabs(mine: string | null | undefined, household: string | null | undefined): Set<Section> {
  const parse = (s: string | null | undefined) => (s === null || s === undefined ? new Set(ALL_TABS) : new Set(s.split(',').map((x) => x.trim()).filter((x): x is Section => (ALL_TABS as string[]).includes(x))));
  const a = parse(mine);
  const b = parse(household);
  return new Set(ALL_TABS.filter((t) => a.has(t) && b.has(t)));
}
