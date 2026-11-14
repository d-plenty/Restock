// 0.10.9: flavours, scents and colours. Tick several of the same thing at one shop (Milk & Honey,
// Ocean Breeze and Guava & Peach body wash at Coles) and they're one item: any of them will do,
// Restock watches them all, and a special on any of them counts. These say which are on special:
// "on special in all 3 scents", or "Ocean Breeze and Guava & Peach on special, not Milk & Honey".
// The same in Deals.java (flavourNote), for the alerts the background price check sends.
import type { Recommendation } from './verdict';

const SCENTS =
  /\b(body ?wash|shower|shampoo|conditioner|soap|hand ?wash|deodorant|antiperspirant|detergent|laundry|washing|dishwash|cleaner|spray|candle|softener|freshener|wipe|lotion|moisturiser)s?\b/i;
const COLOURS = /\b(paper|towel|tissue|serviette|napkin|pen|marker|highlighter|paint|nail|dye|colour|color|crayon|balloon|ribbon)s?\b/i;

/** "flavours", "scents" or "colours", from what the things are. */
export function flavourWord(names: string[]): 'flavours' | 'scents' | 'colours' {
  const all = names.join(' ');
  return SCENTS.test(all) ? 'scents' : COLOURS.test(all) ? 'colours' : 'flavours';
}

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/**
 * What tells them apart: their names without the words they all share ("Coles Simply Milk & Honey
 * Body Wash 1L" → "Simply Milk & Honey", beside "Revitalising Ocean Breeze" and "Guava & Peach").
 * Their whole names when nothing's left.
 */
