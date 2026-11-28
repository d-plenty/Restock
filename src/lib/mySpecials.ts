import type { StoreProduct } from '../stores/types';
import type { CatalogueDeal } from './myCatalogue';
import type { SeenRow } from './seen';

// 0.11.0: My specials: what's on special at each shop you use, in one list a shop. Three places it
// can come from, in this order (a product in more than one is shown once, from the first):
//   yours  an item you track that's on a real sale there this week (myCatalogue.ts decides)
//   list   the shop's own full list, where Restock can read one (Coles and Woolworths half price)
//   seen   something a search or scan of yours found on special there this week (lib/seen.ts)
// Nothing is fetched to build it beyond the two full lists the Specials page always loaded.

export type SpecialFrom = 'yours' | 'list' | 'seen';
export type SpecialSort = 'saving' | 'price' | 'az';

/** 0.12.6: the kind of deal, said on the tile's corner (it said "Your item" on every one). */
type DealTone = 'good' | 'wait' | 'fake';
export interface DealWord {
  text: string;
  tone: DealTone;
}

export interface Special {
  key: string;
  chain: string;
  name: string;
  price: number;
  was?: number;
  /** What it saves against its usual or "was" price; 0 when there's nothing to compare with. */
  saving: number;
  imageUrl?: string;
  from: SpecialFrom;
  /** yours: the pantry item it belongs to. */
  groupId?: string;
  groupName?: string;
  /** "2 for $5.60" and the like. */
  note?: string;
  /** list and seen: the shop's product, for the per-litre price. */
  product?: StoreProduct;
  /** What kind of deal it is: "Great deal", "On special", "Small saving", "2 for $5.60", "Half price". */
  deal: DealWord;
  /** yours: the shop calls it a special, but Restock doesn't count it as one (fake, or wait for a better one). */
  doubt?: boolean;
}

/** The Pantry's own words for a judged sale (ui/simple.tsx recNote says the same). */
export function dealWord(kind: string, multi?: { n: number; total: number }): DealWord {
  if (kind === 'fake') return { text: 'Not a real special', tone: 'fake' };
  if (kind === 'wait') return { text: 'Wait for a better special', tone: 'wait' };
  if (multi) return { text: `${multi.n} for $${multi.total.toFixed(2)}`, tone: 'good' };
  return { text: kind === 'great' ? 'Great deal' : kind === 'small' ? 'Small saving' : 'On special', tone: 'good' };
}

const fromDeal = (d: CatalogueDeal): Special | undefined => {
  const o = d.option;
  if (o.price === undefined) return undefined;
  return {
    key: `${o.product.chain}|${o.product.storeProductId ?? o.product.id}`,
    chain: o.product.chain,
    name: o.product.name,
    price: o.price,
    was: d.was,
    saving: Math.max(0, d.saving),
    imageUrl: o.product.imageUrl,
    from: 'yours',
    groupId: d.rec.group.id,
    groupName: d.rec.group.name,
    note: o.multi ? `${o.multi.n} for $${o.multi.total.toFixed(2)}` : undefined,
    deal: dealWord(o.verdict?.kind ?? 'good', o.multi),
  };
};

/**
 * 0.12.6: one of yours the shop marks as a special that Restock doesn't count as one: its usual
 * price dressed up, or a special that's been better. Shown after the real ones, said plainly, and
 * never counted in "N of yours on special" or the saving.
 */
export const fromDoubt = (d: CatalogueDeal): Special | undefined => {
  const o = d.option;
  if (o.price === undefined) return undefined;
  return {
    key: `${o.product.chain}|${o.product.storeProductId ?? o.product.id}`,
    chain: o.product.chain,
    name: o.product.name,
    price: o.price,
    saving: 0,
    imageUrl: o.product.imageUrl,
    from: 'yours',
    groupId: d.rec.group.id,
    groupName: d.rec.group.name,
    note: d.note,
    deal: dealWord(o.verdict.kind),
    doubt: true,
  };
};

const fromProduct = (p: StoreProduct, from: SpecialFrom): Special | undefined =>
  typeof p.price === 'number' && p.price > 0 && p.storeProductId
    ? {
        key: `${p.chain}|${p.storeProductId}`,
        chain: p.chain,
        name: p.name,
        price: p.price,
        was: p.wasPrice && p.wasPrice > p.price ? p.wasPrice : undefined,
        saving: p.wasPrice && p.wasPrice > p.price ? p.wasPrice - p.price : 0,
        imageUrl: p.imageUrl,
        from,
        product: p,
        // Not one of your items, so Restock hasn't judged it: what the shop says, in plain words.
        deal: { text: p.wasPrice && Math.abs(p.wasPrice - 2 * p.price) <= p.wasPrice * 0.02 ? 'Half price' : 'On special', tone: 'good' },
      }
    : undefined;

const seenAsProduct = (r: SeenRow): StoreProduct =>
  ({
    chain: r.chain,
    storeProductId: r.store_product_id,
    name: r.name,
    brand: r.brand ?? undefined,
    size: r.size ?? undefined,
    barcode: r.barcode ?? undefined,
    imageUrl: r.image_url ?? undefined,
    price: Number(r.price),
    wasPrice: r.was_price === null ? undefined : Number(r.was_price),
    isSpecial: !!r.is_special,
    memberOnly: !!r.member_only,
    promo: r.promo ?? undefined,
  }) as StoreProduct;

/** One shop's specials from the three places, each product once. */
export function shopSpecials(deals: CatalogueDeal[], list: StoreProduct[], seen: SeenRow[]): Special[] {
  const out = new Map<string, Special>();
  const put = (s: Special | undefined) => {
    if (s && !out.has(s.key)) out.set(s.key, s);
  };
  deals.forEach((d) => put(fromDeal(d)));
  list.forEach((p) => put(fromProduct(p, 'list')));
  seen.forEach((r) => put(fromProduct(seenAsProduct(r), 'seen')));
  return [...out.values()];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');

/** Search (every word typed, in any order, in the name or your item's name) and sort. Yours stay first on a tie. */
export function filterSpecials(all: Special[], typed: string, sort: SpecialSort): Special[] {
  const words = norm(typed).split(/\s+/).filter(Boolean);
  const hit = (s: Special) => {
    const hay = norm(`${s.name} ${s.groupName ?? ''}`);
    return words.every((w) => hay.includes(w));
  };
  const rank = (s: Special) => (s.from === 'yours' ? 0 : 1);
  // 0.12.6: the ones Restock doesn't count as a real special come after the real ones, however sorted.
  const doubt = (s: Special) => (s.doubt ? 1 : 0);
  const by: Record<SpecialSort, (a: Special, b: Special) => number> = {
    saving: (a, b) => b.saving - a.saving || rank(a) - rank(b) || a.name.localeCompare(b.name),
    price: (a, b) => a.price - b.price || rank(a) - rank(b) || a.name.localeCompare(b.name),
    az: (a, b) => a.name.localeCompare(b.name) || rank(a) - rank(b),
  };
  return all.filter(hit).sort((a, b) => doubt(a) - doubt(b) || by[sort](a, b));
}
