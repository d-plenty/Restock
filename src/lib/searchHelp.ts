import { nameOnly, score, stem, tokens, typedSize, type RankQuery } from '../stores/rank';
import { brandKind } from './brandKinds';
import { kindOf } from './naming';
import type { StoreProduct } from '../stores/types';
import { packSize, tidyUnitText, unitPrice } from './units';
import { readSize, storePriceLine } from './unitPrice';

// Small helpers that make searching friendlier: everyday Australian names for things,
// common misspellings, matching the same product across stores, and unit prices.

/** What people say → what the stores call it. Whole words or phrases only. */
const SYNONYMS: [RegExp, string][] = [
  [/\b(loo|dunny|bog) (paper|roll)s?\b/g, 'toilet paper'],
  [/\btp\b/g, 'toilet paper'],
  // Shops write it out (0.8.6).
  [/\bvb\b/g, 'victoria bitter'],
  [/\bcoke\b/g, 'coca cola'],
  [/\bloo rolls?\b/g, 'toilet paper'],
  [/\bsoft ?drinks?\b/g, 'soft drink'],
  [/\bfizzy drinks?\b/g, 'soft drink'],
  [/\bsnags?\b/g, 'sausages'],
  [/\bbangers\b/g, 'sausages'],
  [/\bchook\b/g, 'chicken'],
  [/\bbrekkie\b/g, 'breakfast'],
  [/\blollies\b/g, 'confectionery'],
  [/\bcordial\b/g, 'cordial'],
  [/\btomato ketchup\b/g, 'tomato sauce'],
  [/\bketchup\b/g, 'tomato sauce'],
  [/\bclingwrap\b|\bcling film\b|\bglad wrap\b/g, 'cling wrap'],
  [/\bdishwashing liquid\b|\bdish soap\b|\bwashing up liquid\b/g, 'dishwashing liquid'],
  [/\bwashing powder\b/g, 'laundry powder'],
  [/\bwashing liquid\b/g, 'laundry liquid'],
  [/\bnappies\b|\bdiapers?\b/g, 'nappies'],
  [/\bserviettes?\b|\bnapkins?\b/g, 'napkins'],
  [/\bcapsicums?\b|\bbell peppers?\b/g, 'capsicum'],
  [/\bzucchinis?\b|\bcourgettes?\b/g, 'zucchini'],
  [/\baubergines?\b|\beggplants?\b/g, 'eggplant'],
  [/\bmince meat\b|\bground beef\b/g, 'beef mince'],
  [/\bcoriander\b|\bcilantro\b/g, 'coriander'],
  [/\bicy poles?\b|\bice blocks?\b/g, 'ice blocks'],
  [/\bbikkies\b|\bbiccies\b|\bcookies\b/g, 'biscuits'],
  [/\bcrisps\b/g, 'chips'],
  [/\bmilo\b/g, 'milo'],
];

/** Common misspellings of things people actually search for. */
const TYPOS: Record<string, string> = {
  vegimite: 'vegemite',
  vegemight: 'vegemite',
  vegamite: 'vegemite',
  nutela: 'nutella',
  nuttela: 'nutella',
  chese: 'cheese',
  cheeze: 'cheese',
  yogurt: 'yoghurt',
  yougurt: 'yoghurt',
  yoghut: 'yoghurt',
  tomatoe: 'tomato',
  tomatos: 'tomatoes',
  potatoe: 'potato',
  potatos: 'potatoes',
  brocoli: 'broccoli',
  broccolli: 'broccoli',
  bannana: 'banana',
  bananna: 'banana',
  avacado: 'avocado',
  avocardo: 'avocado',
  spagetti: 'spaghetti',
  spagheti: 'spaghetti',
  cereral: 'cereal',
  cerial: 'cereal',
  biscut: 'biscuit',
  biscuts: 'biscuits',
  choclate: 'chocolate',
  chocolat: 'chocolate',
  chocalate: 'chocolate',
  coffe: 'coffee',
  cofee: 'coffee',
  sause: 'sauce',
  suace: 'sauce',
  shampo: 'shampoo',
  tissu: 'tissue',
  toilette: 'toilet',
  detergant: 'detergent',
  mayonaise: 'mayonnaise',
  mayonase: 'mayonnaise',
  mozzarela: 'mozzarella',
  mozarella: 'mozzarella',
  parmasan: 'parmesan',
  lettuse: 'lettuce',
  lettice: 'lettuce',
  sandwhich: 'sandwich',
  vinager: 'vinegar',
  vinegre: 'vinegar',
  weetbix: 'weet-bix',
  chiken: 'chicken',
  chicen: 'chicken',
  chikken: 'chicken',
  banannas: 'bananas',
  bannanas: 'bananas',
  brocolli: 'broccoli',
  sausuages: 'sausages',
  sasuages: 'sausages',
  yoghurts: 'yoghurt',
  margerine: 'margarine',
  parcetamol: 'paracetamol',
  paracetemol: 'paracetamol',
  ibuprofin: 'ibuprofen',
  ibrupofen: 'ibuprofen',
  shampoos: 'shampoo',
  toothpast: 'toothpaste',
  weetbic: 'weet-bix',
};

