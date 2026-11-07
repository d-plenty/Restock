import { packSize, parseSize } from '../lib/units';
import type { StoreProduct } from './types';

// Orders a store's search results by how well they match what you scanned or typed,
// so the jar of Vegemite comes before Vegemite Shapes, and ice cream sinks below topping.

const STOP = new Set(['the', 'and', 'with', 'of', 'a', 'in', 'for', 'pack', 'pk', 'x', 'each', 'ea', 'per', 'new', 'value']);

/** Words that say what kind of thing a product is. A clash between query and result is a strong "no". */
const TYPES = [
  'ice cream',
  'topping',
  'sauce',
  'spread',
  'shapes',
  'scroll',
  'biscuit',
  'cracker',
  'chips',
  'bar',
  'drink',
  'juice',
  'milk',
  'yoghurt',
  'cheese',
  'bread',
  'wafer',
  'cake',
  'cereal',
  'soup',
  'tomato',
  'paste',
  'pasta',
  'noodle',
  'chocolate block',
  'block',
  'powder',
  'syrup',
  'tablet',
  'capsule',
  'pod',
  'spray',
  'wipe',
  'roll',
  'tissue',
];

export function stem(w: string): string {
  if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokens(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w) && !/^\d+(\.\d+)?(g|kg|ml|l|pk|pack|x)?$/.test(w))
    .map(stem);
}

function typesIn(text: string): Set<string> {
  const t = ` ${tokens(text).join(' ')} `;
  const out = new Set<string>();
  for (const type of TYPES) {
    const st = type.split(' ').map(stem).join(' ');
    if (t.includes(` ${st} `)) out.add(st);
  }
  // "ice cream" also contains "cream"-free words; don't double count "chocolate block" as "block".
  if (out.has('chocolate block')) out.delete('block');
  return out;
}

export interface RankQuery {
  text: string;
  brand?: string;
  size?: string;
  barcode?: string;
}

const close = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

export function score(q: RankQuery, p: StoreProduct, index = 0): number {
  if (isExactBarcode(q, p)) return 10 - index * 0.001;
  const qTokens = [...new Set(tokens(q.text))];
  const name = [p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? p.brand : '', p.name].join(' ');
  const pTokens = [...new Set(tokens(name))];
  if (!qTokens.length) return 0.5 - index * 0.004;

  const matched = qTokens.filter((t) => pTokens.some((u) => close(t, u))).length;
  let s = matched / qTokens.length;

  const extras = pTokens.filter((u) => !qTokens.some((t) => close(t, u))).length;
  s -= 0.03 * Math.min(extras, 6);

  if (q.brand && tokens(q.brand).every((b) => pTokens.some((u) => close(b, u)))) s += 0.15;

  const qs = parseSize(q.size);
  const ps = packSize(p.size, p.name);
  if (qs && ps) {
    if (qs.unit !== ps.unit) s -= 0.05;
    else {
      const ratio = ps.qty / qs.qty;
      if (ratio > 0.9 && ratio < 1.1) s += 0.2;
      else if (ratio > 2 || ratio < 0.5) s -= 0.1;
    }
  }

  const qt = typesIn(q.text);
  const pt = typesIn(name);
  if (qt.size && pt.size && ![...pt].some((t) => qt.has(t))) s -= 0.35;
  else if (!qt.size && pt.size) s -= 0.05;
  // A different kind of product on top of the right word: tomato *paste* when you want tomatoes.
  if (qt.size) s -= 0.15 * [...pt].filter((t) => !qt.has(t)).length;

  return s - index * 0.004;
}

/** All results, best match first. */
export function rankAll(q: RankQuery, items: StoreProduct[]): StoreProduct[] {
  return items
    .map((p, i) => ({ p, s: score(q, p, i) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p);
}

/** Best matches first, split into the ones worth showing and the rest. */
export function rankResults(q: RankQuery, items: StoreProduct[], max = 8): { top: StoreProduct[]; rest: StoreProduct[] } {
  const scored = items.map((p, i) => ({ p, s: score(q, p, i) })).sort((a, b) => b.s - a.s);
  if (!scored.length) return { top: [], rest: [] };
  const cut = Math.max(0.3, scored[0].s * 0.6);
  const top: StoreProduct[] = [];
  const rest: StoreProduct[] = [];
  for (const { p, s } of scored) (top.length < max && (s >= cut || top.length < 2) ? top : rest).push(p);
  return { top, rest };
}

export const isExactBarcode = (q: RankQuery, p: StoreProduct) =>
  !!q.barcode && !!p.barcode && p.barcode.replace(/^0+/, '') === q.barcode.replace(/^0+/, '');
