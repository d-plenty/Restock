import type { StoreProduct } from '../stores/types';
import type { ListEntry } from '../types';
import type { CatalogueDeal } from './myCatalogue';
import { shopSpecials, type Special } from './mySpecials';
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
export function ownSpecials(deals: CatalogueDeal[], list: StoreProduct[], seen: SeenRow[], entries: ListEntry[]): Special[] {
  const lines = listLineKeys(entries);
  return shopSpecials(deals, list, seen).filter((s) => s.from === 'yours' || lines.has(s.key));
}

/** The line under a shop's square button: how many of your things are on special there. */
export function shopTileNote(n: number | undefined): string {
  if (n === undefined) return 'Your specials';
  return n ? `${n} on special` : 'None this week';
}
