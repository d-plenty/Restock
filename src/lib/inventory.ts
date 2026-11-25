// 0.13.1: inventory, for people who want it: how much of each thing is at home. Off everywhere until
// it's turned on, tab by tab (Pantry, and each tab you made). Each item is counted its own way:
//
//   count     14 cans                       (minus and plus)
//   measure   300 g, 750 mL, 1.5 kg, 2 L    (what's left, by weight or volume)
//   rough     ¼, ½, ¾ or all of the pack you normally buy, plus any unopened ones (2½ bags)
//
// It's the household's, so it's kept where the household's other shared things are: rows of the synced
// household_settings table (sharedSettings.ts). Phones and servers on older versions carry rows
// they don't know as they are, so nothing about sync changes:
//
//   inv:tab:<section>   true                          inventory is on for that tab
//   inv:auto            true | false                  running out puts it on the list by itself (off: ask)
//   inv:tick            true | false                  ticking it off while shopping adds what was bought (on)
//   have:<item id>      { m, a, u?, low? }            how much there is: m = c | w | r (count, measure,
//                                                     rough), a = the amount, u = g | kg | ml | l,
//                                                     low = "running low" at or under this
//
// Sample items never leave the phone, so theirs are kept beside the database's own small values
// (kv "inv.demo"), not in the household's rows. A backup carries the rows as kv "inventory"
// (backup.ts), and a restore puts them back (restoreInventory).

import { MADE_SECTIONS, type Section } from '../shops';
import type { Group, Product } from '../types';
import { allListEntries, getGroup, getKV, getProduct, putKV, queryRows, runOps } from './db';
import type { SqlOp } from './sql/driver';

export type HaveMode = 'count' | 'measure' | 'rough';
export type HaveUnit = 'g' | 'kg' | 'ml' | 'l';
export interface Have {
  mode: HaveMode;
  /** Count: how many. Measure: how much, in `unit`. Rough: packs, in quarters (2.5 = two and a half). */
  amount: number;
  unit?: HaveUnit;
  /** Running low at or under this (same terms as amount). Missing: only "out", at nothing left. */
  low?: number;
}
export type HaveState = 'ok' | 'low' | 'out';

const INV_TAB = 'inv:tab:';
const INV_AUTO = 'inv:auto';
const INV_TICK = 'inv:tick';
const HAVE_PREFIX = 'have:';
export const INV_BACKUP_KV = 'inventory';
const DEMO_KV = 'inv.demo';
const TABLE = 'household_settings';
const ITEM_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** The tabs that can keep an inventory: Pantry and every tab you made. */
export const INVENTORY_SECTIONS: Section[] = ['pantry', ...MADE_SECTIONS];
export const UNITS: HaveUnit[] = ['g', 'kg', 'ml', 'l'];
export const UNIT_LABEL: Record<HaveUnit, string> = { g: 'g', kg: 'kg', ml: 'mL', l: 'L' };
/** What one press of minus or plus moves a measured amount by. */
export const UNIT_STEP: Record<HaveUnit, number> = { g: 50, kg: 0.25, ml: 50, l: 0.25 };
const MAX = 100000;

const MODE_OF: Record<string, HaveMode> = { c: 'count', w: 'measure', r: 'rough' };
const MODE_KEY: Record<HaveMode, string> = { count: 'c', measure: 'w', rough: 'r' };

const tidy = (n: number, mode: HaveMode): number => {
  if (!Number.isFinite(n) || n < 0) return 0;
  const v = Math.min(MAX, n);
  if (mode === 'count') return Math.round(v);
  if (mode === 'rough') return Math.round(v * 4) / 4;
  return Math.round(v * 100) / 100;
};

/** A row's value as it may be used, or undefined when it isn't one of ours. */
export function checkHave(v: unknown): Have | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const mode = typeof o.m === 'string' ? MODE_OF[o.m] : undefined;
  if (!mode || typeof o.a !== 'number' || !Number.isFinite(o.a) || o.a < 0) return undefined;
  const out: Have = { mode, amount: tidy(o.a, mode) };
  if (mode === 'measure') {
    if (typeof o.u !== 'string' || !(UNITS as string[]).includes(o.u)) return undefined;
    out.unit = o.u as HaveUnit;
  }
  if (typeof o.low === 'number' && Number.isFinite(o.low) && o.low > 0) out.low = tidy(o.low, mode);
  return out;
}

