import { tokens } from '../stores/rank';
import type { BaseUnit, Product, SizeBasis, Sizing } from '../types';
import { PACKING } from './otherSizes';
import { costcoEstimatedSize } from './costcoSizing';
import { inSheets, money, packSize, rollsIn, tidySize, type CompareStyle, type PackSize } from './units';

export type { CompareStyle };

// 0.9.6: two prices on every product line, and a size for products whose shop gave none.
//
//   per item          "$0.98 each"            for understanding (what one can costs)
//   comparison price  "$2.61 / L", "$1.25 / 100g", "$0.45 per 100 sheets"
//                     the only thing that decides cheapest, best pick and Great deal
//
// When the shop gives no size ("Sprite Soft Drink Cans Lemonade Cca Flavour", "24 Pack"), Restock
// works one out, in this order, and always says how sure it is:
//   1. the words of the name, size and unit price (10x375ml, 375mL x 24 pack, 1.58kg)   shop
//   2. the same barcode at another shop or in your catalogue                            barcode
//   3. the same brand and product line, the same pack count and the same price each     estimated
//   4. a common size (375 mL soft drink cans): a suggestion only, never used to compare
//   5. ask once, in the "Amount for unit pricing" box, with the guess filled in         confirmed
// With nothing it can trust, it says "size unknown" and leaves that line out of the cheapest comparison.

/** What Restock needs to know about a product to size it: a saved product or a shop's search result. */
export interface SizeSource {
  name: string;
  size?: string;
  brand?: string;
  barcode?: string;
  /** Typed in by the person (confirmed). */
  qty?: number;
  qtyUnit?: BaseUnit;
  /** A shop's own unit price words ("$2.61 / 1L"), when there are some. */
  unitPriceText?: string;
  chain?: string;
}

/** A product with its price, for looking at look-alikes. */
export interface PoolItem extends SizeSource {
  id?: string;
  price?: number;
}

// ---------- 1: reading the words ----------

const DRINK =
  /\b(soft ?drinks?|cola|coke|lemonade|sprite|fanta|pepsi|solo|schweppes|mountain dew|ginger beer|creaming soda|tonic|soda|mineral water|spring water|sparkling|water|juice|cordial|energy drinks?|iced tea|beer|lager|ale|cider|stout|seltzer|premix|rtd|cans?|bottles?|stubbies|longnecks?)\b/i;

/** "24 Pack", "30 cans" or "6pk": how many in the pack (more than one). */
function packCountOf(name: string | undefined, size: string | undefined): number | undefined {
  for (const text of [size, name]) {
    const m = text?.toLowerCase().match(/(\d+)\s*(?:packs?|pk|cans?|bottles?|stubbies)\b/);
    const n = m ? parseInt(m[1], 10) : 0;
    if (n > 1) return n;
  }
  return undefined;
}

const toBase = (n: number, u: string): { qty: number; unit: BaseUnit } =>
  u === 'kg' ? { qty: n * 1000, unit: 'g' } : u === 'g' ? { qty: n, unit: 'g' } : u === 'l' ? { qty: n * 1000, unit: 'ml' } : { qty: n, unit: 'ml' };

/** The size a shop's own unit price says: $23.50 at "$2.61 / 1L" is 9 L. Snapped when it is within 1.5% of a round number. */
function fromUnitPrice(text: string | undefined, price: number | undefined): PackSize | undefined {
  if (!text || !price || !(price > 0)) return undefined;
  const m = text.toLowerCase().replace(/litres?|liters?/g, 'l').match(/\$\s*(\d+(?:\.\d+)?)\s*(?:per|\/)\s*(\d+(?:\.\d+)?)?\s*(kg|g|ml|l)\b/);
  if (!m) return undefined;
  const u = parseFloat(m[1]);
  if (!(u > 0)) return undefined;
  const base = toBase((price / u) * (m[2] ? parseFloat(m[2]) : 1), m[3]);
  const snap = Math.round(base.qty / 25) * 25;
  const qty = snap > 0 && Math.abs(snap / base.qty - 1) <= 0.015 ? snap : Math.round(base.qty);
  return qty > 0 ? { qty, unit: base.unit } : undefined;
}

interface Read {
  size?: NonNullable<Sizing['size']>;
  packCount?: number;
}

