import type { BaseUnit } from '../types';

export interface ParsedSize {
  qty: number;
  unit: BaseUnit;
}

// 0.9.0: ".5kg" is half a kilo (it read as 5 kg). Mirrored in Deals.java.
const NUM = '(\\d+(?:\\.\\d+)?|\\.\\d+)';
const MASS_VOL = '(kg|g|ml|l)';

function toBase(amount: number, unit: string): ParsedSize {
  switch (unit) {
    case 'kg':
      return { qty: amount * 1000, unit: 'g' };
    case 'g':
      return { qty: amount, unit: 'g' };
    case 'l':
      return { qty: amount * 1000, unit: 'ml' };
    default:
      return { qty: amount, unit: 'ml' };
  }
}

type SizeKind = 'multi' | 'single' | 'count' | 'each';
interface SizeParts extends ParsedSize {
  kind: SizeKind;
  /** For a count: the word after the number ("pack", "rolls"). */
  word?: string;
  /** For "6 x 375ml": the 6. */
  count?: number;
}

function parseParts(input: string | undefined | null): SizeParts | undefined {
  if (!input) return undefined;
  const s = input
    .toLowerCase()
    // Thousands written with a comma: "1,120 sheets" is 1120, not 120 (0.7.6).
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/litres?|liters?/g, 'l')
    .replace(/millilitres?|milliliters?/g, 'ml')
    .replace(/kilograms?|kilos?/g, 'kg')
    .replace(/grams?/g, 'g')
    .replace(/×/g, 'x');

  // 6 x 375ml
  let m = s.match(new RegExp(`(\\d+)\\s*x\\s*${NUM}\\s*${MASS_VOL}\\b`));
  if (m) {
    const base = toBase(parseFloat(m[2]), m[3]);
    return { qty: base.qty * parseInt(m[1], 10), unit: base.unit, kind: 'multi', count: parseInt(m[1], 10) };
  }
  // 375ml x 6
  m = s.match(new RegExp(`${NUM}\\s*${MASS_VOL}\\s*x\\s*(\\d+)\\b`));
  if (m) {
    const base = toBase(parseFloat(m[1]), m[2]);
    return { qty: base.qty * parseInt(m[3], 10), unit: base.unit, kind: 'multi', count: parseInt(m[3], 10) };
  }
  // 500g, 2l, 1.5kg
  m = s.match(new RegExp(`${NUM}\\s*${MASS_VOL}\\b`));
  if (m) return { ...toBase(parseFloat(m[1]), m[2]), kind: 'single' };

  // 24 pack, 500 sheets, 12 rolls, 30 tablets, 10 cans
  m = s.match(/(\d+)\s*(packs?|pk|cans?|bottles?|sheets?|rolls?|ea|each|count|ct|tablets?|tabs|capsules?|pods?|bags?|pieces?|pce|wipes?)\b/);
  if (m) return { qty: parseInt(m[1], 10), unit: 'ea', kind: 'count', word: m[2] };

  if (/\b(each|ea)\b/.test(s)) return { qty: 1, unit: 'ea', kind: 'each' };
  return undefined;
}

/**
 * Turns a store size string into an amount in base units.
 * "1kg" → 1000 g, "6 x 375ml" → 2250 ml, "24 pack" → 24 ea, "500 sheets" → 500 ea.
 */
export function parseSize(input: string | undefined | null): ParsedSize | undefined {
  const p = parseParts(input);
  return p && { qty: p.qty, unit: p.unit };
}

export interface PackSize extends ParsedSize {
  /** How many are in the pack, when the total was worked out from a count and the size of each. */
  count?: number;
}

/** Counts that are packs of something, not sheets, rolls or tablets. */
const PACK_WORD = /^(packs?|pk|cans?|bottles?)$/;

/** "24 Pack", "30 cans" or "6pk" anywhere in a name: how many in the pack (more than one). */
function packCountIn(name: string | undefined | null): number | undefined {
  const m = name?.toLowerCase().match(/(\d+)\s*(packs?|pk|cans?|bottles?)\b/);
  const n = m ? parseInt(m[1], 10) : 0;
  return n > 1 ? n : undefined;
}

/**
 * Is a measure in the name the size of each one in the pack, rather than the whole pack?
 * Drinks are almost always labelled per can or bottle ("30 Pack" … "375ml"), so millilitres
 * count as each up to 600 ml, or when the whole pack would be under 100 ml a piece. Weights
 * are usually the whole pack ("18 Pack" … "342g"), so only when that would be under 15 g a piece.
 */
function measureIsEach(measure: ParsedSize, count: number): boolean {
  if (measure.unit === 'ml') return measure.qty <= 600 || measure.qty / count < 100;
  if (measure.unit === 'g') return measure.qty / count < 15;
  return false;
}

/**
 * The size of a product from both its size and its name, so packs compare by the litre or
 * kilo at every store. Coles sells cans as size "30 Pack" named "… Cans Multipack 375ml", and
 * Woolworths as "375mL x 30 pack": both are 11.25 litres. Mirrored in Deals.java.
 */
