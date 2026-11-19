// 0.12.7: a short name to offer for a new item ("Strawberry jam", "Balsamic dressing", "Cheese").
// The name box starts empty and the person names the item; this is the one suggestion under it.
// It comes from what was searched and the words every pick shares, never from one product's fine
// print (a dressing was named "Sugar" from "25% Less Sugar" on one pick). No brand, no size: it has
// to work when said out loud ("add cheese").
import { genericName } from './naming';
import { tidyItemName } from './itemName';

export interface NamePick {
  name: string;
  brand?: string;
}

/** Claims and pack words that describe a product without saying what it is. */
const NOISE = new Set(
  'the a an and or of in with for to from by no new pack packs pk x ea each per value big family size sized large small medium mini regular original classic premium select finest quality fresh natural real pure simply style australian aussie made free fat less low reduced lite light added sugar salt extra super ultra best choice brand homebrand essentials range'.split(' '),
);
const SIZE = /\b\d+(?:\.\d+)?\s*(?:x\s*\d+(?:\.\d+)?\s*)?(?:kg|g|mg|ml|l|litres?|pk|packs?|ea|each|sheets?|rolls?|tabs?|tablets?|capsules?|pods?|bags?|cm|mm|m)\b/gi;
/** "99% Fat Free", "25% Less Sugar", "No Added Sugar": what's on the label, not what it is. */
const CLAIM = /\b\d+(?:\.\d+)?\s*%(?:\s+(?:fat|sugar|salt|less|free|more|reduced|extra|lower|off|juice|fruit))*|\bno added \w+|\b\w+[- ]free\b|\b(?:less|reduced|low|lower) (?:fat|sugar|salt)\b/gi;

const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(CLAIM, ' ')
    .replace(SIZE, ' ')
    .replace(/[^a-z& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const stem = (w: string) => (w.length > 3 ? w.replace(/ies$/, 'y').replace(/(?:es|s)$/, '') : w);
const wordsOf = (s: string) => plain(s).split(' ').filter(Boolean);
const brandWords = (p: NamePick) => new Set(wordsOf(p.brand ?? '').map(stem));

/** The words a pick's name is made of, without its brand, claims, size and filler. */
function meaning(p: NamePick): string[] {
  const brand = brandWords(p);
  return wordsOf(p.name).filter((w) => !brand.has(stem(w)) && !NOISE.has(w) && w.length > 1);
}

/** Words (in the first pick's order) that every pick has. */
function shared(picks: NamePick[]): string[] {
  const all = picks.map((p) => new Set(meaning(p).map(stem)));
  return meaning(picks[0]).filter((w, i, xs) => xs.indexOf(w) === i && all.every((s) => s.has(stem(w))));
}

const say = (words: string[]) => tidyItemName(words.join(' '));
const MAX_WORDS = 3;

/**
 * The name to offer, or '' when there's nothing good to offer.
 * - `typed`: what was searched for, when it was words (not a barcode).
 * - `scanned`: the product name a barcode lookup gave, when it's a real name.
 */
export function suggestName(picks: NamePick[], typed?: string, scanned?: NamePick): string {
  const search = wordsOf(typed ?? '').filter((w) => !NOISE.has(w));
  const common = picks.length ? shared(picks) : [];
  if (search.length && search.length <= MAX_WORDS) {
    const searchStems = new Set(search.map(stem));
    // What you searched, when your picks are that ("balsamic dressing"), with the one word they
    // all add in front ("jam" → "Strawberry jam").
    const fits = !picks.length || picks.every((p) => { const m = new Set(wordsOf(p.name).map(stem)); return [...searchStems].every((s) => m.has(s)); });
    if (fits) {
      const extra = picks.length >= 2 ? common.filter((w) => !searchStems.has(stem(w))).slice(0, 1) : [];
      return say([...extra, ...search]);
    }
  }
  // Several picks that share words: those words ("Strawberry jam").
  if (picks.length >= 2 && common.length && common.length <= MAX_WORDS) return say(common);
  // One pick, a scan, or picks with too much or nothing in common: the kind of thing it is.
  const from = scanned ?? picks[0];
  if (!from) return search.length ? say(search.slice(0, MAX_WORDS)) : '';
  const cleaned = from.name.replace(CLAIM, ' ').replace(/\s+/g, ' ').trim();
  const kind = genericName(cleaned, from.brand);
  return kind && kind.split(/\s+/).length <= MAX_WORDS ? tidyItemName(kind) : say(meaning(from).slice(0, MAX_WORDS));
}
