import type { Chain, ListEntry } from '../types';
import { inSheets, rollsIn } from './units';
import { notAtChains } from './picks';
import { isBulk, lineCost, productQty, type Option, type Recommendation } from './verdict';

// What to buy for each item on the shopping list, and "what would it cost if I only went to
// one store?".
//
// Each pantry item has its picks at each shop (picks.ts, 0.8.9). At each store we take the cheapest
// of your picks there, so a store counts for an item when it has one of them. "Would also take"
// products never count here: they're for Swap & save. With "Any size", any of your picks there in
// any number will do, and we take the cheapest way to get the amount you usually buy. Out-of-stock
// products are used only when the store has nothing else. "Cheapest" is either best value (per 100 g / per
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
  /** With "Any size": how many of this pack to buy (already in qty), to get the amount you usually buy. */
  packs?: number;
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
  /** How many to buy there: as many as are on the list, or with "Any size" the packs it takes. */
  qty: number;
  /** You've said you don't buy it at this store ("Not at this shop"). */
  notHere?: boolean;
}

export interface ShopTotal {
  chain: Chain3;
  total: number;
  lines: ShopLine[];
  missing: MissingLine[];
  /** This store, plus the missing items from their next best store. */
  totalWithElsewhere: number;
  /** The missing items from their next best store, like for like (see ShopLine.fair). */
  elsewhereFair: number;
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
  /** 0.9.0: what the list's one-off buys with a price add to this total (the same at every store, see ShopTotals.oneOffs). */
  oneOffs: number;
}

export interface ShopTotals {
  stores: ShopTotal[];
  /** Cheapest of everything, mixing stores. */
  around: { total: number; lines: ShopLine[]; missing: string[]; chains: Chain3[] };
  /** What to buy for each pantry item on the list, by group id (the "shopping around" pick). */
  pickFor: Map<string, ShopLine>;
  /** List items linked to the pantry (the ones that can be priced). */
  linked: number;
  /** Notes and hand-written items with no price. */
  unpriced: number;
  /**
   * 0.9.0: one-off buys with a price (found at a shop for this trip), at one of these shops or any
   * shop. They're bought where you said whichever store you pick, so each counts the same in every
   * store's total and in shopping around: the totals match "Start shopping · about $X", and stores
   * still compare on your pantry items.
   */
  oneOffs: { count: number; total: number };
  /** Best value or lowest price, as set at the top of the list. */
  by: CompareBy;
}

/**
 * Is `a` a better buy than `b`, for `qty` of them? A multi-buy ("2 for $6") only counts when the
 * list has enough to get it (0.8.9): for one Ritz, Coles' $3.50 shelf price is what you pay, not
 * the $2.80 each of buying two, so the $3 at Woolworths is the better buy.
 */
export function cheaperThan(a: Option, b: Option, by: CompareBy, qty = 1): boolean {
  const [qa, qb] = alike(a, b);
  const each = (o: Option) => lineCost(o, qty) / qty;
  const perUnit = (o: Option, q: Qty) => (q.qty ? each(o) / q.qty : undefined);
  const pa = perUnit(a, qa);
  const pb = perUnit(b, qb);
  const byUnit = by === 'unit' && pa !== undefined && pb !== undefined && qa.unit !== undefined && qa.unit === qb.unit;
  const ca = byUnit ? pa! : each(a);
  const cb = byUnit ? pb! : each(b);
  if (Math.abs(ca - cb) > 1e-9) return ca < cb;
  return a.role === 'main' && b.role !== 'main'; // a tie goes to your own product
}

type Got = { pick?: Option; outOfStock: boolean; packs?: number };

function best(opts: Option[], by: CompareBy, qty = 1): Got {
  const priced = opts.filter((o) => o.price !== undefined);
  const pickFrom = (list: Option[]) => list.reduce<Option | undefined>((b, o) => (!b || cheaperThan(o, b, by, qty) ? o : b), undefined);
  const inStock = pickFrom(priced.filter((o) => o.product.inStock !== false));
  if (inStock) return { pick: inStock, outOfStock: false };
  const any = pickFrom(priced);
  return { pick: any, outOfStock: !!any };
}

/**
 * "Any size": the cheapest way to get at least `qty` times the amount you usually buy, from any one
 * of these packs, as many as it takes (three 500 g bags for 1.5 kg). A pack whose amount can't be
 * set against your usual one counts as one per item on the list, as it would on "This size", so a
 * shop's total and the list's pick always agree. With your usual amount unknown, it's best().
 */