/** The row's value for an amount (the one way it's written, so two phones write the same text). */
export function encodeHave(h: Have): string {
  const mode = h.mode;
  const o: Record<string, unknown> = { m: MODE_KEY[mode], a: tidy(h.amount, mode) };
  if (mode === 'measure') o.u = h.unit ?? 'g';
  const low = h.low !== undefined ? tidy(h.low, mode) : 0;
  if (low > 0) o.low = low;
  return JSON.stringify(o);
}

const QUARTERS = ['', '¼', '½', '¾'];
/** 2.5 → "2½", 0.25 → "¼", 3 → "3", 0 → "0". */
export function roughText(amount: number): string {
  const a = tidy(amount, 'rough');
  const whole = Math.floor(a + 1e-9);
  const q = Math.round((a - whole) * 4);
  if (!whole && !q) return '0';
  return `${whole || ''}${QUARTERS[q]}`;
}

const plain = (n: number): string => (Math.round(n * 100) / 100).toLocaleString('en-AU', { maximumFractionDigits: 2 });

/** "14", "750 mL", "2½". */
export function haveText(h: Have): string {
  if (h.mode === 'rough') return roughText(h.amount);
  if (h.mode === 'measure') return `${plain(h.amount)} ${UNIT_LABEL[h.unit ?? 'g']}`;
  return plain(h.amount);
}

export function haveState(h: Have | undefined): HaveState {
  if (!h) return 'ok';
  if (h.amount <= 0) return 'out';
  return h.low !== undefined && h.low > 0 && h.amount <= h.low + 1e-9 ? 'low' : 'ok';
}

/** What the little box on a row says: "Have: 14", "Have: ¼ · running low", "Have: 0 · out". */
export function haveLabel(h: Have | undefined): string {
  if (!h) return 'How many?';
  const s = haveState(h);
  return `Have: ${haveText(h)}${s === 'low' ? ' · running low' : s === 'out' ? ' · out' : ''}`;
}

/** The open pack and the unopened ones of a rough amount: 2.5 → half open, 2 unopened; 3 → a full one open, 2 unopened. */
export function roughParts(amount: number): { open: number; unopened: number } {
  const a = tidy(amount, 'rough');
  if (a <= 0) return { open: 0, unopened: 0 };
  const whole = Math.floor(a + 1e-9);
  const part = a - whole;
  return part > 0 ? { open: part, unopened: whole } : { open: 1, unopened: whole - 1 };
}

/** One press of minus (-1) or plus (+1). */
export function stepHave(h: Have, dir: -1 | 1): Have {
  const by = h.mode === 'count' ? 1 : h.mode === 'rough' ? 0.25 : UNIT_STEP[h.unit ?? 'g'];
  return { ...h, amount: tidy(h.amount + dir * by, h.mode) };
}

/** Did this change take it to "running low" or "out" (from somewhere better)? */
export function ranLow(before: Have | undefined, after: Have): 'low' | 'out' | undefined {
  const rank = { ok: 0, low: 1, out: 2 } as const;
  const was = before ? haveState(before) : 'ok';
  const is = haveState(after);
  return rank[is] > rank[was] && is !== 'ok' ? is : undefined;
}

/** "You're out of passata" / "Passata is running low". */
export const ranLowTitle = (name: string, how: 'low' | 'out') => (how === 'out' ? `You're out of ${name}` : `${name} is running low`);

const G_PER: Record<HaveUnit, number> = { g: 1, kg: 1000, ml: 1, l: 1000 };
const KIND: Record<HaveUnit, 'g' | 'ml'> = { g: 'g', kg: 'g', ml: 'ml', l: 'ml' };

/**
 * What ticking `qty` of it off the shopping list adds. A count: that many. A rough amount: that many
 * packs. A measure: that many packs' worth, when the pack's size is known in the same kind of unit
 * (grams for g and kg, millilitres for mL and L); otherwise nothing, as Restock can't know.
 */
export function boughtAmount(h: Have, qty: number, pack?: Pick<Product, 'qty' | 'qtyUnit'>): number {
  const n = Math.max(1, Math.min(10000, Math.trunc(qty) || 1));
  if (h.mode !== 'measure') return n;
  const unit = h.unit ?? 'g';
  if (!pack?.qty || pack.qty <= 0 || pack.qtyUnit !== KIND[unit]) return 0;
  return (pack.qty * n) / G_PER[unit];
}