/** What the words say: the person's amount, the name, the size, the shop's unit price. No look-alikes yet. */
export function readSize(p: SizeSource & { price?: number }): Read {
  // 0.9.6: a Costco size worked out from Costco's own unit price is an estimate (costcoSizing.ts).
  const costco = !p.qty ? costcoEstimatedSize(p) : undefined;
  if (costco) return costco;
  const pc = packCountOf(p.name, p.size);
  if (p.qty && p.qtyUnit) {
    const own = packSize(p.size, p.name);
    const count = p.qtyUnit !== 'ea' ? (own && own.unit === p.qtyUnit && own.count && own.count > 1 ? own.count : pc) : undefined;
    return { size: { qty: p.qty, unit: p.qtyUnit, count, basis: 'confirmed' }, packCount: count ?? pc };
  }
  // Every field, in turn: size and name together, the name alone, the size alone, then the shop's unit price.
  const tries = [packSize(p.size, p.name), packSize(undefined, p.name), packSize(p.size, undefined), fromUnitPrice(p.unitPriceText, p.price)];
  const measured = tries.find((t) => t && t.unit !== 'ea');
  if (measured) {
    const count = measured.count ?? (pc && measured.unit !== 'ea' ? pc : undefined);
    return { size: { qty: measured.qty, unit: measured.unit, count: count && count > 1 ? count : undefined, basis: 'shop' }, packCount: count ?? pc };
  }
  const counted = tries.find((t) => t && t.unit === 'ea');
  // "24 Pack" of drinks, and nothing about how big each is: that's no size at all.
  if (counted && pc && DRINK.test(`${p.name} ${p.size ?? ''}`)) return { packCount: pc };
  if (counted) return { size: { qty: counted.qty, unit: 'ea', basis: 'shop' }, packCount: pc };
  return { packCount: pc };
}

// ---------- 2 to 4: barcode, look-alikes, common sizes ----------