function anySize(opts: Option[], ref: Option | undefined, by: CompareBy, qty: number): Got {
  const want = ref && productQty(ref.product);
  const priced = opts.filter((o) => o.price !== undefined);
  if (!ref || !want?.qty) return best(opts, by, qty);
  const ways = priced.map((o) => {
    const [q, r] = alike(o, ref);
    if (!q.qty || !r.qty || q.unit !== r.unit) return { o, packs: qty, cost: lineCost(o, qty), sized: false };
    const packs = Math.max(1, Math.ceil((r.qty * qty) / q.qty - 1e-9));
    return { o, packs, cost: lineCost(o, packs), sized: true };
  });
  if (!ways.length) return best(opts, by, qty);
  const pickFrom = (list: typeof ways) =>
    list.reduce<(typeof ways)[number] | undefined>(
      (b, w) => (!b || w.cost < b.cost - 1e-9 || (Math.abs(w.cost - b.cost) <= 1e-9 && w.packs < b.packs) ? w : b),
      undefined,
    );
  const inStock = pickFrom(ways.filter((w) => w.o.product.inStock !== false));
  const way = inStock ?? pickFrom(ways);
  return { pick: way!.o, outOfStock: !inStock, packs: way!.sized ? way!.packs : undefined };
}

/** Your usual product for an item (to size the best-value comparison). */
function usual(rec: Recommendation): Option | undefined {
  return rec.options.find((o) => o.product.id === rec.group.usualProductId) ?? rec.options.find((o) => o.role === 'main');
}

type Qty = ReturnType<typeof productQty>;

/**
 * Two products' amounts, measured the same way. Toilet paper is the catch (0.8.9): one shop says
 * "4,320 sheets", another "48 pack", and both read as a count, so a 48-pack came out as costing
 * 90 times the 24-pack. A size in sheets set against one in packs is counted in rolls on both
 * sides ("… 24 Pack"); when the rolls can't be told, they aren't compared by amount at all.
 */
export function alike(a: Option, b: Option): [Qty, Qty] {
  const qa = productQty(a.product);
  const qb = productQty(b.product);
  const sheets = (o: Option) => !o.product.qty && inSheets(o.product.size);
  const sa = sheets(a);
  const sb = sheets(b);
  if (sa === sb) return [qa, qb];
  const rolls = (o: Option, q: Qty, isSheets: boolean): Qty =>
    isSheets ? { qty: rollsIn(o.product.name), unit: rollsIn(o.product.name) ? 'ea' : undefined } : q;
  const ra = rolls(a, qa, sa);
  const rb = rolls(b, qb, sb);
  return ra.qty && rb.qty ? [ra, rb] : [{}, {}];
}