export interface Inventory {
  /** The tabs it's on for. */
  tabs: Set<Section>;
  /** Running out puts it on the list by itself (off: Restock asks). */
  auto: boolean;
  /** Ticking it off while shopping adds what was bought. */
  tick: boolean;
  have: Map<string, Have>;
}

export const NO_INVENTORY: Inventory = { tabs: new Set(), auto: false, tick: true, have: new Map() };

type Row = { k: string; v: string };
const parse = (v: string): unknown => {
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return undefined;
  }
};
const isDemo = (id: string) => id.startsWith('demo-');

/** The rows as an inventory (pure: the tests and the web use it too). */
export function inventoryFrom(rows: Row[], demo?: Record<string, unknown>): Inventory {
  const inv: Inventory = { tabs: new Set(), auto: false, tick: true, have: new Map() };
  for (const r of rows) {
    const v = parse(r.v);
    if (r.k.startsWith(INV_TAB)) {
      const s = r.k.slice(INV_TAB.length) as Section;
      if (v === true && INVENTORY_SECTIONS.includes(s)) inv.tabs.add(s);
    } else if (r.k === INV_AUTO) inv.auto = v === true;
    else if (r.k === INV_TICK) inv.tick = v !== false;
    else if (r.k.startsWith(HAVE_PREFIX)) {
      const id = r.k.slice(HAVE_PREFIX.length);
      const h = ITEM_ID.test(id) && !isDemo(id) ? checkHave(v) : undefined;
      if (h) inv.have.set(id, h);
    }
  }
  for (const [id, v] of Object.entries(demo ?? {})) {
    const h = isDemo(id) ? checkHave(v) : undefined;
    if (h) inv.have.set(id, h);
  }
  return inv;
}

async function invRows(): Promise<Row[]> {
  return queryRows<Row>(`SELECT k, v FROM ${TABLE} WHERE k LIKE 'inv:%' OR k LIKE 'have:%'`).catch(() => []);
}
const demoHave = async (): Promise<Record<string, unknown>> => {
  const d = await getKV<Record<string, unknown>>(DEMO_KV).catch(() => undefined);
  return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
};

export async function loadInventory(): Promise<Inventory> {
  return inventoryFrom(await invRows(), await demoHave());
}

const put = (k: string, v: string): SqlOp => ({ sql: `INSERT OR REPLACE INTO ${TABLE} (k, v) VALUES (?, ?)`, params: [k, v] });
const drop = (k: string): SqlOp => ({ sql: `DELETE FROM ${TABLE} WHERE k = ?`, params: [k] });

/** Inventory on or off for a tab. Off keeps the amounts, so turning it back on finds them. */
export async function setInventoryTab(section: Section, on: boolean): Promise<void> {
  if (!INVENTORY_SECTIONS.includes(section)) return;
  await runOps([on ? put(INV_TAB + section, 'true') : drop(INV_TAB + section)]);
}

/** The Settings page's Save: the tabs it's on for and the two choices, in one write. */
export async function saveInventorySettings(next: { tabs: Iterable<Section>; auto: boolean; tick: boolean }): Promise<void> {
  const on = new Set(next.tabs);
  const ops: SqlOp[] = INVENTORY_SECTIONS.map((s) => (on.has(s) ? put(INV_TAB + s, 'true') : drop(INV_TAB + s)));
  ops.push(put(INV_AUTO, JSON.stringify(!!next.auto)), put(INV_TICK, JSON.stringify(!!next.tick)));
  await runOps(ops);
}

/** How much there is of an item, saved (undefined: not counted any more). */
export async function saveHave(itemId: string, h: Have | undefined): Promise<void> {
  if (!ITEM_ID.test(itemId)) return;
  if (isDemo(itemId)) {
    const d = { ...(await demoHave()) };
    if (h) d[itemId] = JSON.parse(encodeHave(h)) as unknown;
    else delete d[itemId];
    return putKV(DEMO_KV, d);
  }
  await runOps([h ? put(HAVE_PREFIX + itemId, encodeHave(h)) : drop(HAVE_PREFIX + itemId)]);
}

/**
 * A line ticked off the shopping list (or unticked): what was bought is added to what's at home (or
 * taken back off). Only for an item on a tab with inventory on, with "count what I tick off" on. An
 * item that hasn't been counted yet starts as a count. Never below nothing.
 */
