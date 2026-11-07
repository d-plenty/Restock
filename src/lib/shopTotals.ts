import type { Chain, ListEntry } from '../types';
import { isBulk, lineCost, productQty, type Option, type Recommendation } from './verdict';

// What to buy for each item on the shopping list, and "what would it cost if I only went to
// one store?".
//
// Every pantry item can be bought as your product or any of its alternatives. At each store we
// take the cheapest one that store has, so a store counts for an item as long as it has *some*
// version of it (an alternative is fine when it's the only one there). Out-of-stock products are
// used only when the store has nothing else. "Cheapest" is either best value (per 100 g / per
// litre / per item) or lowest shelf price, as picked at the top of the shopping list.

type Chain3 = Exclude<Chain, 'other'>;
export type CompareBy = 'unit' | 'price';

export interface ShopLine {
  /** The pantry item's name (kept up to date if it's renamed). */
  item: string;
  groupId: string;
  /** What you'd buy: your product or an alternative, at a price. */
  pick: Option;
  /** Only an out-of-stock version is available here. */
  outOfStock: boolean;
  /** How many are on the list. */
  qty: number;
  /** Your own product (at this store if it's sold here), to explain a swap. */
  yours?: Option;
  /**
   * Like for like: the amount you usually buy, at this store's closest regular-sized pack (never
   * a bulk pack), so the same shopping can be compared store against store.
   */
  fair: number;
}

export interface MissingLine {
  item: string;
  groupId: string;
  /** The cheapest version at another store, if there is one. */
  elsewhere?: Option;
  qty: number;
}

export interface ShopTotal {
  chain: Chain3;
  total: number;
  lines: ShopLine[];
  missing: MissingLine[];
  /** This store, plus the missing items from their next best store. */
  totalWithElsewhere: number;
  /** How many of those are an alternative rather than your own product. */
  alternatives: number;
  /**
   * What the same amounts as your usual products would cost here: each line scaled from the pack
   * this store has to the size you normally buy. The lowest is the best value store; the lowest
   * total is the cheapest checkout.
   */
  value: number;
  /** The same shopping here: every line like for like (see ShopLine.fair). Decides the recommendation. */
  fair: number;
  /** How many items this store is cheapest for, like for like (a tie counts for each store in it). */
  cheapestFor: number;
  /** How many items this store is cheapest for at the till, with this list's picks. */
  cheapestForTill: number;
}

export interface ShopTotals {
  stores: ShopTotal[];
  /** Cheapest of everything, mixing stores. */
  around: { total: number; lines: ShopLine[]; missing: string[]; chains: Chain3[] };
  /** What to buy for each pantry item on the list, by group id (the "shopping around" pick). */
  pickFor: Map<string, ShopLine>;
  /** List items linked to the pantry (the ones that can be priced). */
  linked: number;
  /** Notes and hand-written items, which have no price. */
  unpriced: number;
  /** Best value or lowest price, as set at the top of the list. */
  by: CompareBy;
}

/** Is `a` a better buy than `b`? */
export function cheaperThan(a: Option, b: Option, by: CompareBy): boolean {
  const ua = productQty(a.product).unit;
  const ub = productQty(b.product).unit;
  const byUnit = by === 'unit' && a.unitPrice !== undefined && b.unitPrice !== undefined && ua !== undefined && ua === ub;
  const ca = byUnit ? a.unitPrice! : a.price!;
  const cb = byUnit ? b.unitPrice! : b.price!;
  if (Math.abs(ca - cb) > 1e-9) return ca < cb;
  return a.role === 'main' && b.role !== 'main'; // a tie goes to your own product
}

function best(opts: Option[], by: CompareBy): { pick?: Option; outOfStock: boolean } {
  const priced = opts.filter((o) => o.price !== undefined);
  const pickFrom = (list: Option[]) => list.reduce<Option | undefined>((b, o) => (!b || cheaperThan(o, b, by) ? o : b), undefined);
  const inStock = pickFrom(priced.filter((o) => o.product.inStock !== false));
  if (inStock) return { pick: inStock, outOfStock: false };
  const any = pickFrom(priced);
  return { pick: any, outOfStock: !!any };
}

/** Your usual product for an item (to size the best-value comparison). */
function usual(rec: Recommendation): Option | undefined {
  return rec.options.find((o) => o.product.id === rec.group.usualProductId) ?? rec.options.find((o) => o.role === 'main');
}

/** The cost of the amount you usually buy, at this pick's price per gram, litre or item. */
export function sameAmountCost(pick: Option, ref: Option | undefined, qty: number): number {
  const cost = lineCost(pick, qty);
  if (!ref) return cost;
  const p = productQty(pick.product);
  const r = productQty(ref.product);
  if (!p.qty || !r.qty || p.unit !== r.unit) return cost;
  return (cost * r.qty) / p.qty;
}

