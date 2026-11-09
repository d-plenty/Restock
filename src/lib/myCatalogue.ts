import { chainName } from '../types';
import { notAtChains } from './picks';
import { money } from './units';
import { specialsWeekStart, type Option, type Recommendation } from './verdict';

// My catalogue (0.9.0): this week's catalogue, made only from the items you track. Each shop gets a
// page of your items on sale there (with a badge like 40% OFF, HALF PRICE or 2 FOR $5.60). A shop
// with no sales on your items (Aldi, mostly) gets a page of the things it's cheapest for instead.

export interface CatalogueDeal {
  rec: Recommendation;
  option: Option;
  /** "40% OFF", "HALF PRICE", "2 FOR $5.60", or "CHEAPEST" / "SAME PRICE" on a cheapest page. */
  badge: string;
  /** The normal price for one, to cross out (sales only). */
  was?: number;
  /** What you save on one (on a multi-buy: per item, when you buy the set). */
  saving: number;
  /** One line under the price: "Save $1.40", "$2.80 each when you buy 2", "$0.91 less than Coles". */
  note: string;
}

export interface CataloguePage {
  chain: string;
  /** 'sales': this week's sales. 'cheapest': where this shop beats the others. */
  kind: 'sales' | 'cheapest';
  deals: CatalogueDeal[];
}

export interface MyCatalogue {
  /** The specials week: Wednesday to Tuesday. */
  from: Date;
  to: Date;
  pages: CataloguePage[];
  /** What the sales save, one per item at its best saving. */
  saving: number;
  /** Your items with a sale this week. */
  items: number;
  deals: number;
  halfPrice: number;
  multiBuys: number;
}

/** The normal price for one: what it usually costs, the "was" price the shop gives, or for a multi-buy the price of one. */
const normalOf = (o: Option) => o.stats.typical ?? o.stats.current?.wasPrice ?? (o.multi ? o.shelfPrice : undefined);

/** Is this option on a real sale this week (not a fake one), for you? */
function onSale(o: Option): boolean {
  if (o.price === undefined || o.product.inStock === false) return false;
  const k = o.verdict.kind;
  if (k === 'great' || k === 'good' || k === 'small') return true;
  // A multi-buy that's genuinely cheaper than one at its normal price.
  const normal = normalOf(o);
  return !!o.multi && !!normal && o.price < normal - 0.004;
}

function saleDeal(rec: Recommendation, o: Option): CatalogueDeal | undefined {
  const normal = normalOf(o);
  if (!normal || o.price === undefined) return undefined;
  const saving = normal - o.price;
  if (saving < 0.005) return undefined;
  if (o.multi) {
    return {
      rec,
      option: o,
      badge: `${o.multi.n} FOR ${money(o.multi.total)}`,
      was: normal,
      saving,
      note: `${money(o.price)} each when you buy ${o.multi.n}`,
    };
  }
  const pct = Math.round((saving / normal) * 100);
  // Under 1% off isn't worth a catalogue spot ("0% OFF").
  if (pct < 1) return undefined;
  return {
    rec,
    option: o,
    badge: pct >= 49 && pct <= 51 ? 'HALF PRICE' : `${pct}% OFF`,
    was: normal,
    saving,
    note: `Save ${money(saving)}`,
  };
}

/** The Wednesday-to-Tuesday specials week that `now` is in. (0.9.0: the start is verdict.ts specialsWeekStart, which judges sales too.) */
export function specialsWeek(now: Date): { from: Date; to: Date } {
  const from = new Date(specialsWeekStart(now.getTime()));
  const to = new Date(from);
  to.setDate(from.getDate() + 6);
  return { from, to };
}

/**
 * The catalogue for these shops, from your items. Only your picks count (Would also take is for
 * Swap & save), at the shops you use. Sales are sorted by how much they save.
 */