export function packSize(size: string | undefined | null, name: string | undefined | null): PackSize | undefined {
  const s = parseParts(size);
  const n = parseParts(name);
  // Size "30 Pack", name "… 375ml" (or "… 30 x 375ml").
  if (s?.kind === 'count' && s.qty > 1 && PACK_WORD.test(s.word ?? '') && n && n.unit !== 'ea') {
    if (n.kind === 'multi') return { qty: n.qty, unit: n.unit, count: n.count };
    if (n.kind === 'single') {
      // Each can is 375 ml, or the whole bag of 18 is 342 g. Either way it compares by the gram or litre.
      return measureIsEach(n, s.qty) ? { qty: n.qty * s.qty, unit: n.unit, count: s.qty } : { qty: n.qty, unit: n.unit, count: s.qty };
    }
  }
  // Size "375ml", name "… 10 x 375ml": the name has the whole pack. 0.9.6: also when the size is already the total
  // (Coles: size "3.75L", name "… 10x375ml"), so it still knows it is 10 of them.
  if (s?.kind === 'single' && n?.kind === 'multi' && n.unit === s.unit && n.qty >= s.qty * 0.99) return { qty: n.qty, unit: n.unit, count: n.count };
  // Size "375ml", name "… 24 Pack" (or "… Cans 24 Pack 375ml").
  const named = packCountIn(name);
  if (s?.kind === 'single' && s.unit === 'ml' && s.qty <= 600 && named && n?.kind !== 'multi') {
    return { qty: s.qty * named, unit: 'ml', count: named };
  }
  // Size "1 each", name "… Tablets 70 Pack": the name has how many (Aldi does this). Mirrored in Deals.java.
  if (s && s.unit === 'ea' && s.qty <= 1 && n?.kind === 'count' && n.qty > 1) return { qty: n.qty, unit: 'ea' };
  const p = s ?? n;
  return p && { qty: p.qty, unit: p.unit, count: p.kind === 'multi' && p.count && p.count > 1 ? p.count : undefined };
}

/** A size given in sheets ("4,320 sheets"): toilet paper, tissues, paper towel. */
export const inSheets = (size: string | undefined | null) => /\bsheets?\b/i.test(size ?? '');

/** "24 Pack", "12 rolls" or "6pk" in a name: how many rolls (more than one). */
export function rollsIn(name: string | undefined | null): number | undefined {
  const m = name?.toLowerCase().match(/(\d+)\s*(packs?|pk|rolls?)\b/);
  const n = m ? parseInt(m[1], 10) : 0;
  return n > 1 ? n : undefined;
}

/**
 * A shop's size label, tidied for showing: "1 Each" → "1 each", "3 Pack" → "3 pack", and "1 each"
 * on something named "… 70 Pack" → "70 pack".
 */
export function tidySize(size: string | undefined | null, name?: string | null): string | undefined {
  const t = size?.trim();
  if (!t) return undefined;
  const s = parseParts(t);
  const n = parseParts(name);
  if (s && s.unit === 'ea' && s.qty <= 1 && n?.kind === 'count' && n.qty > 1)
    return `${n.qty} ${/pack|pk/.test(n.word ?? '') ? 'pack' : (n.word ?? 'pack')}`;
  return t.replace(/\b(Each|EA|Ea|Pack|PACK|Pk|PK)\b/g, (w) => (/^e/i.test(w) ? 'each' : 'pack'));
}

/** A shop's own unit price label, tidied: "$31.99 per 1 each" → "$31.99 each", "$0.87 / 1EA" → "$0.87 each". */
export function tidyUnitText(t: string | undefined | null): string | undefined {
  if (!t) return undefined;
  return t
    .replace(/\s*(?:per|\/)\s*1\s*(?:each|ea)\b/i, ' each')
    .replace(/\s*(?:per|\/)\s*(?:each|ea)\b/i, ' each')
    .replace(/\s*(?:per|\/)\s*(\d+)\s*(?:each|ea)\b/i, ' per $1')
    .trim();
}

/** Price per base unit (per g, per ml or per each). */
export function unitPrice(price: number, qty?: number, unit?: BaseUnit): number | undefined {
  if (!qty || qty <= 0 || !unit) return undefined;
  return price / qty;
}

/** Human label for a unit price, scaled the way Australian shelf labels do. */
export function formatUnitPrice(perBase: number | undefined, unit?: BaseUnit, style?: CompareStyle): string {
  if (perBase === undefined || !unit || !Number.isFinite(perBase)) return '';
  if (unit === 'g') return style?.kg ? `${money(perBase * 1000)} / kg` : `${money(perBase * 100)} / 100g`;
  // Always per litre (0.9.0), so a 1 L and a 2 L milk read the same way.
  if (unit === 'ml') return `${money(perBase * 1000)} / L`;
  return (style?.per100 ?? perBase < 0.1) ? `${money(perBase * 100)} per 100` : `${money(perBase)} each`;
}

/**
 * 0.9.6: the comparison unit to use on every line of one list or sheet, so the lines can be compared by eye.
 * kg: grams are shown per kg, not per 100 g. per100: counted things are shown per 100, not each.
 * Left out: each line picks its own (as before). Only how it is written: decisions use the same numbers.
 */
export interface CompareStyle {
  kg?: boolean;
  per100?: boolean;
}

/** Dollars, with commas in big amounts (0.9.0): $2,387.81. No number (or an endless one) is a dash, never "$Infinity". */
export function money(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  const s = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < -0.004 ? '-' : ''}$${s}`;
}

/**
 * A price typed by hand (0.9.0): "$4.50", "4.50", "$1,234.50" or " 4.5 ". The dollar sign, spaces and
 * thousands commas are fine; a comma before the cents ("4,50") is read as the decimal point. NaN when
 * there's no number in it.
 */
export function parseMoney(text: string | undefined | null): number {
  let s = (text ?? '').replace(/[$\s]/g, '');
  s = /^\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  return parseFloat(s);
}
