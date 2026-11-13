import { getKV } from './db';

// 0.10.2: aisle numbers in shopping mode. The phone's price check (PriceChecker.java) notes where
// each product is at your Coles branches, when "Prices and stock at my store" is on, in the "aisles"
// store entry (on this phone only, never synced: phones can shop at different branches):
//   { "<product id>": { "1": { s: store number, a: aisle, side, o: order, at }, "2": … } }
// Slot 1 is your branch, slot 2 your second. Only Coles gives aisles: Woolworths' website gives an
// online category instead, and Aldi and Costco don't publish them. Everything else is "Aisle: unknown".

export interface AisleAt {
  /** The aisle as the shop gives it: usually a number ("12"), sometimes a name ("Freezer"). */
  a?: string;
  side?: string;
  /** The shop's own order along the aisle, when it gives one. */
  o?: number;
  /** The store number it was read at. */
  s?: string;
  at?: string;
}

export type AisleMap = Record<string, { '1'?: AisleAt; '2'?: AisleAt }>;

/** The disclaimer, the same everywhere it's shown (setup, Settings → Supermarkets, the fine print). */
export const AISLE_NOTE =
  "Aisle numbers come straight from each shop's own website, for that branch. Shops move things around, so if one's wrong, that's the shop's information, not Restock's.";

export const getAisles = () => getKV<AisleMap>('aisles');

/** Where a product is at a branch, or undefined when the shop hasn't said (Aisle: unknown). */
export function aisleOf(map: AisleMap | undefined, productId: string | undefined, slot: '1' | '2' = '1', storeNo?: string): AisleAt | undefined {
  if (!map || !productId) return undefined;
  const v = map[productId]?.[slot];
  if (!v?.a) return undefined;
  // A branch you've since changed: its aisles don't count.
  if (storeNo && v.s && v.s !== storeNo) return undefined;
  return v;
}

const cap = (t: string) => (t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : t);

/** "Aisle 12 · Left", "Freezer", or "Aisle: unknown". */
export function aisleLabel(v: AisleAt | undefined): string {
  if (!v?.a) return 'Aisle: unknown';
  const a = v.a.trim();
  const name = /^aisle\b/i.test(a) ? cap(a) : /^\d/.test(a) ? `Aisle ${a}` : a;
  return v.side ? `${name} · ${cap(v.side)}` : name;
}

/** The aisle's number for sorting (the first number in it), or undefined for a name like "Freezer". */
export const aisleNumber = (v: AisleAt | undefined): number | undefined => {
  const m = v?.a ? /\d+/.exec(v.a) : null;
  return m ? Number(m[0]) : undefined;
};

export type ShopSort = 'aisle' | 'category' | 'az';

/**
 * Sorts a shop's lines by aisle: numbered aisles first (1 to 50, or 50 to 1), then aisles with a
 * name ("Freezer"), then the ones the shop doesn't know, A–Z. Within an aisle, the shop's own order,
 * then A–Z.
 */
export function byAisle<T>(rows: T[], where: (r: T) => AisleAt | undefined, name: (r: T) => string, down = false): T[] {
  const az = (a: T, b: T) => name(a).localeCompare(name(b), 'en-AU', { sensitivity: 'base' });
  const rank = (r: T) => {
    const v = where(r);
    if (!v?.a) return 2;
    return aisleNumber(v) === undefined ? 1 : 0;
  };
  return [...rows].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const d = aisleNumber(where(a))! - aisleNumber(where(b))!;
      if (d) return down ? -d : d;
      const sa = where(a)!.a!.localeCompare(where(b)!.a!);
      if (sa) return down ? -sa : sa;
      const oa = where(a)!.o;
      const ob = where(b)!.o;
      if (oa !== undefined && ob !== undefined && oa !== ob) return down ? ob - oa : oa - ob;
    } else if (ra === 1) {
      const d = where(a)!.a!.localeCompare(where(b)!.a!, 'en-AU', { sensitivity: 'base' });
      if (d) return d;
    }
    return az(a, b);
  });
}
