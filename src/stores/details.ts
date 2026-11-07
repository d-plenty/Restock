import { isNative, request, viaBrowser } from './http';
import type { Chain } from '../types';

// Product details for the "hold to see it bigger" sheet: description, ingredients, allergens,
// nutrition and other important information. Asked for only when you tap Product details,
// from the store's own product page data, or Open Food Facts (by barcode) as a fallback.

export interface NutritionTable {
  header: string[];
  rows: { name: string; values: string[] }[];
  note?: string;
}

export interface ProductDetails {
  source: string;
  description?: string;
  ingredients?: string;
  allergens?: string;
  nutrition?: NutritionTable;
  /** Other important information: warnings, storage, origin, dietary notes. */
  important: { label: string; text: string }[];
  /** The product's barcode, when the shop's page has it. */
  barcode?: string;
}

type Raw = Record<string, unknown>;

const clean = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

const asText = (v: unknown): string | undefined => {
  if (typeof v === 'string') return clean(v) || undefined;
  if (Array.isArray(v)) {
    const parts = v
      .map((x) =>
        typeof x === 'string'
          ? x
          : typeof x === 'object' && x
            ? (Object.values(x as Raw).find((y) => typeof y === 'string') as string | undefined)
            : undefined,
      )
      .filter(Boolean) as string[];
    return parts.length ? clean(parts.join(', ')) : undefined;
  }
  return undefined;
};

const IMPORTANT: [RegExp, string][] = [
  [/warning/i, 'Warnings'],
  [/^important|importantinformation/i, 'Important information'],
  [/storage/i, 'Storage'],
  [/countryoforigin|originstatement|madein/i, 'Country of origin'],
  [/lifestyle|dietary/i, 'Dietary'],
  [/preparation|usage|directions/i, 'How to use'],
];

/** Walks a store's product JSON and picks out the useful parts, whatever the shape. */
export function extractDetails(data: unknown, source: string): ProductDetails {
  const out: ProductDetails = { source, important: [] };
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(v as Raw)) {
      const k = key.toLowerCase();
      if (/^(barcode|gtin|gtin13|gtin14|ean|upc)$/.test(k) && !out.barcode && (typeof value === 'string' || typeof value === 'number')) {
        const code = String(value).replace(/\D/g, '');
        if (code.length >= 8 && code.length <= 14) out.barcode = code;
        continue;
      }
      if (/nutrition/.test(k) && !out.nutrition) {
        const t = nutritionTable(value);
        if (t) out.nutrition = t;
        else walk(value, depth + 1);
        continue;
      }
      const text = asText(value);
      if (text) {
        if (/^ingredients?$|ingredientstatement|ingredientslist/.test(k) && !out.ingredients) out.ingredients = text;
        else if (/allerg/.test(k) && !out.allergens) out.allergens = text;
        else if (/^(richdescription|longdescription|marketingdescription|description)$/.test(k) && !out.description && text.length > 20)
          out.description = text;
        else {
          const imp = IMPORTANT.find(([re]) => re.test(k));
          if (imp && !seen.has(imp[1]) && text.length > 1) {
            seen.add(imp[1]);
            out.important.push({ label: imp[1], text });
          }
        }
      }
      if (typeof value === 'object') walk(value, depth + 1);
    }
  };
  walk(data, 0);
  return out;
}