export function haveAfterTick(
  inv: Inventory,
  group: Pick<Group, 'id' | 'section'> | undefined,
  qty: number | undefined,
  ticked: boolean,
  pack?: Pick<Product, 'qty' | 'qtyUnit'>,
): Have | undefined {
  if (!group || !inv.tick || !inv.tabs.has(group.section ?? 'pantry')) return undefined;
  const was = inv.have.get(group.id) ?? (ticked ? { mode: 'count' as const, amount: 0 } : undefined);
  if (!was) return undefined;
  const by = boughtAmount(was, qty ?? 1, pack);
  if (!by) return undefined;
  const next: Have = { ...was, amount: tidy(was.amount + (ticked ? by : -by), was.mode) };
  return next.amount === was.amount && inv.have.has(group.id) ? undefined : next;
}

/**
 * Lines ticked (or unticked) on this device: their items' amounts follow. Call it inside the tick's
 * own action, so one Undo takes both back. Only the device that ticks counts it, so a household's
 * phones never count the same tick twice.
 */
export async function countTicks(entryIds: string[], ticked: boolean): Promise<void> {
  const inv = await loadInventory();
  if (!inv.tick || !inv.tabs.size || !entryIds.length) return;
  const ids = new Set(entryIds);
  for (const e of (await allListEntries()).filter((x) => ids.has(x.id) && x.groupId)) {
    const group = await getGroup(e.groupId!);
    if (!group) continue;
    const was = inv.have.get(group.id);
    const pack = was?.mode === 'measure' && group.usualProductId ? await getProduct(group.usualProductId) : undefined;
    const next = haveAfterTick(inv, group, e.qty, ticked, pack);
    if (!next) continue;
    await saveHave(group.id, next);
    inv.have.set(group.id, next);
  }
}

// ---------- backups ----------

/** For a backup: the inventory's rows (not the sample items'), or undefined when there's nothing. */
export async function inventoryForBackup(): Promise<Record<string, string> | undefined> {
  const rows = await invRows();
  return rows.length ? Object.fromEntries(rows.map((r) => [r.k, r.v])) : undefined;
}

/**
 * A restored backup's inventory goes back into rows. `raw` is what the backup carried (kv
 * "inventory"); when it isn't given, what a whole-phone restore left in kv is used. Only for items
 * that are here afterwards (and, for a part restore, on the tabs restored); the two choices only with
 * the settings. Amounts of items that are gone are tidied away. Anything odd in the file is left out.
 */
export async function restoreInventory(opts: { raw?: unknown; sections?: Section[]; settings?: boolean } = {}): Promise<number> {
  const inKv = await getKV<unknown>(INV_BACKUP_KV).catch(() => undefined);
  const raw = opts.raw !== undefined ? opts.raw : inKv;
  const groups = new Map((await queryRows<{ id: string; section: string | null }>('SELECT id, section FROM items').catch(() => [])).map((g) => [g.id, (g.section ?? 'pantry') as Section]));
  const inScope = (sec: Section) => !opts.sections || opts.sections.includes(sec);
  const ops: SqlOp[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== 'string' || v.length > 400) continue;
      const val = parse(v);
      if (k.startsWith(INV_TAB)) {
        const sec = k.slice(INV_TAB.length) as Section;
        if (INVENTORY_SECTIONS.includes(sec) && val === true && inScope(sec)) ops.push(put(k, 'true'));
      } else if (k === INV_AUTO || k === INV_TICK) {
        if (typeof val === 'boolean' && opts.settings !== false) ops.push(put(k, JSON.stringify(val)));
      } else if (k.startsWith(HAVE_PREFIX)) {
        const id = k.slice(HAVE_PREFIX.length);
        const sec = groups.get(id);
        const h = ITEM_ID.test(id) && !isDemo(id) && sec && inScope(sec) ? checkHave(val) : undefined;
        if (h) ops.push(put(k, encodeHave(h)));
      }
    }
  }
  const n = ops.length;
  for (const r of await invRows()) if (r.k.startsWith(HAVE_PREFIX) && !groups.has(r.k.slice(HAVE_PREFIX.length))) ops.push(drop(r.k));
  if (inKv !== undefined) ops.push({ sql: 'DELETE FROM kv WHERE key = ?', params: [INV_BACKUP_KV] });
  if (ops.length) await runOps(ops);
  return n;
}
