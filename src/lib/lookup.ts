import type { Section } from '../shops';
import { adapterFor } from '../stores';
import type { BarcodeInfo } from './barcode';
import { findProductByBarcode } from './db';
import { sameCode } from './searchHelp';

// Working out what a scanned barcode is, and what to search the shops for.
//
// Tried in order: things you've scanned before; the Open Food Facts family of open databases
// (food, health and beauty, other products); Woolworths and Coles, which sell a lot of
// pharmacy and drinks lines and can be searched by barcode (only the name is used, nothing is
// added from them); and finally the barcode digits themselves.
//
// Bottle shop and pharmacy websites search badly by long names, so for those Restock searches a
// short version: "hard solo lemonade" rather than "Hard Solo Alcoholic Lemonade 4% 10 x 375ml",
// and for medicines the active ingredient and strength, like "paracetamol 500mg", so an unknown
// brand still finds the same medicine. Results are still ranked by the full name and pack size.

export interface Identified extends BarcodeInfo {
  /** Where the name came from, for "Found on …". */
  source?: string;
  /** The entry only had the brand; the kind of product was added from its category. */
  kindOnly?: boolean;
}

type OpenDb = 'food' | 'beauty' | 'products';
const OPEN_HOSTS: Record<OpenDb, { host: string; label: string }> = {
  food: { host: 'world.openfoodfacts.org', label: 'Open Food Facts' },
  beauty: { host: 'world.openbeautyfacts.org', label: 'Open Beauty Facts' },
  products: { host: 'world.openproductsfacts.org', label: 'Open Products Facts' },
};

async function openDb(db: OpenDb, code: string): Promise<Identified | undefined> {
  try {
    const res = await fetch(
      `https://${OPEN_HOSTS[db].host}/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_en,generic_name,generic_name_en,categories,brands,quantity,image_small_url,image_front_small_url`,
    );
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      status?: number;
      product?: {
        product_name?: string;
        product_name_en?: string;
        generic_name?: string;
        generic_name_en?: string;
        categories?: string;
        brands?: string;
        quantity?: string;
        image_small_url?: string;
        image_front_small_url?: string;
      };
    };
    const p = json.status === 1 ? json.product : undefined;
    let kindOnly = false;
    let name = collapseRepeats((p?.product_name_en || p?.product_name || '').trim());
    if (!p || !name) return undefined;
    const brand = p.brands?.split(',')[0]?.trim() || undefined;
    // Only the brand as the name ("Earth Choice"): add what kind of product it is, if the entry says.
    if (weakName({ name, brand })) {
      const kind = productKind(p.generic_name_en || p.generic_name, p.categories);
      if (kind) {
        name = collapseRepeats(`${brand ?? name} ${kind}`);
        kindOnly = true;
      }
    }
    return {
      barcode: code,
      name,
      brand,
      size: p.quantity?.trim() || undefined,
      imageUrl: p.image_small_url || p.image_front_small_url,
      source: OPEN_HOSTS[db].label,
      kindOnly: kindOnly || undefined,
    };
  } catch {
    return undefined;
  }
}

/** Woolworths and Coles can be searched by barcode: take the name of an exact match. */
async function supermarket(chain: 'woolworths' | 'coles', code: string): Promise<Identified | undefined> {
  try {
    const a = adapterFor(chain);
    if (!a) return undefined;
    const found = await a.search(code);
    const hit = found.find((p) => sameCode(p.barcode, code));
    if (!hit) return undefined;
    return {
      barcode: code,
      name: hit.name,
      brand: hit.brand,
      size: hit.size,
      imageUrl: hit.imageUrl,
      source: chain === 'woolworths' ? 'Woolworths' : 'Coles',
    };
  } catch {
    return undefined;
  }
}