export function flavourLabels(names: string[]): string[] {
  if (names.length < 2) return names;
  const ws = names.map(words);
  const shared = ws
    .map((w) => new Set(w.map((x) => x.toLowerCase())))
    .reduce((acc, set) => new Set([...acc].filter((x) => set.has(x))));
  return ws.map((w, i) => {
    const mid = w.filter((x) => !shared.has(x.toLowerCase())).join(' ');
    return mid || names[i];
  });
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * The note for several of the same thing at one shop, or undefined (one, or none on special).
 * `special` is whether each is on special now, in the same order as `names`.
 */
export function flavourNote(names: string[], special: boolean[]): string | undefined {
  const n = names.length;
  if (n < 2) return undefined;
  const k = special.filter(Boolean).length;
  if (!k) return undefined;
  const word = flavourWord(names);
  if (k === n) return `on special in all ${n} ${word}`;
  const labels = flavourLabels(names);
  const on = labels.filter((_, i) => special[i]);
  const off = labels.filter((_, i) => !special[i]);
  if (n > 4 || [...on, ...off].some((l) => l.length > 28)) return `on special in ${k} of your ${n} ${word}`;
  return `${list(on)} on special, not ${list(off)}`;
}

/** The note for an item's deal: its picks at the deal's shop, which of them are on special. */
export function flavourNoteFor(rec: Recommendation): string | undefined {
  const chain = rec.best?.product.chain;
  if (!chain) return undefined;
  const here = rec.options.filter((o) => o.role === 'main' && o.product.chain === chain && o.stats.current);
  if (here.length < 2) return undefined;
  return flavourNote(
    here.map((o) => o.product.name),
    here.map((o) => !!o.stats.current?.isSpecial),
  );
}

/** How many of your picks there are at the deal's shop (2 or more is a set of flavours). */
export function flavourCount(rec: Recommendation): number {
  const chain = rec.best?.product.chain;
  return chain ? rec.options.filter((o) => o.role === 'main' && o.product.chain === chain).length : 0;
}

/** Each shop where you've picked several of the same thing: how many, and what they differ in. */
export function flavourSets(rec: Pick<Recommendation, 'options'>): { chain: string; n: number; word: ReturnType<typeof flavourWord> }[] {
  const by = new Map<string, string[]>();
  for (const o of rec.options) if (o.role === 'main') by.set(o.product.chain, [...(by.get(o.product.chain) ?? []), o.product.name]);
  return [...by]
    .filter(([, names]) => names.length > 1)
    .map(([chain, names]) => ({ chain, n: names.length, word: flavourWord(names) }));
}

/** For the add bar: "3 scents at Coles: one item, any of them will do", or undefined. */
export function flavourBarNote(ticked: Iterable<{ chain: string; name: string }>, chainName: (c: string) => string): string | undefined {
  const by = new Map<string, string[]>();
  for (const t of ticked) by.set(t.chain, [...(by.get(t.chain) ?? []), t.name]);
  const sets = [...by].filter(([, n]) => n.length > 1);
  if (!sets.length) return undefined;
  return `${sets.map(([c, n]) => `${n.length} ${flavourWord(n)} at ${chainName(c)}`).join(', ')}: one item, any of them will do`;
}

// ---------- 0.10.11: "Tick the other 4 flavours" ----------

interface Pack {
  name: string;
  brand?: string;
  size?: string;
}
const SIZE = /\b\d+(?:[.,]\d+)?\s?(?:kg|g|ml|l|pk|pack|ea|each|sheets?|x\s?\d+(?:[.,]\d+)?\s?(?:g|ml|l|kg)?)\b/gi;
const tidy = (t?: string) => (t ?? '').toLowerCase().replace(/\s+/g, '');
const KIND_WORDS = ['wet', 'dry', 'puppy', 'adult', 'senior', 'kitten', 'zero', 'diet', 'decaf', 'frozen', 'lite', 'light', 'skim', 'refill', 'mini', 'large', 'small', 'kids'];
/** A name's words without its size and its brand: what's left is the kind of thing and its flavour. */
function core(p: Pack): string[] {
  const brand = new Set(words((p.brand ?? '').toLowerCase()));
  return words(p.name.toLowerCase().replace(SIZE, ' ').replace(/[^a-z0-9&' ]+/g, ' ')).filter((w) => !brand.has(w));
}
/** The size as written: the size given, else the one in the name. */
const sizeOf = (p: Pack) => tidy(p.size) || tidy((p.name.match(SIZE) ?? []).join(''));

/**
 * The same thing in another flavour (scent, colour): the same brand and the same size, with a name
 * that's mostly the same words. "Pedigree Wet Dog Food Beef 700g" and "Pedigree Wet Dog Food
 * Chicken & Rice 700g" are; a 1.2 kg can, another brand, or dry food aren't.
 */
export function sameButFlavour(a: Pack, b: Pack): boolean {
  if (tidy(a.brand) !== tidy(b.brand) && tidy(a.brand) && tidy(b.brand)) return false;
  const sa = sizeOf(a);
  const sb = sizeOf(b);
  if (!sa || sa !== sb) return false;
  const wa = core(a);
  const wb = new Set(core(b));
  if (!wa.length || !wb.size) return false;
  // A word that makes it a different product, not a flavour, has to be on both or neither.
  if (KIND_WORDS.some((k) => wa.includes(k) !== wb.has(k))) return false;
  const both = wa.filter((w) => wb.has(w)).length;
  if (both === wa.length && both === wb.size) return false; // the very same name
  // Most of the shorter name's words are in the other, and at least two (or a brand in common).
  const need = tidy(a.brand) && tidy(a.brand) === tidy(b.brand) ? 1 : 2;
  return both >= need && both / Math.min(wa.length, wb.size) >= 0.6;
}

/** From a shop's results: the other flavours of what's ticked there, that aren't ticked yet. */
export function otherFlavours<T extends Pack>(ticked: T[], results: T[], same: (a: T, b: T) => boolean = (a, b) => a === b): T[] {
  if (!ticked.length) return [];
  return results.filter((r) => !ticked.some((t) => same(t, r)) && ticked.some((t) => sameButFlavour(t, r)));
}
