import { kindOf, PRODUCT_NOUNS } from '../lib/naming';
import { packSize, parseSize, type ParsedSize } from '../lib/units';
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
  // Drinks (0.8.5): "Archie Rose Gin" is gin, not rosé.
  ...DRINKS_LIST(),
];

function DRINKS_LIST(): string[] {
  return ['gin', 'vodka', 'whisky', 'whiskey', 'rum', 'bourbon', 'tequila', 'liqueur', 'brandy', 'wine', 'beer', 'lager', 'cider', 'seltzer'];
}
const DRINKS = new Set(DRINKS_LIST());

export function stem(w: string): string {
  // Dishwasher tablets and dishwashing tablets are the same thing (0.8.5).
  if (w === 'dishwasher' || w === 'dishwashing') return 'dishwash';
  if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokens(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    // "Rosé" is "rose", not "ros" (0.8.5).
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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

const KIDS =
  /\b(child(ren)?'?s?|kids?|infants?|baby|babies|toddlers?|junior|paediatric|pediatric|follow[- ]on|formula|\d+\s*(months?|years?)?\s*(-|to|–)\s*\d+\s*(months?|years?)|\d+\s*years?\s*\+|\d+\+?\s*years)\b/i;

/** "… Butter Flavour", "… with Butter": the word is a flavour or an ingredient, not the thing. */
function asFlavour(q: string[], name: string): boolean {
  const words = name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&|\+/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);
  return q.some((t) =>
    words.some(
      (w, i) =>
        w === t &&
        (/^(flavou?r|flavou?red|scented|taste|infused|style)$/.test(words[i + 1] ?? '') ||
          // "Flavoured Cream Wafers Chocolate": named after the flavour word (0.8.5).
          words.slice(0, i).some((x) => /^flavou?red$/.test(x)) ||
          /^(with|and|in)$/.test(words[i - 1] ?? '') ||
          (words[i - 1] === 'flavour' && words[i - 2] === 'with')),
    ),
  );
}

/**
 * Where the shop itself put it. The shops sort their results by what sells, so their first few
 * are usually the everyday one (Nutella the spread, not Nutella croissants). Worth a little,
 * never more than a clear difference in what it is (0.8.5). Without a position, nothing.
 */
export const placeBonus = (index?: number) => (index === undefined ? 0 : 0.15 * Math.exp(-index / 8) - 0.05);

/** Words that just mean the plain, everyday one: full cream milk is milk, plain flour is flour. */
const PLAIN = /\b(full cream|plain|regular|original|classic|table|everyday|traditional|pure|standard)\b/g;

/** Not the thing: "No Sugar Cola", "Sugar Free Gum", "Zero Sugar". */
function negated(q: string[], name: string): boolean {
  const words = tokens(name);
  return q.some((t) =>
    words.some((w, i) => close(t, w) && (/^(no|zero|less|low|reduced|without|non)$/.test(words[i - 1] ?? '') || /^(free)$/.test(words[i + 1] ?? ''))),
  );
}

/** Christmas, Easter and gift lines: not what you buy every week, unless you asked. */
const SEASONAL = /\b(christmas|xmas|easter|advent|santa|baubles?|gingerbread|halloween|hollow egg|bon ?bons?|gift ?(box|set|pack)|giftset|stocking|tin \d)/i;

/**
 * Different products whose name ends in the word you typed: an air conditioner isn't conditioner,
 * hand cream isn't cream. Unless you typed the first word too.
 */
const DIFFERENT: [string, string][] = [
  ['air', 'conditioner'],
  ['hand', 'cream'],
  ['face', 'cream'],
  ['body', 'cream'],
  ['eye', 'cream'],
  ['nappy', 'cream'],
  ['ceramide', 'cream'],
  ['barrier', 'cream'],
  ['coffee', 'mate'],
  ['granny', 'smith'],
  ['evaporated', 'milk'],
  ['condensed', 'milk'],
  ['coconut', 'milk'],
  ['garlic', 'salt'],
  ['onion', 'salt'],
  ['celery', 'salt'],
  ['chicken', 'salt'],
  ['milk', 'frother'],
  ['hand', 'wash'],
  ['face', 'wash'],
  ['body', 'wash'],
  ['microwave', 'rice'],
];
/** One word of such a pair typed, the other not, and the pair in the name: a different product. */
function different(q: string[], name: string): boolean {
  const words = tokens(name);
  return DIFFERENT.some(([first, last]) => {
    const f = stem(first);
    const l = stem(last);
    const hasF = q.some((t) => close(t, f));
    const hasL = q.some((t) => close(t, l));
    // Next to each other, or one word between ("Microwave Jasmine Rice").
    return hasF !== hasL && words.some((w, i) => w === l && (words[i - 1] === f || words[i - 2] === f));
  });
}

/** A pack count or size typed into the search: "coca cola 24 pack", "milk 2l", "beef mince 500g". */
export function typedSize(text: string): { size?: ParsedSize; count?: number } {
  const t = text.toLowerCase();
  const count = t.match(/\b(\d+)\s*(?:pack|pk|cans|bottles|x)\b|\bx\s*(\d+)\b/);
  const size = t.match(/\b(\d+(?:\.\d+)?\s*(?:g|kg|ml|l|litres?|liters?))\b/);
  return { size: size ? parseSize(size[1]) : undefined, count: count ? parseInt(count[1] ?? count[2], 10) : undefined };
}

export function score(q: RankQuery, p: StoreProduct, index?: number): number {
  if (isExactBarcode(q, p)) return 10 - (index ?? 0) * 0.001;
  const qTokens = [...new Set(tokens(q.text))];
  const name = [p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? p.brand : '', p.name].join(' ');
  const pTokens = [...new Set(tokens(name))];
  if (!qTokens.length) return 0.5 - (index ?? 0) * 0.004;

  const matched = qTokens.filter((t) => pTokens.some((u) => close(t, u))).length;
  let s = matched / qTokens.length;

  // You typed the brand first ("coca cola 24 pack", "cadbury dairy milk", "nutella"): every one of
  // its products is the brand's, so what kind each is doesn't count against it (0.8.5). Just the
  // brand: the shop's own order (best sellers first) decides.
  const brandWords = tokens(p.brand);
  const brandLed = brandWords.length > 0 && close(qTokens[0], brandWords[0]);
  const justBrand = brandLed && qTokens.every((t) => brandWords.some((b) => close(t, b)));

  const extras = pTokens.filter((u) => !qTokens.some((t) => close(t, u))).length;
  // A smaller cap (0.8.5): a long, descriptive name ("Milo Malt Drinking Chocolate Powder Hot or
  // Cold") isn't a worse match than a short one.
  if (!justBrand) s -= 0.03 * Math.min(extras, 4);

  if (q.brand && tokens(q.brand).every((b) => pTokens.some((u) => close(b, u)))) s += 0.15;

  const typed = q.size ? {} : typedSize(q.text);
  const qs = parseSize(q.size) ?? typed.size;
  const ps = packSize(p.size, p.name);
  if (typed.count && ps) {
    const have = ps.count ?? (ps.unit === 'ea' ? ps.qty : undefined);
    if (have === typed.count) s += 0.2;
    else if (have) s -= 0.1;
  }
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
    const modifier = !brandLed && asModifier(qTokens, name);
    // "Macaroni & Cheese": an ingredient of something else, so its kind doesn't count either.
    // Unless you typed it that way too ("canadian club and dry").
    const flavour = asFlavour(qTokens, name) && !asFlavour(qTokens, q.text);
    const kind = modifier || flavour ? undefined : kindOf(p.name);
    // The plain version counts as the thing itself, unless you asked for a kind of it.
    const plainKind = kind?.replace(PLAIN, (w) => (qTokens.some((t) => tokens(w).includes(t)) ? w : ' '));
    const kt = tokens(plainKind);
    if (kt.length) {
      const inKind = qTokens.filter((t) => kt.some((u) => close(t, u))).length;
      if (inKind === qTokens.length && kt.length === qTokens.length) s += 0.3;
      // "Tasty cheese" for cheese, "peanut butter" for butter: a kind of it, so neither up nor down.
      else if (inKind === 0 && matched > 0 && !brandLed) s -= 0.3;
    }
    if (flavour) s -= 0.3;
    if (modifier) s -= 0.35;
    if (different(qTokens, name)) s -= 0.4;
    // Made for children ("6 Years - 12 Years", "Kids", "Infant", "Junior"), when you didn't ask (0.7.6).
    if (KIDS.test(name) && !KIDS.test(q.text)) s -= 0.4;
  }

  const qt = typesIn(q.text);
  const pt = typesIn(name);
  if (qt.size && pt.size && ![...pt].some((t) => qt.has(t))) s -= 0.35;
  else if (!qt.size && pt.size && !justBrand) s -= 0.05;
  // A different kind of product on top of the right word: tomato *paste* when you want tomatoes.
  if (qt.size && !brandLed) s -= 0.15 * [...pt].filter((t) => !qt.has(t)).length;
  // A kind of drink you didn't ask for, named after the word you did: Archie Rose *Gin* for "rose".
  // Not when the name starts with it: that's the brand you typed ("Smirnoff Red Label Vodka").
  const startsWith = qTokens.some((t) => close(t, pTokens[0] ?? ''));
  if (!startsWith && ![...qt].some((t) => DRINKS.has(t)) && [...pt].some((t) => DRINKS.has(t) && !qTokens.some((u) => close(u, t))))
    s -= 0.25;
  // The kind you typed isn't in it at all: Granny Smith apples for "smiths chips".
  if (qt.size && ![...qt].some((t) => pTokens.some((u) => close(t.split(' ').pop()!, u)))) s -= 0.2;

  if (!q.barcode && negated(qTokens, name) && !negated(qTokens, q.text)) s -= 0.6;
  if (SEASONAL.test(name) && !SEASONAL.test(q.text)) s -= 0.2;

  return s + placeBonus(index);
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