/** Cleans up a typed search: fixes common misspellings and swaps in the stores' words. */
export function normaliseQuery(input: string): string {
  let s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  s = s
    .split(' ')
    .map((w) => TYPOS[w] ?? w)
    .join(' ');
  for (const [re, to] of SYNONYMS) s = s.replace(re, to);
  return s;
}

/** True when cleaning up the query changed what will be searched. */
export function queryChanged(input: string): boolean {
  return normaliseQuery(input) !== input.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Price per 100 g, per litre or per item, worked out from the size, for comparing and sorting. */
export function unitOf(sp: StoreProduct): { per: number; unit: 'g' | 'ml' | 'ea' } | undefined {
  if (sp.price === undefined) return undefined;
  // 0.9.6: from the words and the shop's own unit price; a pack of drinks with no size has none (never compared by the litre).
  const size = readSize(sp).size;
  if (!size) return undefined;
  const per = unitPrice(sp.price, size.qty, size.unit);
  return per === undefined ? undefined : { per, unit: size.unit };
}

/**
 * The unit price to show for a search result. Usually the store's own label, but when the store
 * prices a pack per item ("$0.87 / 1EA" for a 30 pack of 375 ml cans) and Restock can work out
 * the litres or grams, show that instead so every store reads the same way.
 */
export function unitTextOf(sp: StoreProduct, pool: StoreProduct[] = []): string {
  // 0.9.6: both prices, per item then the comparison price, the same on every screen. Our own sum
  // (size from the words, a barcode match or a look-alike) wins; failing that, the shop's own unit price
  // label when it isn't just "each"; failing that, "size unknown" (never a silent guess).
  const l = storePriceLine(sp, pool);
  if (l.compare) return l.text;
  const shop = tidyUnitText(sp.unitPriceText);
  const own = shop && !/\b(ea|each)\b/i.test(shop) ? shop : undefined;
  return [l.each, own ?? (l.unknown ? 'size unknown' : undefined)].filter(Boolean).join(' · ');
}

// Words that only say which store's version it is, so "Coles Diced Tomatoes" can match "Woolworths Diced Tomatoes".
const HOUSE = new Set(['coles', 'woolworths', 'woolworth', 'aldi', 'macro', 'essentials', 'select', 'simply', 'finest', 'smart', 'buy']);

function words(sp: StoreProduct): Set<string> {
  return new Set(tokens(`${sp.brand ?? ''} ${sp.name}`).filter((w) => !HOUSE.has(w)));
}

/**
 * Words that tell one version of a product from another: flavours, scents and varieties. Two
 * products that each name a different one (Vanilla vs Choc) are different products, however much
 * else they share. Stemmed, like tokens().
 */
const VARIANTS = new Set(
  [
    'vanilla',
    'choc',
    'chocolate',
    'strawberry',
    'banana',
    'caramel',
    'coffee',
    'mocha',
    'honey',
    'mint',
    'peppermint',
    'lemon',
    'lime',
    'orange',
    'mango',
    'berry',
    'blueberry',
    'raspberry',
    'apple',
    'cherry',
    'coconut',
    'peach',
    'passionfruit',
    'tropical',
    'pineapple',
    'watermelon',
    'grape',
    'cola',
    'ginger',
    'cinnamon',
    'hazelnut',
    'almond',
    'peanut',
    'cookies',
    'original',
    'classic',
    'plain',
    'natural',
    'unsalted',
    'salted',
    'lite',
    'light',
    'full',
    'skim',
    'reduced',
    'diet',
    'zero',
    'sugarfree',
    'smooth',
    'crunchy',
    'chunky',
    'mild',
    'hot',
    'spicy',
    'bbq',
    'garlic',
    'onion',
    'tomato',
    'cheese',
    'chicken',
    'beef',
    'lamb',
    'pork',
    'fish',
    'tuna',
    'salmon',
    'repair',
    'strengthen',
    'volume',
    'colour',
    'color',
    'dry',
    'oily',
    'sensitive',
    'fresh',
    'lavender',
    'rose',
    'eucalyptus',
    'aloe',
    'cucumber',
    'tea',
    'white',
    'dark',
    'milk',
    'red',
    'green',
    'black',
    'gold',
    'blue',
    'pink',
    'unscented',
    'fragrance',
    'free',
    'gluten',
    'lactose',
    'organic',
    'wholemeal',
    'multigrain',
  ].map(stem),
);

/** Is the brand (not a supermarket's own) one of the words both products share? */
function sharedBrand(a: StoreProduct, b: StoreProduct, shared: Set<string>): boolean {
  return [a.brand, b.brand].some((br) => {
    const w = tokens(br).filter((x) => !HOUSE.has(x));
    return w.length > 0 && w.every((x) => shared.has(x));
  });
}

function sizeKey(sp: StoreProduct): string | undefined {
  const s = packSize(sp.size, sp.name);
  return s ? `${Math.round(s.qty)}${s.unit}` : undefined;
}

/**
 * How sure we are that two products at different stores are the same thing (0 to 1).
 * Same barcode is certain. Otherwise the size has to match and most of the words have to agree.
 */
export function sameness(a: StoreProduct, b: StoreProduct): number {
  if (a.chain === b.chain) return 0;
  if (sameCode(a.barcode, b.barcode)) return 1;
  const sa = sizeKey(a);
  const sb = sizeKey(b);
  if (!sa || sa !== sb) return 0;
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  const both = new Set([...wa].filter((w) => wb.has(w)));
  const shared = both.size;
  let score = shared / (wa.size + wb.size - shared);
  // Different flavours or varieties (Vanilla Ice vs Choc Ice) are different products.
  const va = [...wa].filter((w) => VARIANTS.has(w) && !wb.has(w));
  const vb = [...wb].filter((w) => VARIANTS.has(w) && !wa.has(w));
  if (va.length && vb.length) return Math.min(score, 0.3);
  // One shop's shorter name for the same thing ("Nutella 400g" and "Nutella Hazelnut Chocolate
  // Spread 400g"): same size, every word of the short name in the long one, and the brand shared.
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  if (score < 0.65 && [...small].every((w) => big.has(w)) && sharedBrand(a, b, both)) score = 0.65;
  // A brand in one but not the other ("Heinz" vs nothing) is fine; different brands are not.
  const ba = a.brand ? stem(a.brand.toLowerCase().split(/\s+/)[0]) : undefined;
  const bb = b.brand ? stem(b.brand.toLowerCase().split(/\s+/)[0]) : undefined;
  if (ba && bb && ba !== bb && !HOUSE.has(ba) && !HOUSE.has(bb)) return Math.min(score, 0.3);
  return score;
}

/** For a product you ticked, the best match at each other store (only confident ones). */
export function matchesFor(picked: StoreProduct, others: StoreProduct[], min = 0.6): StoreProduct[] {
  const best = new Map<string, { sp: StoreProduct; s: number }>();
  for (const o of others) {
    if (o.chain === picked.chain) continue;
    const s = sameness(picked, o);
    if (s < min) continue;
    const cur = best.get(o.chain);
    if (!cur || s > cur.s) best.set(o.chain, { sp: o, s });
  }
  return [...best.values()].map((x) => x.sp);
}

// ---------- the best match for something scanned ----------

export interface BestMatch {
  sp: StoreProduct;
  /**
   * barcode: the same barcode. same: the same product and size as the match at another shop.
   * name: the scan's name, brand and size all agree. closest: the clear front-runner for the
   * scan's name and brand (the size wasn't known), worth a check. chosen: you picked it.
   */
  sure: 'barcode' | 'same' | 'name' | 'closest' | 'chosen';
}

/** Barcodes written with or without leading zeros (GTIN-14 vs EAN-13) are the same code. */
export function sameCode(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const clean = (x: string) => x.replace(/\D/g, '').replace(/^0+/, '');
  return clean(a) !== '' && clean(a) === clean(b);
}

/** How well the best result at a shop matches at all, so a shop with nothing like it can say so. */
export function bestScore(q: RankQuery, items: StoreProduct[]): number {
  return items.reduce((m, p, i) => Math.max(m, score(q, p, i)), -Infinity);
}

/** Below this, a shop's results are nothing like what was scanned or typed. */
export const UNLIKELY = 0.35;

/** A scan that only says the brand ("Earth Choice"), so it can't tell one of the brand's products from another. */
export function brandOnly(q: RankQuery): boolean {
  if (!q.brand) return false;
  const brand = new Set(tokens(q.brand));
  return tokens(q.text).every((t) => brand.has(t));
}

const hasBrand = (q: RankQuery, p: StoreProduct) => {
  const want = tokens(q.brand ?? '');
  const have = new Set(tokens(`${p.brand ?? ''} ${p.name}`));
  return want.length > 0 && want.every((w) => have.has(w));
};

/**
 * For a scanned product, the one at each shop Restock is confident is the same thing, to tick
 * for you: an exact barcode first; then, with no barcode match anywhere, a result whose name,
 * brand and size all line up with the scan, or the clear front-runner by name and brand. Once
 * one shop has a match, the other shops get the product with the same size and name as it.
 * Shops with nothing that sure are left out (a brand-only scan is left to the person).
 */
export function bestMatches(q: RankQuery, byChain: Partial<Record<string, StoreProduct[]>>): Map<string, BestMatch> {
  const out = new Map<string, BestMatch>();
  for (const [chain, items] of Object.entries(byChain)) {
    const hit = q.barcode ? items?.find((p) => sameCode(p.barcode, q.barcode)) : undefined;
    if (hit) out.set(chain, { sp: hit, sure: 'barcode' });
  }
  if (!out.size && !brandOnly(q)) {
    const qs = q.size ? packSize(q.size, '') : undefined;
    for (const [chain, items] of Object.entries(byChain)) {
      if (!items?.length) continue;
      const ranked = items.map((p, i) => ({ p, s: score(q, p, i) })).sort((a, b) => b.s - a.s);
      const top = ranked[0];
      const second = ranked[1]?.s ?? -Infinity;
      if (!top || !q.brand || !hasBrand(q, top.p)) continue;
      const ps = packSize(top.p.size, top.p.name);
      const sizeAgrees = !!qs && !!ps && ps.unit === qs.unit && Math.abs(ps.qty / qs.qty - 1) <= 0.05;
      if (qs && !sizeAgrees) continue;
      // Name, brand and size all agree, and nothing else is as close.
      if (sizeAgrees && top.s >= 0.9 && second <= top.s - 0.05) out.set(chain, { sp: top.p, sure: 'name' });
      // No size to go on: only a clear front-runner.
      else if (!qs && top.s >= 0.8 && second <= top.s - 0.12) out.set(chain, { sp: top.p, sure: 'closest' });
    }
  }
  // The rest of the shops: the same product and size as a match found elsewhere.
  const anchors = [...out.values()].sort((a, b) => RANK[a.sure] - RANK[b.sure]).map((m) => m.sp);
  for (const [chain, items] of Object.entries(byChain)) {
    if (out.has(chain) || !items?.length) continue;
    for (const anchor of anchors) {
      const same = matchesFor(anchor, items, 0.6)[0];
      if (same) {
        out.set(chain, { sp: same, sure: 'same' });
        break;
      }
    }
  }
  return out;
}

const RANK: Record<BestMatch['sure'], number> = { barcode: 0, chosen: 1, name: 2, same: 3, closest: 4 };

export interface Candidate {
  /** The best version of it, for the name and photo. */
  sp: StoreProduct;
  /** The same product at each shop that has it. */
  at: StoreProduct[];
}

/**
 * When a scan can't be matched for sure: the brand's products across your shops, with the same
 * product at different shops grouped together, most widely sold first. Tapping one ticks it
 * everywhere it's sold.
 */
export function whichOne(q: RankQuery, byChain: Partial<Record<string, StoreProduct[]>>, max = 8): Candidate[] {
  const pool = Object.values(byChain)
    .flatMap((items) => items ?? [])
    .filter((p) => hasBrand(q, p));
  const groups: Candidate[] = [];
  for (const p of pool) {
    const g = groups.find((x) => !x.at.some((y) => y.chain === p.chain) && x.at.some((y) => sameness(y, p) >= 0.6));
    if (g) g.at.push(p);
    else groups.push({ sp: p, at: [p] });
  }
  // A brand-only scan can't say which is closer, so the most widely sold come first; otherwise
  // the closest to what the scan said.
  const only = brandOnly(q);
  const fit = (g: Candidate) => Math.max(...g.at.map((p) => score(q, p)));
  return groups
    .map((g, i) => ({ g, i, s: only ? 0 : fit(g) }))
    .sort((a, b) => b.s - a.s || b.g.at.length - a.g.at.length || a.i - b.i)
    .slice(0, max)
    .map(({ g }) => g);
}

// ---------- recent searches ----------

const RECENT_KEY = 'recentSearches';

export function recentSearches(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function rememberSearch(q: string): void {
  const t = q.trim();
  if (!t || /^\d{8,14}$/.test(t)) return;
  try {
    const next = [t, ...recentSearches().filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage can be unavailable
  }
}

export function clearRecentSearches(): void {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // ignore
  }
}

// ---------- like the one you ticked, at another shop (0.7.6) ----------

/**
 * Products at another shop most like the one you ticked: the same kind of thing first (by its
 * type and by what you searched for), then a similar size, then a similar price, and a little
 * extra for the same brand. Best first. Used when that shop doesn't sell the very same product.
 */
export function likeThis(anchor: StoreProduct, pool: StoreProduct[], kind: string, searched?: string, max = 3): StoreProduct[] {
  const kindQ: RankQuery = { text: kind };
  const typedQ: RankQuery | undefined = searched ? { text: searched } : undefined;
  const a = packSize(anchor.size, anchor.name);
  const near = (x: number, y: number, spread: number) => (x > 0 && y > 0 ? 1 - Math.min(1, Math.abs(Math.log(x / y)) / Math.log(spread)) : 0);
  const brand = anchor.brand?.toLowerCase();
  const seen = new Set<string>();
  const scored: { sp: StoreProduct; s: number }[] = [];
  for (const p of pool) {
    if (p.chain === anchor.chain || p.price === undefined || seen.has(p.storeProductId)) continue;
    seen.add(p.storeProductId);
    const rel = Math.max(score(kindQ, p), typedQ ? score(typedQ, p) : 0);
    if (rel < 0.45) continue;
    const b = packSize(p.size, p.name);
    const size = a && b && a.unit === b.unit ? near(a.qty, b.qty, 3) : 0.3;
    const price = anchor.price !== undefined ? near(anchor.price, p.price, 2.5) : 0.3;
    const sameBrand = brand && (p.brand?.toLowerCase() === brand || p.name.toLowerCase().includes(brand)) ? 0.15 : 0;
    scored.push({ sp: p, s: Math.min(1.2, rel) * 0.5 + size * 0.25 + price * 0.25 + sameBrand });
  }
  return scored
    .sort((x, y) => y.s - x.s)
    .slice(0, max)
    .map((x) => x.sp);
}

// ---------- recommended results and sure picks for a typed search (0.8.5) ----------

export interface Scored {
  sp: StoreProduct;
  s: number;
}

/** Every result scored and best first, counting where the shop itself put it. */
export function scoreAll(q: RankQuery, items: StoreProduct[]): Scored[] {
  return items.map((sp, i) => ({ sp, s: score(q, sp, i) })).sort((a, b) => b.s - a.s);
}

/** A result this good is the thing you searched for, not just something like it. */
export const GOOD = 0.85;

/**
 * The results worth recommending at a shop: good matches in their own right and close to the
 * best one there. Up to three; none when nothing there is a good match.
 */
export function topPicks(scored: Scored[], max = 3): StoreProduct[] {
  const best = scored[0]?.s ?? -Infinity;
  return scored
    .filter((x) => x.s >= GOOD && x.s >= best - 0.1)
    .slice(0, max)
    .map((x) => x.sp);
}

/**
 * A typed search specific enough to tick for you ("western star butter 500g"): the size or pack
 * you typed matches, the name matches well, and nothing else at that shop comes close. The shop
 * with the surest one; undefined when no shop is that sure, which is most of the time.
 */
export function surePick(q: RankQuery, byChain: Partial<Record<string, Scored[]>>): StoreProduct | undefined {
  if (q.barcode) return undefined;
  const typed = typedSize(q.text);
  if (!typed.size && !typed.count) return undefined;
  let best: Scored | undefined;
  for (const scored of Object.values(byChain)) {
    const [top, second] = scored ?? [];
    if (!top || top.s < 1.1 || (second && second.s > top.s - 0.06)) continue;
    const ps = packSize(top.sp.size, top.sp.name);
    if (!ps) continue;
    const sizeOk = !typed.size || (ps.unit === typed.size.unit && Math.abs(ps.qty / typed.size.qty - 1) <= 0.05);
    const have = ps.count ?? (ps.unit === 'ea' ? ps.qty : undefined);
    const countOk = !typed.count || have === typed.count;
    if (sizeOk && countOk && (!best || top.s > best.s)) best = top;
  }
  return best?.sp;
}

// ---------- the same kind of thing, at a shop that doesn't have what you typed (0.8.6) ----------

/**
 * What a typed search is after, for searching again at shops that came back with nothing like it.
 * A search that names a kind ("western star butter") is after that kind. A search that's only a
 * name ("western star") is after whatever the shops that do have it say it is (all butter at
 * Woolworths and Coles), or failing that, what Restock knows that brand to be. Undefined when
 * there's nothing better to search for than what you typed.
 */
export function intendedKind(q: RankQuery, byChain: Partial<Record<string, Scored[]>>): string | undefined {
  if (q.barcode) return undefined;
  const typed = q.text.trim().toLowerCase();
  const own = kindOf(typed);
  // "panadol", "milo": brands that name the thing itself still mean a kind (paracetamol, drinking chocolate).
  const brandItem = !!own && !!brandKind(typed) && tokens(own).every((t) => tokens(typed).includes(t));
  const kind = (() => {
    if (!nameOnly(tokens(typed)) && !brandItem) return own;
    const votes = new Map<string, number>();
    let picks = 0;
    for (const scored of Object.values(byChain)) {
      if (!scored?.length || scored[0].s < GOOD) continue;
      for (const sp of topPicks(scored)) {
        picks++;
        const k = kindOf(sp.name);
        if (k && !tokens(typed).includes(stem(k))) votes.set(k, (votes.get(k) ?? 0) + 1);
      }
    }
    const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (best && best[1] * 2 >= picks) return best[0];
    return brandKind(typed);
  })();
  return kind && kind !== typed ? kind : undefined;
}

/** Shops whose results are nothing like the search (or that found nothing at all). */
export function weakShops(byChain: Partial<Record<string, Scored[]>>): string[] {
  return Object.entries(byChain)
    .filter(([, scored]) => !scored?.length || scored[0].s < UNLIKELY)
    .map(([chain]) => chain);
}
