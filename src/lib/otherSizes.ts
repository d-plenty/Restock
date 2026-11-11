import type { StoreProduct } from '../stores/types';
import { tokens } from '../stores/rank';
import { packSize } from './units';

// 0.9.1: "Other sizes of this" when adding or tracking an item. The same product, brand and flavour
// in other packs of the same can, bottle or jar (Solo 375mL cans × 10, × 24, × 30), and, if you want,
// in other container sizes (250mL cans, 1.25L bottles). Everything compares by the litre or 100 g.
//
// Matching is strict on purpose: the same brand, and exactly the same words in the name once sizes,
// pack counts and container words are taken out. Missing one is better than suggesting Coke Zero for
// Coke, or Nutella with breadsticks for Nutella.

/** Words that only say how it's packed or what kind of drink it is, never which product it is. Stemmed, as tokens() does. */
export const PACKING = new Set(
  [
    'soft',
    'drink',
    'multipack',
    'multi',
    'value',
    'bulk',
    'family',
    'case',
    'carton',
    'can',
    'tin',
    'bottle',
    'glass',
    'mini',
    'pouch',
    'jar',
    'tub',
    'block',
    'refill',
    'squeeze',
    'squeezy',
    'share',
    'sharing',
    'size',
    'bonus',
    'packet',
    'pack',
    'pk',
    'ml',
    'l',
    'lt',
    'ltr',
    'litre',
    'liter',
    'g',
    'kg',
    'gram',
    'x',
  ].map((w) => tokens(w)[0] ?? w),
);

/** How it's packed, when the name says: cans and bottles of the same size are different containers. */
export type Container = 'can' | 'bottle' | 'glass' | 'pouch' | 'jar' | 'tub' | 'squeeze' | 'sachet';

function containerOf(name: string): Container | undefined {
  const n = name.toLowerCase();
  if (/\bglass\b/.test(n)) return 'glass';
  if (/\b(cans?|tins?)\b/.test(n)) return 'can';
  if (/\bbottles?\b/.test(n)) return 'bottle';
  if (/\bpouch(es)?\b/.test(n)) return 'pouch';
  if (/\bjars?\b/.test(n)) return 'jar';
  if (/\btubs?\b/.test(n)) return 'tub';
  if (/\bsqueez(e|y)\b/.test(n)) return 'squeeze';
  if (/\bsachets?\b/.test(n)) return 'sachet';
  return undefined;
}

export interface Pack {
  /** The size of each can, bottle or jar, in g or ml. */
  each: number;
  unit: 'g' | 'ml';
  /** How many in the pack: 1 for one on its own. */
  count: number;
  container?: Container;
}

const NUM = '(\\d+(?:\\.\\d+)?|\\.\\d+)';
const toBase = (n: number, u: string) => (u === 'kg' || u === 'l' ? n * 1000 : n);
const unitOfText = (u: string): 'g' | 'ml' => (u === 'kg' || u === 'g' ? 'g' : 'ml');

/** "30x375ml", "10 × 375mL", "375mL x 24" or "4 x 420g" in a name or size. */
function multiIn(text: string | undefined): { count: number; each: number; unit: 'g' | 'ml' } | undefined {
  const s = (text ?? '')
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/litres?|liters?/g, 'l')
    .replace(/millilitres?|milliliters?/g, 'ml');
  let m = s.match(new RegExp(`(\\d+)\\s*x\\s*${NUM}\\s*(kg|g|ml|l)\\b`));
  if (m) return { count: parseInt(m[1], 10), each: toBase(parseFloat(m[2]), m[3]), unit: unitOfText(m[3]) };
  m = s.match(new RegExp(`${NUM}\\s*(kg|g|ml|l)\\s*x\\s*(\\d+)\\b`));
  if (m) return { count: parseInt(m[3], 10), each: toBase(parseFloat(m[1]), m[2]), unit: unitOfText(m[2]) };
  return undefined;
}

/**
 * What's in a pack: how many, and how big each one is. Undefined for things sold by the item
 * (tablets, rolls) or with no size Restock can read.
 */
export function packOf(sp: Pick<StoreProduct, 'name' | 'size'>): Pack | undefined {
  const ps = packSize(sp.size, sp.name);
  if (!ps || ps.unit === 'ea' || !(ps.qty > 0)) return undefined;
  const unit = ps.unit;
  const container = containerOf(sp.name);
  if (ps.count && ps.count > 1) return { each: ps.qty / ps.count, unit, count: ps.count, container };
  // Aldi: "Pepsi Max 30x375ml", size "11.25 l". The size is the whole pack; the name says how it's made up.
  const multi = multiIn(sp.name) ?? multiIn(sp.size);
  if (multi && multi.count > 1 && multi.unit === unit && Math.abs((multi.count * multi.each) / ps.qty - 1) <= 0.03)
    return { each: multi.each, unit, count: multi.count, container };
  // "Heinz Baked Beans 4 Pack", size "1.68kg".
  const named = sp.name.toLowerCase().match(/\b(\d+)\s*(?:packs?|pk)\b/);
  const n = named ? parseInt(named[1], 10) : 0;
  if (n > 1 && n <= 60) return { each: ps.qty / n, unit, count: n, container };
  return { each: ps.qty, unit, count: 1, container };
}

const brandWords = (brand: string | undefined) => tokens(brand);

/** Every word of the brand is in the product's name (or its own brand). */
const hasAll = (words: string[], inThese: Set<string>) => words.length > 0 && words.every((w) => inThese.has(w));

