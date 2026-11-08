import { SHOPS } from '../shops';
import type { ProductOrder } from '../types';
import { packSize } from './units';
import type { Option } from './verdict';

// The order an item's products are listed in (0.7.6), the same on the item page and in the price
// history. Before, they came in the order they were added, which looked random.

const SHOP_INDEX = new Map<string, number>(SHOPS.map((s, i) => [s.id, i]));
/** Shops in Restock's usual order (Woolworths, Coles, Aldi, …), your own shops last. */
export const shopRank = (chain: string) => SHOP_INDEX.get(chain) ?? SHOPS.length;

/** Grams, millilitres and counts each sort among themselves: g, then ml, then counts. */
const UNIT_RANK: Record<string, number> = { g: 0, ml: 1, ea: 2 };

function sizeKey(o: Option): [number, number] {
  const p = packSize(o.product.size, o.product.name);
  return p ? [UNIT_RANK[p.unit] ?? 3, p.qty] : [4, 0];
}

const priceOf = (o: Option) => o.price ?? Number.POSITIVE_INFINITY;
const byName = (a: Option, b: Option) => a.product.name.localeCompare(b.product.name, 'en-AU', { sensitivity: 'base', numeric: true });
const bySize = (a: Option, b: Option) => {
  const [ua, qa] = sizeKey(a);
  const [ub, qb] = sizeKey(b);
  return ua - ub || qa - qb;
};

export function orderOptions<T extends Option>(list: T[], order: ProductOrder = 'size'): T[] {
  return [...list].sort((a, b) => {
    if (order === 'cheapest') return priceOf(a) - priceOf(b) || (a.unitPrice ?? Infinity) - (b.unitPrice ?? Infinity) || byName(a, b);
    const shop = shopRank(a.product.chain) - shopRank(b.product.chain);
    if (shop) return shop;
    if (order === 'name') return byName(a, b) || bySize(a, b);
    return bySize(a, b) || priceOf(a) - priceOf(b) || byName(a, b);
  });
}

export const PRODUCT_ORDERS: { id: ProductOrder; label: string }[] = [
  { id: 'size', label: 'Shop, then size' },
  { id: 'cheapest', label: 'Cheapest first' },
  { id: 'name', label: 'Shop, then A to Z' },
];
