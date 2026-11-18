import type { StoreProduct } from '../stores/types';
import type { ListEntry } from '../types';
import type { CatalogueDeal } from './myCatalogue';
import { fromDoubt, shopSpecials, type Special } from './mySpecials';
import type { SeenRow } from './seen';

// 0.12.3: a shop's page shows only your own things on special there (My catalogue merged into each
// shop's page): the items you track on any tab (pantry, Bottle shop, Chemist, your own sections),
// which also covers everything on a list that's linked to one of them, and one-off shopping list
// lines found at that shop. The shop's general half-price list and what your searches found are no
// longer shown; they're only used to spot a one-off list line on special. The whole catalogue is on
// the shop's own site.

/** "coles|12345" for every one-off list line (not linked to an item) found at a shop. */
export function listLineKeys(entries: ListEntry[]): Set<string> {
  return new Set(
    entries
      .filter((e) => !e.checked && !e.groupId && e.product?.storeProductId)
      .map((e) => `${e.product!.chain}|${e.product!.storeProductId}`),
  );
}

/** Your own specials at one shop: your items first (Restock judged the sale), then list lines. */
export function ownSpecials(deals: CatalogueDeal[], list: StoreProduct[], seen: SeenRow[], entries: ListEntry[], doubts: CatalogueDeal[] = []): Special[] {
  const lines = listLineKeys(entries);
  const real = shopSpecials(deals, list, seen).filter((s) => s.from === 'yours' || lines.has(s.key));
  // 0.12.6: then the ones the shop calls a special and Restock doesn't (never counted: see realCount).
  const keys = new Set(real.map((s) => s.key));
  const extra = doubts.map(fromDoubt).filter((s): s is Special => !!s && !keys.has(s.key));
  return [...real, ...extra];
}

/** How many are really on special (the banner and the saving leave the doubtful ones out). */
export const realCount = (all: Special[]): number => all.filter((s) => !s.doubt).length;

/** The line under a shop's square button: how many of your things are on special there. */
export function shopTileNote(n: number | undefined): string {
  if (n === undefined) return 'Your specials';
  return n ? `${n} on special` : 'None this week';
}