/** Nutrition panels come as a table in many shapes. Turn any of them into rows. */
export function nutritionTable(v: unknown): NutritionTable | undefined {
  let data = v;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  if (!data || typeof data !== 'object') return undefined;
  // Coles-style: { servingSize, breakdown: [{ title, nutrients: [...] }] } or a list under some key.
  let list: Raw[] | undefined = Array.isArray(data) ? (data as Raw[]) : undefined;
  let note: string | undefined;
  if (!list) {
    const o = data as Raw;
    const serving = o.servingSize ?? o.ServingSize ?? o.servingsize;
    const per = o.servingsPerPack ?? o.ServingsPerPack;
    note = [serving ? `Serving size: ${serving}` : '', per ? `Servings per pack: ${per}` : ''].filter(Boolean).join(' · ') || undefined;
    const arr = Object.values(o).find((x) => Array.isArray(x) && x.length && typeof x[0] === 'object') as Raw[] | undefined;
    list = arr;
    // A breakdown of sections, each with its own nutrients: flatten to one column per section.
    if (list && list.every((s) => Array.isArray(Object.values(s).find((x) => Array.isArray(x))))) {
      const header: string[] = [];
      const rows = new Map<string, string[]>();
      list.forEach((section, i) => {
        header.push(String(section.title ?? section.name ?? section.Title ?? `Column ${i + 1}`));
        const items = Object.values(section).find((x) => Array.isArray(x)) as Raw[];
        for (const it of items) {
          const name = labelOf(it);
          if (!name) continue;
          const row = rows.get(name) ?? [];
          row[i] = valueOf(it) ?? '';
          rows.set(name, row);
        }
      });
      if (!rows.size) return undefined;
      return { header, rows: [...rows].map(([name, values]) => ({ name, values: header.map((_, i) => values[i] ?? '') })), note };
    }
  }
  if (!list?.length) return undefined;
  // Woolworths-style: [{ Name: 'Energy', Values: { 'Quantity Per Serve': '...', 'Quantity Per 100g / 100mL': '...' } }]
  const header: string[] = [];
  const rows: { name: string; values: Record<string, string> }[] = [];
  for (const it of list) {
    const name = labelOf(it);
    if (!name) continue;
    const map = (it.Values ?? it.values) as Raw | undefined;
    const values: Record<string, string> = {};
    if (map && typeof map === 'object') {
      for (const [k, val] of Object.entries(map)) {
        if (val === null || val === undefined || val === '') continue;
        if (!header.includes(k)) header.push(k);
        values[k] = String(val);
      }
    } else {
      const val = valueOf(it);
      if (val) {
        if (!header.includes('Amount')) header.push('Amount');
        values.Amount = val;
      }
    }
    rows.push({ name, values });
  }
  if (!rows.length || !header.length) return undefined;
  return {
    header: header.map((h) => h.replace(/^Quantity\s+/i, '')),
    rows: rows.map((r) => ({ name: r.name, values: header.map((h) => r.values[h] ?? '') })),
    note,
  };
}

const labelOf = (o: Raw) => {
  const v = o.Name ?? o.name ?? o.nutrient ?? o.Nutrient ?? o.label ?? o.title;
  return typeof v === 'string' ? v.trim() : undefined;
};
const valueOf = (o: Raw) => {
  const v = o.value ?? o.Value ?? o.quantity ?? o.amount;
  return v === undefined || v === null ? undefined : String(v);
};

/** Open Food Facts' shape: ingredients, allergens and per-100 g nutriments. */
export function fromOpenFoodFacts(json: Raw): ProductDetails | undefined {
  const p = json.product as Raw | undefined;
  if (json.status !== 1 || !p) return undefined;
  const out: ProductDetails = { source: 'Open Food Facts', important: [] };
  out.ingredients = asText(p.ingredients_text_en) ?? asText(p.ingredients_text);
  const tags = (p.allergens_tags as string[] | undefined)?.map((t) => t.replace(/^\w+:/, '').replace(/-/g, ' '));
  if (tags?.length) out.allergens = `Contains: ${tags.join(', ')}`;
  const traces = (p.traces_tags as string[] | undefined)?.map((t) => t.replace(/^\w+:/, '').replace(/-/g, ' '));
  if (traces?.length) out.important.push({ label: 'May contain', text: traces.join(', ') });
  const n = p.nutriments as Raw | undefined;
  if (n) {
    const pick: [string, string, string][] = [
      ['Energy', 'energy-kj_100g', 'kJ'],
      ['Protein', 'proteins_100g', 'g'],
      ['Fat, total', 'fat_100g', 'g'],
      ['– saturated', 'saturated-fat_100g', 'g'],
      ['Carbohydrate', 'carbohydrates_100g', 'g'],
      ['– sugars', 'sugars_100g', 'g'],
      ['Sodium', 'sodium_100g', 'g'],
    ];
    const rows = pick
      .filter(([, k]) => typeof n[k] === 'number')
      .map(([name, k, unit]) => ({
        name,
        values: [k === 'sodium_100g' ? `${Math.round((n[k] as number) * 1000)} mg` : `${+(n[k] as number).toFixed(1)} ${unit}`],
      }));
    if (rows.length) out.nutrition = { header: ['Per 100 g / 100 mL'], rows };
  }
  if (!out.ingredients && !out.allergens && !out.nutrition) return undefined;
  return out;
}