export async function identifyBarcode(code: string, section: Section): Promise<Identified> {
  // 1. Scanned before (even if it isn't in your pantry any more).
  const mine = await findProductByBarcode(code).catch(() => undefined);
  if (mine?.name)
    return { barcode: code, name: mine.name, brand: mine.brand, size: mine.size, imageUrl: mine.imageUrl, source: 'your earlier scans' };
  // 2. The open databases, most likely first for this tab.
  const order: OpenDb[] =
    section === 'pharmacy' ? ['beauty', 'products', 'food'] : section === 'keg' ? ['food', 'products'] : ['food', 'products', 'beauty'];
  let open: Identified | undefined;
  for (const db of order) {
    open = await openDb(db, code);
    if (open) break;
  }
  // A good name from the open databases is enough. Some entries only have the brand ("Earth
  // Choice"), which finds every product of that brand, so then the supermarkets are asked too.
  if (open && !weakName(open) && !open.kindOnly) return open;
  // 3. The supermarkets, for the name only.
  for (const c of ['woolworths', 'coles'] as const) {
    const hit = await supermarket(c, code);
    if (hit) return { ...hit, imageUrl: hit.imageUrl ?? open?.imageUrl, size: hit.size ?? open?.size };
  }
  return open ?? { barcode: code };
}

/**
 * What kind of product an open-database entry says it is ("Dishwashing liquid"), or nothing.
 * Category lists can hold tags rather than words ("en:dish-soaps", "open-beauty-facts"), which
 * would make a nonsense name and a nonsense search, so only plain words count.
 */
export function productKind(generic?: string, categories?: string): string | undefined {
  const plain = (x?: string) => {
    const t = (x ?? '').trim();
    if (!t || /^[a-z]{2,3}:/i.test(t) || /facts|https?:|www\./i.test(t)) return undefined;
    // A slug ("open-beauty-facts", "dish_soaps") is a tag, not a name.
    if (!/\s/.test(t) && /[-_]/.test(t)) return undefined;
    if (!/[a-z]{3}/i.test(t)) return undefined;
    return t;
  };
  return plain(generic) ?? [...(categories ?? '').split(',')].reverse().map(plain).find(Boolean);
}

/** "Earth Choice Earth Choice" → "Earth Choice": a name with the same words twice in a row. */
export function collapseRepeats(name: string): string {
  const w = name.split(/\s+/).filter(Boolean);
  for (let n = Math.floor(w.length / 2); n >= 1; n--) {
    for (let i = 0; i + 2 * n <= w.length; i++) {
      const a = w
        .slice(i, i + n)
        .join(' ')
        .toLowerCase();
      const b = w
        .slice(i + n, i + 2 * n)
        .join(' ')
        .toLowerCase();
      if (a === b) return collapseRepeats([...w.slice(0, i + n), ...w.slice(i + 2 * n)].join(' '));
    }
  }
  return w.join(' ');
}

/** A name that says little more than the brand: "Earth Choice", "Earth Choice Earth Choice". */
export function weakName(info: { name?: string; brand?: string }): boolean {
  const words = (s?: string) =>
    (s ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1);
  const brand = new Set(words(info.brand));
  return words(info.name).filter((w) => !brand.has(w)).length < 1;
}

/** "Earth Choice" + "Earth Choice Dishwashing Liquid" → "Earth Choice Dishwashing Liquid" (no doubled brand). */
export function displayName(info: { name?: string; brand?: string }): string {
  const name = (info.name ?? '').trim();
  const brand = (info.brand ?? '').trim();
  if (!brand || name.toLowerCase().includes(brand.toLowerCase())) return name;
  return `${brand} ${name}`.trim();
}

// ---------- short searches for bottle shops and pharmacies ----------

/** Active ingredients, as written on Australian packs. */
const INGREDIENTS = [
  'paracetamol',
  'ibuprofen',
  'aspirin',
  'naproxen',
  'diclofenac',
  'loratadine',
  'desloratadine',
  'cetirizine',
  'levocetirizine',
  'fexofenadine',
  'pseudoephedrine',
  'phenylephrine',
  'dextromethorphan',
  'guaifenesin',
  'bromhexine',
  'omeprazole',
  'esomeprazole',
  'pantoprazole',
  'famotidine',
  'loperamide',
  'hyoscine',
  'simethicone',
  'docusate',
  'bisacodyl',
  'sennosides',
  'macrogol',
  'lactulose',
  'chlorhexidine',
  'povidone-iodine',
  'hydrocortisone',
  'clotrimazole',
  'miconazole',
  'terbinafine',
  'mometasone',
  'budesonide',
  'fluticasone',
  'oxymetazoline',
  'xylometazoline',
  'salbutamol',
  'nicotine',
  'melatonin',
  'zinc oxide',
  'magnesium',
  'vitamin d',
  'vitamin c',
  'fish oil',
  'glucosamine',
];