/** The like-for-like cost of an item at one store: its closest regular pack, scaled to the amount you usually buy. */
function fairCost(rec: Recommendation, chain: Chain3, qty: number): number | undefined {
  const here = rec.options.filter((o) => o.product.chain === chain && o.price !== undefined);
  const inStock = here.filter((o) => o.product.inStock !== false);
  const pool = inStock.length ? inStock : here;
  const regular = pool.filter((o) => !isBulk(o, rec.options, rec.group));
  const from = regular.length ? regular : pool;
  if (!from.length) return undefined;
  const ref = usual(rec);
  return Math.min(...from.map((o) => sameAmountCost(o, ref, qty)));
}

export interface Recommended {
  /** The store to go to. */
  recommended?: ShopTotal;
  /** The store with the lowest total for how the list is set (same shopping, or at the till). */
  cheapest?: ShopTotal;
  /**
   * Why the recommended store won: it's clearly the cheapest, or the totals were too close to
   * call (or one item made the difference) and it's the cheapest for more of your items.
   */
  reason?: 'cheapest' | 'more-items';
  /** Most for your money per 100 g / litre / item, like for like. */
  bestValue?: ShopTotal;
  /** The lowest checkout total with this list's picks. */
  lowest?: ShopTotal;
  /** The store compared against: the runner-up, or the cheapest when that isn't recommended. */
  runnerUp?: ShopTotal;
  /** How much the cheapest store's total is under the runner-up's (always the gap in totals). */
  saving?: number;
  /** Set when one item makes most of the difference: without it, the runner-up would be cheaper. */
  mostlyFrom?: { item: string; difference: number };
  /** The totals are within a couple of dollars (or a few per cent) of each other. */
  close?: boolean;
}

/** A gap smaller than this is too close to call: $2, or 3% of the shop, whichever is more. */
export const tooClose = (total: number) => Math.max(2, total * 0.03);

/** One line's cost for comparing stores: like for like (best value) or at the till (lowest price). */
export const lineMeasure = (l: ShopLine, by: CompareBy) => (by === 'unit' ? l.fair : lineCost(l.pick, l.qty));
const measure = (s: ShopTotal, by: CompareBy) => (by === 'unit' ? s.fair : s.total);
const countFor = (s: ShopTotal, by: CompareBy) => (by === 'unit' ? s.cheapestFor : s.cheapestForTill);

/**
 * Which single store to recommend, for how the list is set. Best value compares the same
 * shopping (every item at the size you usually buy, from regular packs, so a bulk pack can't tip
 * it). Lowest price compares what you'd pay at the till. The cheapest store wins, unless it only
 * just wins (under $2 or 3%) or one item alone makes the difference: then the store that's
 * cheapest for more of your items is recommended, so one big special at an otherwise dearer
 * store doesn't decide it. Stores missing something only count if none has everything.
 */
export function recommendedStores(t: ShopTotals, by: CompareBy = t.by): Recommended {
  const withLines = t.stores.filter((s) => s.lines.length);
  const fewestMissing = Math.min(...withLines.map((s) => s.missing.length));
  const pool = withLines.filter((s) => s.missing.length === fewestMissing);
  const complete = withLines.filter((s) => !s.missing.length);
  const lowestOf = (list: ShopTotal[], f: (s: ShopTotal) => number) =>
    list.reduce<ShopTotal | undefined>(
      (b, s) => (!b || f(s) < f(b) - 0.005 || (Math.abs(f(s) - f(b)) <= 0.005 && s.total < b.total) ? s : b),
      undefined,
    );
  const out: Recommended = { bestValue: lowestOf(complete, (s) => s.value), lowest: lowestOf(complete, (s) => s.total) };
  const cheapest = lowestOf(pool, (s) => measure(s, by));
  if (!cheapest) return out;
  out.cheapest = cheapest;
  out.recommended = cheapest;
  out.reason = 'cheapest';
  const runnerUp = lowestOf(
    pool.filter((s) => s !== cheapest),
    (s) => measure(s, by),
  );
  if (!runnerUp) return out;
  const gap = measure(runnerUp, by) - measure(cheapest, by);
  out.runnerUp = runnerUp;
  out.saving = gap;
  out.close = gap < tooClose(measure(cheapest, by)) - 0.005;
  // The item with the biggest gap in the cheapest store's favour.
  let top: { item: string; difference: number } | undefined;
  for (const l of cheapest.lines) {
    const other = runnerUp.lines.find((x) => x.groupId === l.groupId);
    if (!other) continue;
    const d = lineMeasure(other, by) - lineMeasure(l, by);
    if (!top || d > top.difference) top = { item: l.item, difference: d };
  }
  if (top && top.difference > gap + 0.005 && cheapest.lines.length > 1) out.mostlyFrom = top;
  if (out.close || out.mostlyFrom) {
    // Too close to call: the store that's cheapest for the most items, if that isn't this one.
    const most = pool.reduce((b, s) => (countFor(s, by) > countFor(b, by) ? s : b), cheapest);
    if (most !== cheapest && countFor(most, by) > countFor(cheapest, by)) {
      out.recommended = most;
      out.reason = 'more-items';
      out.runnerUp = cheapest;
    }
  }
  return out;
}

