// 0.15.1: the Add screen's shared pieces (its parts are in add*.tsx and Add*.tsx): the result kinds, sorting, page sizes and small helpers.
import { type CSSProperties } from 'react';
import { sameCode, unitOf, unitTextOf, type Scored } from '../../lib/searchHelp';
import { packSize } from '../../lib/units';
import { adapterFor, type StoreProduct } from '../../stores';
import { shopDetails } from '../../stores/details';
import { tokens } from '../../stores/rank';
import { chainName, type ListEntry, type ListProduct } from '../../types';
import { type Section, type StoreChain, slots } from '../../shops';
import { type PreviewProduct } from '../components';

// Short enough to show in full at 390 px wide with the largest text (0.9.5: "Or search a proc…").
export const SEARCH_PLACEHOLDER: Record<Section, string> = {
  pantry: 'Search products',
  keg: 'Search drinks',
  pharmacy: 'Search Chemist',
  baby: 'Search Baby',
  pets: 'Search Pets',
  ...slots('Search products'),
};

/** Small buttons and links still get a 44 px target. */
export const TAP: CSSProperties = { minHeight: 44 };

/**
 * 0.9.5: "Search the shops" from the Pick sheet, for a list line that matches nothing in the pantry
 * ("chopsticks" from Home Assistant). The Add tab's own search, ticks and bar; adding makes the
 * pantry item and links the line to it.
 */
export interface ForLine {
  entry: ListEntry;
  /** The line's words ("chopsticks"). */
  word: string;
  /** "Always use this for chopsticks". */
  always: boolean;
  onAlways: (on: boolean) => void;
  /** The line now is this item (`made`: a new one). `linked` false: the line had gone meanwhile. */
  onDone: (group: { id: string; name: string }, made: boolean, linked: boolean) => void;
  /** 0.9.11: "Add to list" (no pantry item): the line was replaced, so the sheet just closes. */
  onListed: () => void;
  /** 0.10.2: the line sheet's "Add to pantry": one button (PickButtons), the item made and the line kept as it. */
  toPantry?: boolean;
  /** 0.10.2: the shop's product the line came from, ticked again once that shop's results are in. */
  preTick?: ListProduct;
}

export type ChainResult =
  | { status: 'loading' }
  | {
      status: 'ok';
      items: StoreProduct[];
      /** Best first, with how well each matched (0.8.5). */
      scored?: Scored[];
      /** The ones worth recommending (keys). */
      top?: string[];
      /** Pages fetched so far, and whether the shop has more. */
      page?: number;
      more?: boolean;
      loadingMore?: boolean;
    }
  | { status: 'error'; message: string; blocked?: boolean; unblock?: boolean };

/** A shop sending back fewer than this on a page has no more to send. */
export const FULL_PAGE = 12;

export type SortKey = 'relevant' | 'unit' | 'low' | 'high';

export const SORTS: { id: SortKey; label: string }[] = [
  { id: 'relevant', label: 'Most relevant' },
  { id: 'unit', label: 'Best value (unit price)' },
  { id: 'low', label: 'Price: low to high' },
  { id: 'high', label: 'Price: high to low' },
];

export function sorted(items: StoreProduct[], by: SortKey): StoreProduct[] {
  if (by === 'relevant') return items;
  if (by === 'unit') {
    const u = (p: StoreProduct) => unitOf(p)?.per ?? Infinity;
    return [...items].sort((a, b) => u(a) - u(b));
  }
  const price = (p: StoreProduct) => p.price ?? (by === 'low' ? Infinity : -Infinity);
  return [...items].sort((a, b) => (by === 'low' ? price(a) - price(b) : price(b) - price(a)));
}

export const FIRST_PAGE = 5;

export const MORE_PAGE = 10;

export type Target = 'pantry' | 'list' | 'both';

/**
 * The same product at another shop, found by opening the shop's own page for its top few results:
 * the same barcode, or the same brand and size with the product type (from the scan or the product
 * you picked) in its description. Only on the phone, where the shops' pages can be read.
 */
export async function matchByDetails(
  anchor: StoreProduct,
  items: StoreProduct[],
  kind: string,
  barcode: string | undefined,
  colesStore?: string,
): Promise<StoreProduct | undefined> {
  const size = packSize(anchor.size, anchor.name);
  const kindWords = tokens(kind);
  const sameSize = (p: StoreProduct) => {
    const q = packSize(p.size, p.name);
    return !!size && !!q && q.unit === size.unit && Math.abs(q.qty / size.qty - 1) <= 0.05;
  };
  const brand = tokens(anchor.brand ?? '');
  const hasBrand = (p: StoreProduct) => brand.length > 0 && brand.every((w) => tokens(`${p.brand ?? ''} ${p.name}`).includes(w));
  // Barcodes first; for descriptions, only same-brand, same-size products are worth opening.
  const look = items.filter((p) => barcode || (hasBrand(p) && sameSize(p))).slice(0, 5);
  for (const p of look) {
    const d = await shopDetails(p, colesStore);
    if (!d) continue;
    if (barcode && d.barcode && sameCode(d.barcode, barcode)) return { ...p, barcode: d.barcode };
    const words = tokens(`${d.description ?? ''} ${p.name}`);
    if (hasBrand(p) && sameSize(p) && kindWords.length && kindWords.every((w) => words.includes(w))) return p;
  }
  return undefined;
}

/** "25 Oct" (and the year when it isn't this one) for a remembered day, YYYY-MM-DD. */
export const seenDay = (day: string) => {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
};

/** 0.12.0: the three most people use; every other shop is one tap further (Settings → your shops). */
export const FIRST_SHOPS: StoreChain[] = ['woolworths', 'coles', 'aldi'];

/**
 * 0.9.6: the shop to ask for a follow-up search (the same product at your other shops, other sizes, "instead of"
 * suggestions, recommendations). Never Costco: it is only ever asked when the person presses Search, one request.
 */
export function followAdapter(chain: string) {
  // 0.9.8: Costco too: each of these is something the person did on the screen.
  return adapterFor(chain as StoreChain);
}

export function storePreview(sp: StoreProduct): PreviewProduct {
  return {
    chain: sp.chain,
    name: sp.name,
    brand: sp.brand,
    size: sp.size,
    imageUrl: sp.imageUrl,
    storeProductId: sp.storeProductId,
    barcode: sp.barcode,
    price: sp.price,
    wasPrice: sp.wasPrice,
    isSpecial: sp.isSpecial,
    memberOnly: sp.memberOnly,
    promo: sp.promo,
    unitText: unitTextOf(sp) || undefined,
    // 0.10.7: no stock in search results: it's only checked when asked, on the shopping list.
    inStock: undefined,
  };
}

/** "Aldi, Woolworths (2), Coles": each shop once, with how many are ticked there when it's more than one. */
export function tickedShops(picks: StoreProduct[]): string {
  const counts = new Map<StoreChain, number>();
  for (const p of picks) counts.set(p.chain as StoreChain, (counts.get(p.chain as StoreChain) ?? 0) + 1);
  return [...counts].map(([c, n]) => (n > 1 ? `${chainName(c)} (${n})` : chainName(c))).join(', ');
}