export function buildCatalogue(recs: Recommendation[], chains: string[], now = new Date()): MyCatalogue {
  const pages: CataloguePage[] = [];
  const bestSaving = new Map<string, number>();
  // Shops you've said you don't buy an item at ("Not at this shop") leave it out there.
  const notAt = new Map(
    recs.map((r) => [r.group.id, new Set(notAtChains(r.group, (id) => r.options.find((o) => o.product.id === id)?.product.chain))]),
  );
  const usable = (rec: Recommendation, o: Option) => o.role === 'main' && !notAt.get(rec.group.id)?.has(o.product.chain);
  for (const chain of chains) {
    const deals: CatalogueDeal[] = [];
    for (const rec of recs) {
      // Your cheapest pick on sale at this shop.
      const here = rec.options.filter((o) => usable(rec, o) && o.product.chain === chain && onSale(o));
      const o = here.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0];
      const d = o && saleDeal(rec, o);
      if (!d) continue;
      deals.push(d);
      bestSaving.set(rec.group.id, Math.max(bestSaving.get(rec.group.id) ?? 0, d.saving));
    }
    deals.sort((a, b) => b.saving - a.saving);
    pages.push({ chain, kind: 'sales', deals });
  }
  // A shop with no sales on your items: what it's cheapest for instead.
  for (const page of pages) {
    if (page.deals.length) continue;
    page.kind = 'cheapest';
    for (const rec of recs) {
      // Compare per 100 g / litre / item when the item does, else on the shelf; each shop's best pack by that.
      const cost = (o: Option) => (rec.byUnit && o.unitPrice !== undefined ? o.unitPrice : o.price!);
      const priced = (c: string) =>
        rec.options
          .filter((o) => usable(rec, o) && o.product.chain === c && o.price !== undefined && o.product.inStock !== false)
          .sort((a, b) => cost(a) - cost(b))[0];
      const mine = priced(page.chain);
      if (!mine) continue;
      const others = chains
        .filter((c) => c !== page.chain)
        .map(priced)
        .filter((o): o is Option => !!o);
      if (!others.length) continue;
      const next = others.sort((a, b) => cost(a) - cost(b))[0];
      if (cost(mine) > cost(next) + 1e-9) continue;
      const same = Math.abs(cost(mine) - cost(next)) <= 1e-9;
      // What the same amount costs more at the next cheapest shop (so a 4 L bottle there isn't set
      // against a 2 L one here).
      const byAmount = rec.byUnit && mine.unitPrice !== undefined && next.unitPrice !== undefined && mine.unitPrice > 0;
      const diff = byAmount ? (next.unitPrice! - mine.unitPrice!) * (mine.price! / mine.unitPrice!) : (next.price ?? 0) - (mine.price ?? 0);
      page.deals.push({
        rec,
        option: mine,
        badge: same ? 'SAME PRICE' : 'CHEAPEST',
        saving: same ? 0 : diff,
        note: same
          ? 'Same price at the other shops'
          : diff > 0.004
            ? `${money(diff)} less than ${chainName(next.product.chain)}`
            : `Less per ${rec.byUnit ? 'unit' : 'item'} than ${chainName(next.product.chain)}`,
      });
    }
    page.deals.sort((a, b) => b.saving - a.saving || a.rec.group.name.localeCompare(b.rec.group.name));
  }
  const sales = pages.filter((p) => p.kind === 'sales').flatMap((p) => p.deals);
  // The week the sales are from: the newest sale price's day, or this week when there are none.
  // (0.9.0: sale prices from before this week's Wednesday no longer count as on sale, so on a
  // Wednesday morning, before the first check, last week's sales drop out until prices are checked.)
  const newest = sales.reduce<string | undefined>((b, d) => {
    const day = d.option.stats.current?.date;
    return day && (!b || day > b) ? day : b;
  }, undefined);
  const { from, to } = specialsWeek(newest ? new Date(newest) : now);
  return {
    from,
    to,
    // A "cheapest here" page needs a few things on it to be worth a page.
    pages: pages.filter((p) => (p.kind === 'sales' ? p.deals.length > 0 : p.deals.length >= 3)),
    saving: [...bestSaving.values()].reduce((s, x) => s + x, 0),
    items: bestSaving.size,
    deals: sales.length,
    halfPrice: sales.filter((d) => d.badge === 'HALF PRICE').length,
    multiBuys: sales.filter((d) => !!d.option.multi).length,
  };
}
