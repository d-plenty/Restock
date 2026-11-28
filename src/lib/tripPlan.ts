// 0.12.7: what a shopping trip offers at the shops still to visit.
//
// You say which shops you're going to today. Each item starts at the cheapest of those that has one
// of your picks ("Products I buy"). Finish a shop without ticking an item and it moves on to the next
// cheapest shop still to visit. "Also happy with" (an alternative product) only fills a gap:
//   - none of the shops still to visit has one of your picks, but one has an alternative; or
//   - your picks at those shops are all out of stock, and an alternative there isn't.
// So an alternative at Aldi never shows while Coles (which has your pick) is still ahead of you; it
// does when you're only going to Aldi, or once Coles is finished and it still isn't ticked.
import type { Recommendation } from './verdict';
import { notAtChains } from './picks';

/** The shops still to visit: today's, less the ones finished. When every one is finished, today's. */
export function shopsLeft<T extends string>(chosen: readonly T[], done: readonly string[]): T[] {
  const left = chosen.filter((c) => !done.includes(c));
  return left.length ? left : [...chosen];
}

interface TripRecs {
  /** Each item's products at the shops still to visit, with an alternative standing in where it fills a gap. */
  recs: Recommendation[];
  /** Product ids that are standing in as an alternative (to say so on the line). */
  alternatives: Set<string>;
}

export function tripRecs(recs: Recommendation[], chosen: readonly string[], done: readonly string[] = []): TripRecs {
  const left = new Set<string>(shopsLeft(chosen, done));
  const alternatives = new Set<string>();
  const out = recs.map((r) => {
    const notAt = new Set(notAtChains(r.group, (id) => r.options.find((o) => o.product.id === id)?.product.chain));
    const here = r.options.filter((o) => left.has(o.product.chain));
    const mains = here.filter((o) => o.role === 'main' && !notAt.has(o.product.chain) && o.price !== undefined);
    const alts = here.filter((o) => o.role === 'alt' && o.price !== undefined);
    const mainsOut = mains.length > 0 && mains.every((o) => o.product.inStock === false);
    const altsIn = alts.filter((o) => o.product.inStock !== false);
    const standIn = !mains.length ? alts : mainsOut ? altsIn : [];
    if (!standIn.length) return { ...r, options: here };
    for (const o of standIn) alternatives.add(o.product.id);
    // The list buys from "Products I buy" only (shopTotals), so a stand-in is passed as one.
    return { ...r, options: [...here.filter((o) => o.role === 'main'), ...standIn.map((o) => ({ ...o, role: 'main' as const }))] };
  });
  return { recs: out, alternatives };
}