/**
 * The same product line: the same brand and the same name, flavour and variety, whatever the size
 * or pack. "Coca-Cola Classic Soft Drink Cans 375mL x 24 pack" and "Coca-Cola Classic Soft Drink
 * Bottle 1.25L" are; "Coca-Cola Zero Sugar …" and "Coca-Cola Vanilla …" aren't.
 */
export function sameLine(a: StoreProduct, b: StoreProduct): boolean {
  const ba = brandWords(a.brand);
  const bb = brandWords(b.brand);
  const all = (p: StoreProduct) => new Set([...tokens(p.name), ...brandWords(p.brand)]);
  const wa = all(a);
  const wb = all(b);
  // The brand: one product's brand has to be in both ("Sanitarium Up&Go …" from the shop that calls
  // the brand Up&Go). No brand at either: only at the same shop (its own brand, like Aldi's).
  const brandOk = ba.length || bb.length ? (hasAll(ba, wa) && hasAll(ba, wb)) || (hasAll(bb, wa) && hasAll(bb, wb)) : a.chain === b.chain;
  if (!brandOk) return false;
  const brands = new Set([...ba, ...bb]);
  const core = (p: StoreProduct) =>
    new Set(tokens(p.name).filter((w) => !brands.has(w) && !PACKING.has(w) && !/\d/.test(w) && !/^\d*(ml|l|g|kg)$/.test(w)));
  const ca = core(a);
  const cb = core(b);
  if (ca.size !== cb.size) return false;
  for (const w of ca) if (!cb.has(w)) return false;
  return true;
}

export interface SizeOption {
  sp: StoreProduct;
  pack: Pack;
  /** Price per gram or millilitre. */
  per: number;
  /** Compared with the one you have, per litre or 100 g: -0.2 is 20% cheaper. Undefined without a price for yours. */
  vs?: number;
}

export interface OtherSizes {
  /** The same can, bottle or jar in other pack counts. Fewest first. */
  packs: SizeOption[];
  /** The same product in another container size or kind (250mL cans, 1.25L bottles). Smallest first. */
  containers: SizeOption[];
  /** Yours, worked out the same way, for comparing. */
  mine?: { pack: Pack; per?: number };
}

const key = (p: StoreProduct) => `${p.chain}:${p.storeProductId}`;
const sameSize = (x: number, y: number) => x > 0 && y > 0 && Math.abs(x / y - 1) <= 0.02;

/**
 * Other sizes of `anchor` in `pool` (search results from every shop, the anchor's own included),
 * split into other packs of the same size and other container sizes. `skip`: products to leave out
 * (the ones the item already has). The same size and pack as yours isn't another size, so it's left
 * out too (that's the same product, found elsewhere).
 */
export function otherSizes(anchor: StoreProduct, pool: StoreProduct[], opts: { skip?: Set<string>; max?: number } = {}): OtherSizes {
  const max = opts.max ?? 6;
  const mine = packOf(anchor);
  if (!mine) return { packs: [], containers: [] };
  const minePer = anchor.price !== undefined && anchor.price > 0 ? anchor.price / (mine.each * mine.count) : undefined;
  const seen = new Set<string>([key(anchor), ...(opts.skip ?? [])]);
  const packs: SizeOption[] = [];
  const containers: SizeOption[] = [];
  for (const p of pool) {
    const k = key(p);
    if (seen.has(k) || p.price === undefined || !(p.price > 0)) continue;
    seen.add(k);
    const pack = packOf(p);
    if (!pack || pack.unit !== mine.unit || !sameLine(anchor, p)) continue;
    const size = sameSize(pack.each, mine.each);
    const sameContainer = !pack.container || !mine.container || pack.container === mine.container;
    if (size && sameContainer && pack.count === mine.count) continue;
    const per = p.price / (pack.each * pack.count);
    const option: SizeOption = { sp: p, pack, per, vs: minePer ? per / minePer - 1 : undefined };
    if (size && sameContainer) packs.push(option);
    else containers.push(option);
  }
  packs.sort((x, y) => x.pack.count - y.pack.count || x.per - y.per);
  containers.sort((x, y) => x.pack.each - y.pack.each || x.pack.count - y.pack.count || x.per - y.per);
  return { packs: packs.slice(0, max), containers: containers.slice(0, max), mine: { pack: mine, per: minePer } };
}

/** "375mL", "1.25L", "420g", "1kg". */
export function eachLabel(pack: Pack): string {
  const n = (x: number) => String(Math.round(x * 100) / 100);
  if (pack.unit === 'ml') return pack.each >= 1000 ? `${n(pack.each / 1000)}L` : `${n(pack.each)}mL`;
  return pack.each >= 1000 ? `${n(pack.each / 1000)}kg` : `${n(pack.each)}g`;
}

/** "375mL can × 24", "1.25L bottle", "420g × 4". */
export function packLabel(pack: Pack): string {
  const what = pack.container === 'glass' ? 'glass bottle' : pack.container === 'squeeze' ? 'squeeze pack' : pack.container;
  const one = `${eachLabel(pack)}${what ? ` ${what}` : ''}`;
  return pack.count > 1 ? `${one} × ${pack.count}` : one;
}

/** "12% cheaper per L", "8% dearer per 100g", or "Same per L". */
export function vsLabel(vs: number | undefined, unit: 'g' | 'ml'): string | undefined {
  if (vs === undefined || !Number.isFinite(vs)) return undefined;
  const per = unit === 'ml' ? 'per L' : 'per 100g';
  const pct = Math.round(Math.abs(vs) * 100);
  if (pct < 1) return `Same ${per}`;
  return `${pct}% ${vs < 0 ? 'cheaper' : 'dearer'} ${per}`;
}
