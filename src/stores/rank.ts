import { kindOf, PRODUCT_NOUNS } from '../lib/naming';
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
    .map((w) => SAME[w] ?? w)
    .map(stem);
}

/** Spellings that mean the same thing (0.7.5). */
const SAME: Record<string, string> = {
  yogurt: 'yoghurt',
  yogurts: 'yoghurt',
  flavor: 'flavour',
  flavored: 'flavoured',
  color: 'colour',
  colors: 'colour',
};

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

/**
 * Same word, or one shortened: "choc" and "chocolate", "tomato" and "tomatoes". Not a word made
 * from it: "buttery", "buttered" and "butterscotch" aren't butter (0.7.5).
 */
const close = (a: string, b: string) => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4 || !long.startsWith(short)) return false;
  const tail = long.slice(short.length);
  if (/^(y|ed|ie|ier|iest|ing|scotch|nut|milk|fly|cup)$/.test(tail)) return false;
  return short.length <= 4 || tail.length <= 2;
};

/**
 * The word describes another product right after it: "Bread Crumbs", "Cheese Twisties", "Apple Pie",
 * "Rice Crackers", "Butter Chicken". Unless you typed that too ("rice crackers").
 */
const NOUNS = new Set([...PRODUCT_NOUNS].map((w) => stem(w)));
/** How it's packed is never another product: "Apples 1kg Bag", "Milk Bottle". */
const PACKAGING = new Set([
  // The shape it comes in is still the same thing: "Cheese Block", "Chicken Breast", "Butter Portions".
  'block',
  'slice',
  'wedge',
  'stick',
  'portion',
  'fillet',
  'piece',
  'strip',
  'mince',
  'breast',
  'thigh',
  'wing',
  'drumstick',
  'loaf',
  'spread',
  'bag',
  'box',
  'tray',
  'punnet',
  'bottle',
  'can',
  'jar',
  'tub',
  'tin',
  'carton',
  'bunch',
  'kg',
  'loose',
  'prepacked',
  'value',
  'multipack',
  'family',
  'bulk',
]);

function asModifier(q: string[], name: string): boolean {
  const words = tokens(name);
  const last = q[q.length - 1];
  return words.some((w, i) => {
    if (!close(w, last)) return false;
    // The next word or the one after ("Chicken Crimpy Shapes"), but not how it's packed.
    return [words[i + 1], words[i + 2]].some((next) => !!next && !PACKAGING.has(next) && !q.some((t) => close(t, next)) && NOUNS.has(next));
  });
}

/** "… Butter Flavour", "… with Butter": the word is a flavour or an ingredient, not the thing. */
function asFlavour(q: string[], name: string): boolean {
  const words = name
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);
  return q.some((t) =>
    words.some(
      (w, i) =>
        w === t &&
        (/^(flavou?r|flavou?red|scented|taste|infused|style)$/.test(words[i + 1] ?? '') ||
          /^(with|and|in)$/.test(words[i - 1] ?? '') ||
          (words[i - 1] === 'flavour' && words[i - 2] === 'with')),
    ),
  );
}

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

  // What kind of thing it is (0.7.5): for "butter", butter blocks first; peanut butter, butter
  // chicken sauce and butter-flavoured popcorn after. Only for plain typed searches.
  if (!q.barcode && qTokens.length <= 3) {
    // "Cheese Twisties" names cheese, but it's Twisties: then the kind found doesn't count.
    const modifier = asModifier(qTokens, name);
    const kind = modifier ? undefined : kindOf(p.name);
    const kt = tokens(kind);
    if (kt.length) {
      const inKind = qTokens.filter((t) => kt.some((u) => close(t, u))).length;
      if (inKind === qTokens.length && kt.length === qTokens.length) s += 0.3;
      // "Tasty cheese" for cheese, "peanut butter" for butter: a kind of it, so neither up nor down.
      else if (inKind === 0 && matched > 0) s -= 0.3;
    }
    if (asFlavour(qTokens, name)) s -= 0.3;
    if (modifier) s -= 0.35;
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