/** The cost of the amount you usually buy, at this pick's price per gram, litre or item. */
export function sameAmountCost(pick: Option, ref: Option | undefined, qty: number): number {
  const cost = lineCost(pick, qty);
  if (!ref) return cost;
  const [p, r] = alike(pick, ref);
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
  reason?: 'cheapest' | 'more-items' | 'with-elsewhere';
  /** With 'with-elsewhere': the store compared against, the one missing the fewest items. */
  fewestMissing?: ShopTotal;
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
function fromFewestMissing(t: ShopTotals, by: CompareBy): Recommended {
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
  // Close or not goes by your pantry items, not the one-off buys every store has the same (0.9.0).
  out.close = gap < tooClose(measure(cheapest, by) - (cheapest.oneOffs ?? 0)) - 0.005;
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

export function recommendedStores(t: ShopTotals, by: CompareBy = t.by): Recommended {
  const out = fromFewestMissing(t, by);
  const withLines = t.stores.filter((s) => s.lines.length);
  const fewestMissing = Math.min(...withLines.map((s) => s.missing.length));
  const lowestOf = (list: ShopTotal[], f: (s: ShopTotal) => number) =>
    list.reduce<ShopTotal | undefined>((b, s) => (!b || f(s) < f(b) - 0.005 ? s : b), undefined);
  // A store missing a few more items can still be the one to go to: if, after buying those few at
  // their next best store, it clearly beats the store that has the most (by over $2, or 3%).
  // Only a few (0.8.9): a store missing a third of the list, bought at two other shops, isn't
  // "one store" any more, so it can't be recommended as one.
  const withRest = (s: ShopTotal) => measure(s, by) + (by === 'unit' ? s.elsewhereFair : s.totalWithElsewhere - s.total);
  const base = out.recommended;
  const challenger = lowestOf(
    withLines.filter(
      (s) => s.missing.length > fewestMissing && s.missing.length <= fewMissing(t.linked) && s.missing.every((m) => m.elsewhere),
    ),
    withRest,
  );
  if (base && challenger) {
    const gap = withRest(base) - withRest(challenger);
    if (gap > tooClose(withRest(base) - (base.oneOffs ?? 0)) + 0.005) {
      out.recommended = challenger;
      out.cheapest = challenger;
      out.reason = 'with-elsewhere';
      out.fewestMissing = base;
      out.runnerUp = base;
      out.saving = gap;
      out.close = false;
      out.mostlyFrom = undefined;
    }
  }
  return out;
}

/** How many missing items still count as "a quick stop elsewhere": 2, or a tenth of the list. */
export const fewMissing = (items: number) => Math.max(2, Math.round(items * 0.1));

/** What a store comes to with its missing items bought at their next best store, for how the list is set. */
export function withElsewhere(s: ShopTotal, by: CompareBy): number {
  return by === 'unit' ? s.fair + s.elsewhereFair : s.totalWithElsewhere;
}

export function shopTotals(entries: ListEntry[], recs: Recommendation[], chains: Chain3[], by: CompareBy = 'unit'): ShopTotals {
  const open = entries.filter((e) => !e.checked);
  // My picks only (0.8.9), at shops you buy it at. Would also take is for Swap & save.
  const usable = (rec: Recommendation) => {
    const notAt = new Set(notAtChains(rec.group, (id) => rec.options.find((o) => o.product.id === id)?.product.chain));
    return rec.options.filter((o) => o.role === 'main' && !notAt.has(o.product.chain));
  };
  const byGroup = new Map(recs.map((r) => [r.group.id, { ...r, options: usable(r) }]));
  // One item's buy from these products: your pick for as many as are on the list, or with
  // "Any size" the cheapest way to get that amount.
  const buy = (rec: Recommendation, opts: Option[], qty: number) =>
    rec.group.anySize ? anySize(opts, usual(rec), by, qty) : best(opts, by, qty);
  const line = (rec: Recommendation, got: Got, qty: number) => ({
    item: rec.group.name,
    groupId: rec.group.id,
    pick: got.pick!,
    outOfStock: got.outOfStock,
    qty: got.packs ?? qty,
    packs: got.packs,
  });
  const linked = open
    .map((e) => ({ rec: e.groupId ? byGroup.get(e.groupId) : undefined, qty: Math.max(1, e.qty ?? 1) }))
    .filter((x): x is { rec: Recommendation; qty: number } => !!x.rec);
  // One-off buys with a price (0.9.0), as the list prices them. One at a shop that isn't one of these
  // (not going there today) isn't counted, and isn't "without a price" either.
  const notLinked = open.filter((e) => !(e.groupId && byGroup.has(e.groupId)));
  const priced = notLinked.filter((e) => e.price !== undefined && Number.isFinite(e.price) && e.price >= 0);
  const counted = priced.filter((e) => !e.chain || e.chain === 'other' || chains.includes(e.chain as Chain3));
  const oneOffs = {
    count: counted.length,
    total: counted.reduce((s, e) => s + Math.round(e.price! * Math.max(1, e.qty ?? 1) * 100) / 100, 0),
  };
  const unpriced = notLinked.length - priced.length;

  const stores: ShopTotal[] = chains.map((chain) => {
    const t: ShopTotal = {
      chain,
      total: 0,
      lines: [],
      missing: [],
      totalWithElsewhere: 0,
      elsewhereFair: 0,
      alternatives: 0,
      value: 0,
      fair: 0,
      cheapestFor: 0,
      cheapestForTill: 0,
      oneOffs: 0,
    };
    for (const { rec, qty } of linked) {
      const here = buy(
        rec,
        rec.options.filter((o) => o.product.chain === chain),
        qty,
      );
      if (here.pick) {
        const l = line(rec, here, qty);
        // With "Any size" the cost of getting your amount is the like-for-like cost.
        const fair = here.packs ? lineCost(l.pick, l.qty) : (fairCost(rec, chain, qty) ?? sameAmountCost(here.pick, usual(rec), qty));
        t.lines.push({ ...l, yours: here.pick, fair });
        t.total += lineCost(l.pick, l.qty);
        t.fair += fair;
        t.value += here.packs ? fair : sameAmountCost(here.pick, usual(rec), qty);
      } else {
        const got = buy(
          rec,
          rec.options.filter((o) => o.product.chain !== chain),
          qty,
        );
        const elsewhere = got.pick;
        const notHere = (rec.group.notAt ?? []).includes(chain);
        t.missing.push({ item: rec.group.name, groupId: rec.group.id, elsewhere, qty: got.packs ?? qty, ...(notHere ? { notHere } : {}) });
        if (elsewhere) {
          const cost = lineCost(elsewhere, got.packs ?? qty);
          t.totalWithElsewhere += cost;
          t.elsewhereFair += got.packs
            ? cost
            : ((elsewhere.product.chain !== 'other' ? fairCost(rec, elsewhere.product.chain, qty) : undefined) ??
              sameAmountCost(elsewhere, usual(rec), qty));
        }
      }
    }
    // The one-off buys, the same at every store (so they can't tip the comparison).
    t.oneOffs = oneOffs.total;
    t.total += oneOffs.total;
    t.fair += oneOffs.total;
    t.value += oneOffs.total;
    t.totalWithElsewhere += t.total;
    return t;
  });

  const around: ShopTotals['around'] = { total: 0, lines: [], missing: [], chains: [] };
  const pickFor = new Map<string, ShopLine>();
  for (const { rec, qty } of linked) {
    const got = buy(rec, rec.options, qty);
    if (!got.pick) {
      around.missing.push(rec.group.name);
      continue;
    }
    const l = line(rec, got, qty);
    const one: ShopLine = { ...l, fair: got.packs ? lineCost(l.pick, l.qty) : sameAmountCost(l.pick, usual(rec), qty), yours: l.pick };
    around.lines.push(one);
    pickFor.set(rec.group.id, one);
    around.total += lineCost(l.pick, l.qty);
    const c = l.pick.product.chain as Chain3;
    if (!around.chains.includes(c)) around.chains.push(c);
  }
  // The one-off buys, at the shop each was found at (0.9.0).
  around.total += oneOffs.total;
  for (const e of counted) {
    if (e.chain && e.chain !== 'other' && !around.chains.includes(e.chain as Chain3)) around.chains.push(e.chain as Chain3);
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
  return { stores, around, pickFor, linked: linked.length, unpriced, oneOffs, by };
}

export interface AroundPlan {
  /** What to recommend: shopping around, or one store that has everything. */
  pick: 'around' | ShopTotal;
  /** Shopping around for how the list is set: the same shopping (best value) or at the till (lowest price). */
  around: number;
  /** Shopping around the other way, shown smaller. */
  aroundOther: number;
  /** The cheapest store with everything on the list, for how the list is set. */
  complete?: ShopTotal;
  /** How much less shopping around comes to than that store (negative when the store is cheaper). */
  saving?: number;
  /** How many items come from each shop when shopping around. */
  stops: { chain: Chain3; items: number }[];
  /** The store with everything is also the cheapest for every item. */
  oneStop: boolean;
  /** Anything on the list has a price at all. */
  priced: boolean;
}

/** One store's total for how the list is set: the same shopping (best value) or at the till (lowest price). */
export const storeMeasure = (s: ShopTotal, by: CompareBy) => measure(s, by);

/**
 * Shop around, or one store? (0.9.0) Shopping around is recommended unless a store has everything on
 * the list and shopping around wouldn't save at least `min` (the setting, $1 to start with) over it.
 * Both sides are measured the same way, so the numbers next to each other always compare like with like.
 */
export function aroundPlan(t: ShopTotals, by: CompareBy = t.by, min = 1): AroundPlan {
  // Each item shopping around buys, measured the way its own shop's line is (so a bulk pack counts the
  // same here as in that shop's total, and the two always compare like with like).
  const lineFair = (l: ShopLine) =>
    t.stores.find((s) => s.chain === l.pick.product.chain)?.lines.find((x) => x.groupId === l.groupId)?.fair ?? l.fair;
  // The list's one-off buys count the same here as in every store's total (0.9.0).
  const fair = t.around.lines.reduce((s, l) => s + lineFair(l), 0) + (t.oneOffs?.total ?? 0);
  const till = t.around.total;
  const around = by === 'unit' ? fair : till;
  const aroundOther = by === 'unit' ? till : fair;
  const completes = t.stores.filter((s) => s.lines.length && !s.missing.length);
  // The one store with everything to compare against: the same one Restock recommends as one store,
  // when that one has everything (so the list, Home and the Start shopping sheet agree), else the
  // cheapest store with everything.
  const best = recommendedStores(t, by).recommended;
  const complete =
    best && completes.includes(best)
      ? best
      : completes.reduce<ShopTotal | undefined>((b, s) => (!b || measure(s, by) < measure(b, by) - 0.005 ? s : b), undefined);
  const counts = new Map<Chain3, number>();
  for (const l of t.around.lines) {
    const c = l.pick.product.chain as Chain3;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const stops = [...counts].map(([chain, items]) => ({ chain, items })).sort((a, b) => b.items - a.items);
  const saving = complete ? measure(complete, by) - around : undefined;
  // One shop already has the cheapest of everything: that's the one to go to.
  const oneStop = !!complete && stops.length === 1 && stops[0].chain === complete.chain;
  // Shopping around has to save at least the minimum, and always more than nothing.
  const pick = complete && (oneStop || saving! < Math.max(min, 0.01) - 0.005) ? complete : 'around';
  return { pick, around, aroundOther, complete, saving, stops, oneStop, priced: t.around.lines.length > 0 };
}