export function shopTotals(entries: ListEntry[], recs: Recommendation[], chains: Chain3[], by: CompareBy = 'unit'): ShopTotals {
  const open = entries.filter((e) => !e.checked);
  // Items that don't want bulk packs never get one picked for them.
  const usable = (rec: Recommendation) =>
    rec.group.allowBulk === false ? rec.options.filter((o) => o.role === 'main' || !isBulk(o, rec.options, rec.group)) : rec.options;
  const byGroup = new Map(recs.map((r) => [r.group.id, { ...r, options: usable(r) }]));
  const linked = open
    .map((e) => ({ rec: e.groupId ? byGroup.get(e.groupId) : undefined, qty: Math.max(1, e.qty ?? 1) }))
    .filter((x): x is { rec: Recommendation; qty: number } => !!x.rec);
  const unpriced = open.length - linked.length;

  const stores: ShopTotal[] = chains.map((chain) => {
    const t: ShopTotal = {
      chain,
      total: 0,
      lines: [],
      missing: [],
      totalWithElsewhere: 0,
      alternatives: 0,
      value: 0,
      fair: 0,
      cheapestFor: 0,
      cheapestForTill: 0,
    };
    for (const { rec, qty } of linked) {
      const here = best(
        rec.options.filter((o) => o.product.chain === chain),
        by,
      );
      if (here.pick) {
        const yours =
          best(
            rec.options.filter((o) => o.role === 'main' && o.product.chain === chain),
            by,
          ).pick ??
          best(
            rec.options.filter((o) => o.role === 'main'),
            by,
          ).pick;
        const fair = fairCost(rec, chain, qty) ?? sameAmountCost(here.pick, usual(rec), qty);
        t.lines.push({ item: rec.group.name, groupId: rec.group.id, pick: here.pick, outOfStock: here.outOfStock, qty, yours, fair });
        t.total += lineCost(here.pick, qty);
        t.fair += fair;
        t.value += sameAmountCost(here.pick, usual(rec), qty);
        if (here.pick.role === 'alt') t.alternatives++;
      } else {
        const elsewhere = best(
          rec.options.filter((o) => o.product.chain !== chain),
          by,
        ).pick;
        t.missing.push({ item: rec.group.name, groupId: rec.group.id, elsewhere, qty });
        if (elsewhere) t.totalWithElsewhere += lineCost(elsewhere, qty);
      }
    }
    t.totalWithElsewhere += t.total;
    return t;
  });

  const around: ShopTotals['around'] = { total: 0, lines: [], missing: [], chains: [] };
  const pickFor = new Map<string, ShopLine>();
  for (const { rec, qty } of linked) {
    const { pick, outOfStock } = best(rec.options, by);
    if (!pick) {
      around.missing.push(rec.group.name);
      continue;
    }
    const line: ShopLine = {
      fair: sameAmountCost(pick, usual(rec), qty),
      item: rec.group.name,
      groupId: rec.group.id,
      pick,
      outOfStock,
      qty,
      yours: best(
        rec.options.filter((o) => o.role === 'main'),
        by,
      ).pick,
    };
    around.lines.push(line);
    pickFor.set(rec.group.id, line);
    around.total += lineCost(pick, qty);
    const c = pick.product.chain as Chain3;
    if (!around.chains.includes(c)) around.chains.push(c);
  }

  // How many items each store is cheapest for, like for like and at the till.
  for (const { rec } of linked) {
    for (const key of ['cheapestFor', 'cheapestForTill'] as const) {
      const costs = stores.map((st) => {
        const l = st.lines.find((x) => x.groupId === rec.group.id);
        return l && lineMeasure(l, key === 'cheapestFor' ? 'unit' : 'price');
      });
      const low = Math.min(...costs.filter((c): c is number => c !== undefined));
      stores.forEach((st, i) => {
        if (costs[i] !== undefined && costs[i]! <= low + 0.005) st[key]++;
      });
    }
  }

  // Stores with everything first, then cheapest first for how the list is set.
  stores.sort((a, b) => a.missing.length - b.missing.length || measure(a, by) - measure(b, by) || a.total - b.total);
  return { stores, around, pickFor, linked: linked.length, unpriced, by };
}