const hasAny = (d: ProductDetails) => !!(d.description || d.ingredients || d.allergens || d.nutrition || d.important.length);

/**
 * A shop's own product page, for matching a scan when the name doesn't (on the phone only; the
 * barcode fallback to Open Food Facts isn't used, since it says nothing about this shop).
 */
export async function shopDetails(p: { chain: Chain; storeProductId?: string }, colesStore = '0584'): Promise<ProductDetails | undefined> {
  if (!isNative() || !p.storeProductId) return undefined;
  try {
    if (p.chain === 'woolworths') return await woolworthsDetails(p.storeProductId);
    if (p.chain === 'coles') return await colesDetails(p.storeProductId, colesStore);
  } catch {
    // Not reachable: matching carries on without it.
  }
  return undefined;
}
const cache = new Map<string, ProductDetails | null>();

export async function fetchDetails(
  p: { chain: Chain; storeProductId?: string; barcode?: string },
  colesStore = '0584',
): Promise<ProductDetails | undefined> {
  const key = `${p.chain}:${p.storeProductId ?? ''}:${p.barcode ?? ''}`;
  if (cache.has(key)) return cache.get(key) ?? undefined;
  let found: ProductDetails | undefined;
  try {
    if (isNative() && p.storeProductId && p.chain === 'woolworths') found = await woolworthsDetails(p.storeProductId);
    else if (isNative() && p.storeProductId && p.chain === 'coles') found = await colesDetails(p.storeProductId, colesStore);
  } catch (e) {
    console.warn('store product details failed', e);
  }
  if ((!found || !hasAny(found)) && p.barcode) {
    try {
      const res = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(p.barcode)}.json?fields=ingredients_text,ingredients_text_en,allergens_tags,traces_tags,nutriments`,
      );
      if (res.ok) found = fromOpenFoodFacts((await res.json()) as Raw) ?? found;
    } catch {
      // offline
    }
  }
  const result = found && hasAny(found) ? found : undefined;
  cache.set(key, result ?? null);
  return result;
}

async function woolworthsDetails(id: string): Promise<ProductDetails> {
  const path = `/apis/ui/product/detail/${encodeURIComponent(id)}?isMobile=true`;
  let text: string | undefined;
  try {
    await request({ url: 'https://www.woolworths.com.au/', headers: { Accept: 'text/html' } });
    const res = await request({ url: `https://www.woolworths.com.au${path}`, headers: { Accept: 'application/json' } });
    if (res.status === 200 && res.text.trim().startsWith('{')) text = res.text;
  } catch {
    // fall through to the hidden browser
  }
  if (!text) {
    const r = await viaBrowser('woolworths', 'GET', path);
    text = r.text;
  }
  return extractDetails(JSON.parse(text), 'woolworths.com.au');
}

async function colesDetails(id: string, store: string): Promise<ProductDetails> {
  const r = await viaBrowser('coles', 'GET', `/api/bff/products/${encodeURIComponent(id)}?storeId=${encodeURIComponent(store)}`);
  const body = r.text.trim();
  if (!body.startsWith('{')) throw new Error('Coles sent a web page instead of product details');
  return extractDetails(JSON.parse(body), 'coles.com.au');
}
