// 0.9.3: matching the words of a shopping list line ("milk", "2 eggs") to a pantry item, for
// Home Assistant's list (voice adds) and the list's "Pick my milk". No database or network here,
// so it's all tested on its own (haMatch.test.ts).

/** A line's words read for matching: how many, the name without the number, and the key it matches on. */
export interface ParsedLine {
  qty: number;
  /** As typed or said, tidied ("milk" from "2 x milk"). */
  name: string;
  /** Lower case, no punctuation, each word in one form for singular and plural ("egg" for "Eggs"). */
  key: string;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/** Words at the start a voice add can have that aren't the thing ("some milk", "a loaf of bread" stays as it is). */
const LEADING = /^(?:a|an|some|more|the)\s+/i;

/** One form for a word's singular and plural, so "eggs" and "egg", "berries" and "berry" match. Not a real singular. */
export function wordKey(w: string): string {
  let s = w;
  if (s.length > 3 && !/(ss|us|is)$/.test(s)) {
    if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'i';
    else if (s.endsWith('oes') && s.length > 4) s = s.slice(0, -2);
    else if (/(ch|sh|x|z|ss)es$/.test(s)) s = s.slice(0, -2);
    else if (s.endsWith('s')) s = s.slice(0, -1);
  }
  if (s.length > 2 && s.endsWith('ie')) s = s.slice(0, -1);
  else if (s.length > 2 && s.endsWith('y')) s = s.slice(0, -1) + 'i';
  return s;
}

/** The key a name matches on: case, accents, punctuation and extra spaces don't count, nor do plurals. */
export function matchKey(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    // Letters and numbers of any language ("Молоко", "牛奶"), not just a to z.
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .replace(LEADING, '')
    .split(' ')
    .filter(Boolean)
    .map(wordKey)
    .join(' ');
}

/** "2 milk", "2 x milk", "2× milk", "milk x2", "two milks", "some milk": how many, and what. */
export function parseLine(text: string): ParsedLine {
  let t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;:]+$/, '')
    .trim();
  let qty = 1;
  // "2 x milk", "2x milk", "2 milk"; "milk x2", "milk x 2". Not "2xl" or "box 2".
  const lead = t.match(/^(\d{1,2})\s*[x×*]\s+(\S.*)$/i) ?? t.match(/^(\d{1,2})\s+(\S.*)$/);
  const tail = t.match(/^(\S.*?)\s+[x×*]\s*(\d{1,2})$/i);
  const word = t.match(/^([a-z]+)\s+(\S.*)$/i);
  if (lead && Number(lead[1]) > 0) {
    qty = Number(lead[1]);
    t = lead[2];
  } else if (tail && Number(tail[2]) > 0) {
    qty = Number(tail[2]);
    t = tail[1];
  } else if (word && Object.hasOwn(NUMBER_WORDS, word[1].toLowerCase())) {
    // Own keys only: "constructor milk" isn't a number word (0.9.4).
    qty = NUMBER_WORDS[word[1].toLowerCase()];
    t = word[2];
  }
  t = t.replace(LEADING, '').trim() || t;
  return { qty, name: t, key: matchKey(t) };
}

/** What Home Assistant's list shows for a line: "Milk", or "2 × Milk". */
export function lineSummary(name: string, qty: number | undefined): string {
  const n = Math.max(1, Math.floor(qty ?? 1) || 1);
  const t = name.replace(/\s+/g, ' ').trim();
  return n > 1 ? `${n} × ${t}` : t;
}

export interface NamedItem {
  id: string;
  name: string;
}

/**
 * The pantry items a line's words could be. A saved alias wins ("Always use this for milk");
 * then items whose name matches exactly (case, spaces and plurals aside). The whole text is tried
 * before the text without its number, so "2 minute noodles" still finds "2 Minute Noodles".
 */
export function candidates(text: string, items: NamedItem[], aliases: Record<string, string> = {}): NamedItem[] {
  const p = parseLine(text);
  const keys = [...new Set([matchKey(text), p.key].filter(Boolean))];
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const k of keys) {
    const a = Object.prototype.hasOwnProperty.call(aliases, k) ? byId.get(aliases[k]) : undefined;
    if (a) return [a];
  }
  for (const k of keys) {
    const hits = items.filter((i) => matchKey(i.name) === k);
    if (hits.length) return hits;
  }
  return [];
}

/** The one pantry item a line is, or undefined when there's none or more than one. */
export function matchOne(text: string, items: NamedItem[], aliases: Record<string, string> = {}): NamedItem | undefined {
  const c = candidates(text, items, aliases);
  return c.length === 1 ? c[0] : undefined;
}

/**
 * The picker's list for what's typed: exact matches first, then names starting with it, then
 * names with every word in them (plurals aside), A to Z within each. Everything when nothing's typed.
 */
export function searchItems<T extends NamedItem>(query: string, items: T[]): T[] {
  const key = matchKey(query);
  const words = key.split(' ').filter(Boolean);
  const az = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  if (!words.length) return [...items].sort(az);
  const rank = (i: T): number => {
    const k = matchKey(i.name);
    if (k === key) return 0;
    if (k.startsWith(key)) return 1;
    const have = k.split(' ');
    if (words.every((w) => have.some((h) => h.startsWith(w)))) return 2;
    if (words.every((w) => k.includes(w))) return 3;
    return -1;
  };
  return items
    .map((i) => ({ i, r: rank(i) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || az(a.i, b.i))
    .map((x) => x.i);
}
