import type { Group, Product } from '../types';
import { packSize } from './units';

// My picks and Would also take (0.8.9).
//
// Each item has, at each shop, the products you'd buy there ("My picks": the usual product and the
// "same" products) and others you'd also take when they're cheaper ("Would also take", the
// alternatives). Store comparisons use My picks only; Would also take is only for Swap & save.
//
// Before 0.8.9 an alternative also counted for a store comparison when it was the only product an
// item had at that shop. So nothing changes when you update, those alternatives become My picks at
// their shop. Alternatives at a shop that already has one of your picks stay Would also take, and
// so does a bulk pack on an item that said no to bulk packs (0.8.8 never used those either).

type Sized = Pick<Product, 'size' | 'name' | 'qty' | 'qtyUnit'>;
/** A product's amount, as verdict.ts productQty works it out (kept here so the migration needn't load verdict.ts). */
const amount = (p: Sized | undefined) =>
  !p ? undefined : p.qty && p.qtyUnit ? { qty: p.qty, unit: p.qtyUnit as string } : packSize(p.size, p.name);

/**
 * An item's products moved over to My picks / Would also take. `chainOf` gives a product's shop;
 * `productOf` (optional) its size, to leave bulk packs alone when the item doesn't want them.
 */
export function toPicks<G extends Pick<Group, 'usualProductId' | 'sameProductIds' | 'altProductIds' | 'allowBulk'>>(
  g: G,
  chainOf: (productId: string) => string | undefined,
  productOf?: (productId: string) => Sized | undefined,
): G {
  const mains = [g.usualProductId, ...(g.sameProductIds ?? [])].filter((x): x is string => !!x);
  const picked = new Set(mains.map(chainOf).filter((c): c is string => !!c));
  const alts = g.altProductIds ?? [];
  // The same test as verdict.ts isBulk: over 1.5 times your usual amount.
  const ref = productOf && mains.map((id) => amount(productOf(id))).find((q) => q?.qty);
  const bulk = (id: string) => {
    if (g.allowBulk !== false || !ref?.qty || !productOf) return false;
    const q = amount(productOf(id));
    return !!q?.qty && q.unit === ref.unit && q.qty > ref.qty * 1.5;
  };
  const move = alts.filter((id) => {
    const c = chainOf(id);
    return !!c && !picked.has(c) && !bulk(id);
  });
  if (!move.length) return g;
  const stay = alts.filter((id) => !move.includes(id));
  const usual = g.usualProductId ?? move[0];
  const same = [...(g.sameProductIds ?? []), ...move].filter((id) => id !== usual);
  return { ...g, usualProductId: usual, sameProductIds: [...new Set(same)], altProductIds: stay };
}

/**
 * The shops an item isn't bought at that still count: a shop marked "Not at this shop" that has
 * one of your picks again (ticked there later, maybe on another phone) is back in.
 */
export function notAtChains(g: Pick<Group, 'notAt' | 'usualProductId' | 'sameProductIds'>, chainOf: (id: string) => string | undefined) {
  const picked = new Set([g.usualProductId, ...(g.sameProductIds ?? [])].map((id) => id && chainOf(id)));
  return (g.notAt ?? []).filter((c) => !picked.has(c));
}