/** Well-known brands whose packs don't always print the ingredient in the product name. */
const BRAND_INGREDIENT: Record<string, string> = {
  panadol: 'paracetamol',
  panamax: 'paracetamol',
  nurofen: 'ibuprofen',
  advil: 'ibuprofen',
  voltaren: 'diclofenac',
  claratyne: 'loratadine',
  zyrtec: 'cetirizine',
  telfast: 'fexofenadine',
  aerius: 'desloratadine',
  imodium: 'loperamide',
  buscopan: 'hyoscine',
  nexium: 'esomeprazole',
  somac: 'pantoprazole',
  canesten: 'clotrimazole',
  lamisil: 'terbinafine',
  betadine: 'povidone-iodine',
  ventolin: 'salbutamol',
  nicorette: 'nicotine',
};

const STRENGTH = /\b(\d+(?:\.\d+)?)\s?(mg|mcg|µg|g|iu|%)\b/i;

/** For medicines: the active ingredient (and strength), so any brand of the same thing turns up. */
export function genericMedicine(name: string, brand?: string): string | undefined {
  const text = `${brand ?? ''} ${name}`.toLowerCase();
  const found = INGREDIENTS.filter((i) => text.includes(i));
  let base = found.slice(0, 2).join(' ');
  if (!base) {
    const b = Object.keys(BRAND_INGREDIENT).find((k) => text.includes(k));
    if (b) base = BRAND_INGREDIENT[b];
  }
  if (!base) return undefined;
  // A strength only when it's a medicine strength (mg, mcg), not a pack size in g or ml.
  const st = name.match(STRENGTH);
  const strength = st && /mg|mcg|µg|iu/i.test(st[2]) ? ` ${st[1]}${st[2].toLowerCase()}` : '';
  return `${base}${strength}`;
}

const DRINK_FLUFF =
  /\b(\d+(?:\.\d+)?\s?%(\s?(abv|alc\.?(\s?\/?\s?vol)?))?|\d+\s?x\s?\d+(?:\.\d+)?\s?(ml|l)|\d+(?:\.\d+)?\s?(ml|l|litres?|cl)|x\s?\d+|\d+\s?(pack|pk)|cans?|bottles?|stubbies|stubby|case|block|carton|alcoholic|premium|original|zero sugar|sugar free|new|limited edition)\b/gi;

/** For drinks: brand and product, without sizes, strengths and pack counts. */
export function shortDrink(name: string, brand?: string): string {
  let n = name.replace(DRINK_FLUFF, ' ').replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();
  if (brand && !n.toLowerCase().startsWith(brand.toLowerCase())) n = `${brand} ${n}`;
  const words = n.split(' ').filter(Boolean);
  return words.slice(0, 3).join(' ');
}

/** What to search the shops for, for a scanned product on this tab. */
export function searchTermFor(info: BarcodeInfo, section: Section): { term: string; generic: boolean } {
  const full = displayName(info);
  if (!info.name) return { term: info.barcode, generic: false };
  if (section === 'pharmacy') {
    const g = genericMedicine(info.name, info.brand);
    if (g) return { term: g, generic: true };
    return { term: shortDrink(info.name, info.brand), generic: true };
  }
  if (section === 'keg') return { term: shortDrink(info.name, info.brand), generic: true };
  return { term: full, generic: false };
}

/** One-tap choices when nobody knows a barcode. */
export const QUICK_PICKS: Record<Section, string[]> = {
  pantry: [],
  keg: ['Beer', 'Pre-mix cans', 'Wine', 'Spirits', 'Cider', 'Seltzer'],
  pharmacy: ['Paracetamol', 'Ibuprofen', 'Antihistamine', 'Cold and flu', 'Vitamins', 'Sunscreen', 'First aid'],
};
