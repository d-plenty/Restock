// 0.13.0: "See what Declan and Sarah use". The two people who make Restock share their own pantry as
// a starting point: every item, with the products they buy at Coles, Woolworths and Aldi. You tick
// the ones you want (or all of them) and they're added to your pantry: nothing goes on the shopping
// list, and nothing you already have is touched. An item whose name you already use is left out
// (the same test as adding by hand: capitals, spaces and a full stop at the end don't count).
import type { StoreProduct } from '../stores';
import type { Chain, Group } from '../types';
import { allCategories } from './db';
import { PICK_GROUPS, PICK_PRODUCTS } from './makerPicksData';
import { nameKey } from './sameName';

export const PICKS_TITLE = 'See what Declan and Sarah use';
export const PICKS_ABOUT =
  'Declan and Sarah make Restock, and this is what they keep in their own pantry: a good budget shop from Coles, Woolworths and Aldi, with a tasty variety. Cheap, but still good. Use it as a starting point, then make it yours.';

const CHAIN: Record<string, Chain> = { c: 'coles', w: 'woolworths', a: 'aldi' };

export interface MakerPick {
  /** Its place in the list (stable: the tick boxes go by it). */
  n: number;
  name: string;
  category: string;
  main: StoreProduct[];
  alts: StoreProduct[];
  allowBulk: boolean;
  allowMulti: boolean;
}

const product = (i: number): StoreProduct => {
  const [c, name, brand, size, barcode, storeProductId, imageUrl] = PICK_PRODUCTS[i];
  return { chain: CHAIN[c], name, brand: brand || undefined, size: size || undefined, barcode: barcode || undefined, storeProductId, imageUrl: imageUrl || undefined, isSpecial: false, memberOnly: false };
};

/** Every pick, in the makers' own order (by category, then name). */
export function allPicks(): MakerPick[] {
  return PICK_GROUPS.map(([name, category, main, alts, bulk, multi], n) => ({
    n,
    name,
    category: category || 'Other',
    main: main.map(product),
    alts: alts.map(product),
    allowBulk: !!bulk,
    allowMulti: !!multi,
  }));
}

/** The picks whose name you already use for a pantry item (any tab): they're never added or changed. */
export function picksYouHave(picks: MakerPick[], groups: readonly Pick<Group, 'name'>[] | undefined): Set<number> {
  const mine = new Set((groups ?? []).map((g) => nameKey(g.name)));
  return new Set(picks.filter((p) => mine.has(nameKey(p.name))).map((p) => p.n));
}

/** The shops a pick has a product at, in the usual order. */
export const pickShops = (p: MakerPick): Chain[] => (['coles', 'woolworths', 'aldi'] as Chain[]).filter((c) => p.main.some((x) => x.chain === c));

/** Your own Pantry category of that name, if you have one (else it's filed by its name, as any new item). */
export async function pickCategoryIds(): Promise<Map<string, string>> {
  const cats = (await allCategories().catch(() => [])).filter((c) => c.section === 'pantry');
  return new Map(cats.map((c) => [c.name.trim().toLowerCase(), c.id]));
}

const SEEN_KEY = 'restock.picks';
/** The offer on the Pantry: gone for good once it's been used or turned down. */
export function picksOffered(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === null;
  } catch {
    return false;
  }
}
export function picksDone(how: 'used' | 'no'): void {
  try {
    localStorage.setItem(SEEN_KEY, how);
  } catch {
    // ignore
  }
}