const code = (b: string | undefined) => {
  const d = (b ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return d.length >= 8 ? d : undefined;
};

const brandWords = (p: SizeSource) => {
  const b = tokens(p.brand);
  return b.length ? b : tokens(p.name).slice(0, 1);
};
const inName = (words: string[], all: Set<string>) => words.length > 0 && words.every((w) => all.has(w));
/** Words that make no difference to which product it is. */
const FILLER = new Set(['cca', 'flavour', 'flavor', 'flavoured', 'flavored', 'australia', 'australian', 'aust', 'brand'].map((w) => tokens(w)[0] ?? w));

/**
 * The same product line under another shop's name: the same brand and the same words once packing
 * and filler are taken out. "Sprite Soft Drink Cans Lemonade Cca Flavour" and "Sprite Lemonade Soft
 * Drink Cans" are; "Sprite Zero Lemonade" isn't (zero is a different drink).
 */
export function sameProductLine(a: SizeSource, b: SizeSource): boolean {
  const ba = brandWords(a);
  const bb = brandWords(b);
  const wa = new Set([...tokens(a.name), ...tokens(a.brand)]);
  const wb = new Set([...tokens(b.name), ...tokens(b.brand)]);
  if (!((inName(ba, wa) && inName(ba, wb)) || (inName(bb, wa) && inName(bb, wb)))) return false;
  const brands = new Set([...ba, ...bb]);
  const core = (p: SizeSource) =>
    new Set(tokens(p.name).filter((w) => !brands.has(w) && !PACKING.has(w) && !FILLER.has(w) && !/\d/.test(w) && !/^\d*(ml|l|g|kg)$/.test(w)));
  const ca = core(a);
  const cb = core(b);
  if (ca.size !== cb.size) return false;
  for (const w of ca) if (!cb.has(w)) return false;
  return true;
}

interface Common {
  test: RegExp;
  not?: RegExp;
  each: number;
  unit: 'ml';
  min: number;
  why: string;
}
/** Sizes that are nearly always the same. Only ever a suggestion for the person to confirm. */
const COMMON: Common[] = [
  {
    test: /\b(soft ?drinks?|cola|coke|lemonade|sprite|fanta|pepsi|solo|schweppes|mountain dew|ginger beer|creaming soda|tonic|soda)\b/i,
    not: /\b(bottles?|litres?|liters?|\d+\s?l)\b/i,
    each: 375,
    unit: 'ml',
    min: 6,
    why: 'Soft drink cans are usually 375 mL.',
  },
  {
    test: /\b(beer|lager|ale|cider|stout|seltzer|premix|rtd)\b/i,
    not: /\b(bottles?|stubbies|longnecks?|litres?|liters?|\d+\s?l)\b/i,
    each: 375,
    unit: 'ml',
    min: 4,
    why: 'Cans of beer and cider are usually 375 mL.',
  },
  {
    test: /\b(water)\b/i,
    not: /\b(cans?|litres?|liters?|\d+\s?l)\b/i,
    each: 600,
    unit: 'ml',
    min: 6,
    why: 'Bottles of water in a multipack are usually 600 mL.',
  },
];

function commonGuess(p: SizeSource, count: number | undefined): Sizing['guess'] {
  if (!count || count < 2) return undefined;
  const text = `${p.name} ${p.size ?? ''}`;
  for (const c of COMMON) {
    if (count >= c.min && c.test.test(text) && !(c.not && c.not.test(text)) && (c.each !== 600 || /\bbottles?\b/i.test(text) || !/\bcans?\b/i.test(text)))
      return { qty: c.each * count, unit: c.unit, count, why: c.why };
  }
  return undefined;
}

const SAME_PRICE = 0.03;

/**
 * The size of one product, from its own words, then a barcode match in `pool`, then a look-alike
 * there (same brand, line, pack count and price each), then a common-size guess (not used to
 * compare). `pool` is every other product to look at (the item's other shops, the catalogue).
 */
export function sizeUp(target: PoolItem, pool: PoolItem[] = []): Sizing {
  const own = readSize(target);
  if (own.size) return { size: own.size, packCount: own.packCount, unknown: false };
  const others = pool.filter((o) => o !== target && !(o.id && o.id === target.id));
  const read = others.map((o) => ({ o, r: readSize(o) })).filter((x) => x.r.size);

  const mine = code(target.barcode);
  if (mine) {
    const hit = read.find((x) => code(x.o.barcode) === mine);
    if (hit?.r.size) {
      const s = hit.r.size;
      return { size: { qty: s.qty, unit: s.unit, count: s.count ?? own.packCount, basis: 'barcode', from: from(hit.o) }, packCount: own.packCount, unknown: false };
    }
  }

  const count = own.packCount;
  if (count && count > 1 && target.price !== undefined && target.price > 0) {
    const each = target.price / count;
    const twin = read.find(({ o, r }) => {
      const s = r.size!;
      if (s.unit === 'ea' || (s.count ?? r.packCount) !== count || s.basis === 'estimated') return false;
      if (o.price === undefined || !(o.price > 0)) return false;
      if (Math.abs(o.price / count / each - 1) > SAME_PRICE) return false;
      return sameProductLine(target, o);
    });
    if (twin) {
      const s = twin.r.size!;
      return { size: { qty: s.qty, unit: s.unit, count, basis: 'estimated', from: from(twin.o) }, packCount: count, unknown: false };
    }
  }

  const guess = commonGuess(target, count);
  return { guess, packCount: count, unknown: true };
}

const from = (o: SizeSource) => o.chain ?? '';

/**
 * Sizes every product of one item against the others (their prices are the latest shelf price each),
 * plus `extra` products to match barcodes against. Returns copies with `sizing` set.
 */
export function withSizes(products: Product[], priceOf: (id: string) => number | undefined, extra: Product[] = []): Product[] {
  const pool: PoolItem[] = [...products, ...extra].map((p) => ({ ...p, price: priceOf(p.id) }));
  return products.map((p, i) => ({ ...p, sizing: sizeUp(pool[i], pool) }));
}

/** A product's sizing: from the item's look-alikes when it has been worked out, else from its own words. */
export function sizingOf(p: SizeSource & { sizing?: Sizing }): Sizing {
  return p.sizing ?? sizeUp(p);
}

/** True when the product has a size to compare by (confirmed, the shop's, a barcode match or a look-alike). */
export const hasSize = (p: SizeSource & { sizing?: Sizing }) => !!sizingOf(p).size;

// ---------- labels ----------

const n2 = (x: number) => String(Math.round(x * 100) / 100);
const mlText = (ml: number) => (ml >= 1000 ? `${n2(ml / 1000)} L` : `${n2(ml)} mL`);
const gText = (g: number) => (g >= 1000 ? `${n2(g / 1000)} kg` : `${n2(g)} g`);
const measureText = (qty: number, unit: BaseUnit) => (unit === 'ml' ? mlText(qty) : unit === 'g' ? gText(qty) : `${n2(qty)}`);

/** The words for how it was found, to say next to a size or comparison price. Nothing for a size the shop gave. */
export function basisWord(b: SizeBasis | undefined): string | undefined {
  return b === 'estimated' ? 'estimated' : b === 'confirmed' ? 'confirmed' : b === 'barcode' ? 'from barcode' : undefined;
}

/**
 * The comparison price, the way shelf labels write it: per litre, per 100 g (per kg for 5 kg and
 * more), per 100 sheets, per item.
 */
export function compareText(
  perBase: number | undefined,
  unit: BaseUnit | undefined,
  opts: { sheets?: boolean; total?: number; style?: CompareStyle } = {},
): string {
  if (perBase === undefined || !unit || !Number.isFinite(perBase)) return '';
  if (unit === 'g') return (opts.style?.kg ?? (!!opts.total && opts.total >= 5000)) ? `${money(perBase * 1000)} / kg` : `${money(perBase * 100)} / 100g`;
  if (unit === 'ml') return `${money(perBase * 1000)} / L`;
  if (opts.sheets) return `${money(perBase * 100)} per 100 sheets`;
  return (opts.style?.per100 ?? perBase < 0.1) ? `${money(perBase * 100)} per 100` : `${money(perBase)} each`;
}

/**
 * 0.9.6: one comparison unit for a whole list or sheet of one kind of product (the shops' packs of one item),
 * so "$0.45 / 100g" never sits above "$4.20 / kg". Grams: per kg when any row is 5 kg or more, else per 100 g.
 * Counted things: per 100 when more rows are under $0.10 each than not, else each. Only the writing changes,
 * never which row is cheapest.
 */
export function compareStyleOf(rows: { total?: number; unit?: BaseUnit; perBase?: number }[]): CompareStyle {
  let kg = false;
  let sawGrams = false;
  let small = 0;
  let big = 0;
  for (const r of rows) {
    if (!r.unit || r.perBase === undefined || !Number.isFinite(r.perBase)) continue;
    if (r.unit === 'g') {
      sawGrams = true;
      if (r.total !== undefined && r.total >= 5000) kg = true;
    } else if (r.unit === 'ea') {
      if (r.perBase < 0.1) small++;
      else big++;
    }
  }
  const style: CompareStyle = {};
  if (sawGrams) style.kg = kg;
  if (small + big > 1) style.per100 = small > big;
  return style;
}

/** compareStyleOf for products with a price each (an item's options). A line with no size or price has no say. */
export function compareStyleOfProducts(rows: { product: SizeSource & { sizing?: Sizing }; price?: number }[]): CompareStyle {
  return compareStyleOf(
    rows.map((r) => {
      const s = sizingOf(r.product).size;
      const sheets = !r.product.qty && inSheets(r.product.size);
      return s && !sheets && r.price !== undefined && s.qty > 0 ? { total: s.qty, unit: s.unit, perBase: r.price / s.qty } : {};
    }),
  );
}

/**
 * The size, for showing. "10 × 375 mL (3.75 L in total)" so a pack total never reads as one can,
 * "9 L (estimated)", or "size unknown".
 */
export function sizeLabel(p: SizeSource & { sizing?: Sizing }): string {
  const sz = sizingOf(p);
  const s = sz.size;
  if (!s) return 'size unknown';
  const tag = basisWord(s.basis);
  const note = tag ? ` (${tag})` : '';
  if (s.unit === 'ea') return `${tidySize(p.size, p.name) ?? `${n2(s.qty)}`}${note}`;
  if (s.count && s.count > 1) return `${s.count} × ${measureText(s.qty / s.count, s.unit)}, ${measureText(s.qty, s.unit)} in total${note}`;
  // The shop's own words for a single one: "375mL", "1.25L".
  return s.basis === 'shop' && p.size && !/pack|pk|each|ea\b/i.test(p.size) ? (tidySize(p.size, p.name) ?? measureText(s.qty, s.unit)) : `${measureText(s.qty, s.unit)}${note}`;
}

export interface PriceLine {
  /** "$0.98 each": one can, bottle or item. Missing for a single one (its price is the price). */
  each?: string;
  /** "$2.61 / L": what decides the cheapest. Missing when the size is unknown. */
  compare?: string;
  /** How sure: 'estimated' | 'confirmed' | 'from barcode'. */
  tag?: string;
  unknown: boolean;
  /** The size, or "size unknown". */
  size: string;
  /** A suggestion the person can confirm, with how it was got ("Probably 24 × 375 mL = 9 L. Soft drink cans are usually 375 mL."). */
  suggestion?: string;
  /** One line for lists: "$0.98 each · $2.61 / L (estimated)", or "$0.98 each · size unknown". */
  text: string;
}

/** Both prices for a product at `price` (what one pack costs): per item for understanding, the comparison price for deciding. */
export function priceLine(p: SizeSource & { sizing?: Sizing }, price: number | undefined, style?: CompareStyle): PriceLine {
  const sz = sizingOf(p);
  const s = sz.size;
  const sheets = !p.qty && inSheets(p.size);
  const count = s && s.unit !== 'ea' ? s.count : (sz.packCount ?? (sheets ? rollsIn(p.name) : undefined));
  const ok = price !== undefined && Number.isFinite(price);
  const each = ok && count && count > 1 ? `${money(price! / count)} each` : undefined;
  const per = ok && s && s.qty > 0 ? price! / s.qty : undefined;
  let compare = compareText(per, s?.unit, { sheets, total: s?.qty, style }) || undefined;
  // A counted thing sold singly: its price is the one price, so "each" would say it twice.
  const dup = compare !== undefined && each !== undefined && compare === each;
  const tag = basisWord(s?.basis);
  const g = sz.guess;
  const suggestion = !s && g ? `Probably ${g.count ?? 1} × ${measureText(g.qty / (g.count ?? 1), g.unit)} = ${measureText(g.qty, g.unit)}. ${g.why}` : undefined;
  if (dup) compare = undefined;
  const tail = compare ? `${compare}${tag ? ` (${tag})` : ''}` : s ? undefined : 'size unknown';
  return {
    each,
    compare,
    tag,
    unknown: !s,
    size: sizeLabel(p),
    suggestion,
    text: [each, tail].filter(Boolean).join(' · '),
  };
}

/**
 * What to put in the "Amount for unit pricing" box: what Restock found, or its guess, so the person only
 * has to check it. Undefined with nothing to offer.
 */
export function amountToConfirm(p: SizeSource & { sizing?: Sizing }): { qty: number; unit: BaseUnit; estimated: boolean; note: string } | undefined {
  const sz = sizingOf(p);
  if (sz.size && sz.size.basis !== 'confirmed')
    return sz.size.basis === 'shop'
      ? undefined
      : { qty: sz.size.qty, unit: sz.size.unit, estimated: true, note: sz.size.basis === 'barcode' ? 'Found from the same barcode at another shop.' : `Worked out from the same pack at ${sz.size.from || 'another shop'}.` };
  if (!sz.size && sz.guess) return { qty: sz.guess.qty, unit: sz.guess.unit, estimated: true, note: sz.guess.why };
  return undefined;
}

/**
 * A product line's words, the same on every screen: "24 × 375 mL, 9 L in total · $0.98 each · $2.61 / L".
 * With no size: "$0.98 each · size unknown".
 */
export function productLine(p: SizeSource & { sizing?: Sizing }, price: number | undefined, style?: CompareStyle): string {
  const l = priceLine(p, price, style);
  return [l.unknown ? undefined : l.size, l.text].filter(Boolean).join(' · ');
}

// ---------- Last updated ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "6:32 am", in the phone's own time. */
export function clockText(d: Date): string {
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/**
 * The "Last updated" on a Price history card: "Last updated today, 6:32 am", "Last updated yesterday,
 * 6:32 am", "Last updated Tue 10 Nov, 6:32 am". "Not checked yet" with no price at all. A price typed in
 * by hand says so.
 */
export function lastUpdatedText(date: string | undefined, source?: string, now = Date.now()): string {
  const t = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(t)) return 'Not checked yet';
  const d = new Date(t);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const when = sameDay(d, today)
    ? 'today'
    : sameDay(d, yesterday)
      ? 'yesterday'
      : `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
  return `Last updated ${when}, ${clockText(d)}${source === 'manual' ? ' · entered by hand' : ''}`;
}

/** The newest reading of a product (any source), for "Last updated". */
export function newestReading<T extends { date: string }>(readings: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const r of readings) if (!best || r.date > best.date) best = r;
  return best;
}

/**
 * Both prices for a shop's search result or special (no saved product): worked out from its words, its own
 * unit price, and `pool` (the other results, to match a barcode or a look-alike).
 */
export function storePriceLine(sp: SizeSource & { price?: number }, pool: (SizeSource & { price?: number })[] = [], style?: CompareStyle): PriceLine {
  return priceLine({ ...sp, sizing: sizeUp(sp, pool) }, sp.price, style);
}
