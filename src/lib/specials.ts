import { type StoreChain } from '../shops';
import { flattenColes } from '../stores/coles';
import { isNative } from '../stores/http';
import type { StoreProduct } from '../stores/types';
import { render } from '../stores/web';
import { woolworthsHalfPrice } from '../stores/woolworths';
import { getKV, putKV } from './db';

// This week's half-price specials at Woolworths and Coles, for the Specials page. Kept for 12
// hours, since the lists only change on Wednesdays. Aldi's Special Buys are a page of their own,
// so the Specials page links straight to it.

export interface SpecialsList {
  chain: StoreChain;
  items: StoreProduct[];
  error?: string;
  at: string;
}

const KEY = 'specials';
const FRESH = 12 * 3_600_000;

async function colesHalfPrice(pages = 2): Promise<StoreProduct[]> {
  const out: StoreProduct[] = [];
  for (let page = 1; page <= pages; page++) {
    const r = await render('coles', `https://www.coles.com.au/on-special?filter_Special=halfprice${page > 1 ? `&page=${page}` : ''}`);
    const m = r.html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) throw new Error("Coles didn't send its specials list");
    const data = JSON.parse(m[1]) as { props?: { pageProps?: Record<string, unknown> } };
    const items = flattenColes(data.props?.pageProps ?? {});
    out.push(...items);
    if (items.length < 40) break;
  }
  return out;
}

const FAKE: StoreProduct[] = [
  {
    chain: 'woolworths',
    storeProductId: 'f1',
    name: 'Arnott’s Tim Tam Original 200g',
    price: 2.75,
    wasPrice: 5.5,
    isSpecial: true,
    memberOnly: false,
    promo: '1/2 price',
  },
  {
    chain: 'woolworths',
    storeProductId: 'f2',
    name: 'Cadbury Dairy Milk 180g',
    price: 3.5,
    wasPrice: 7,
    isSpecial: true,
    memberOnly: false,
    promo: '1/2 price',
  },
  {
    chain: 'coles',
    storeProductId: 'f3',
    name: 'Colgate Total Toothpaste 200g',
    price: 4.5,
    wasPrice: 9,
    isSpecial: true,
    memberOnly: false,
    promo: '1/2 price',
  },
  {
    chain: 'coles',
    storeProductId: 'f4',
    name: 'Coles Diced Tomatoes 400g',
    price: 0.6,
    wasPrice: 1.2,
    isSpecial: true,
    memberOnly: false,
    promo: '1/2 price',
  },
];

export async function loadSpecials(fresh = false): Promise<SpecialsList[]> {
  const cached = fresh ? undefined : await getKV<SpecialsList[]>(KEY).catch(() => undefined);
  if (cached?.length && cached.every((l) => Date.now() - Date.parse(l.at) < FRESH)) return cached;
  const at = new Date().toISOString();
  if (import.meta.env.VITE_FAKE_STORES === '1') {
    return (['woolworths', 'coles'] as const).map((chain) => ({ chain, items: FAKE.filter((p) => p.chain === chain), at }));
  }
  if (!isNative()) return [];
  const jobs: [StoreChain, () => Promise<StoreProduct[]>][] = [
    ['woolworths', () => woolworthsHalfPrice()],
    ['coles', () => colesHalfPrice()],
  ];
  const lists = await Promise.all(
    jobs.map(async ([chain, run]) => {
      try {
        return { chain, items: await run(), at };
      } catch (e) {
        return { chain, items: [], error: e instanceof Error ? e.message : String(e), at };
      }
    }),
  );
  if (lists.some((l) => l.items.length)) await putKV(KEY, lists).catch(() => undefined);
  return lists;
}

const STOP = new Set(['the', 'and', 'with', 'for', 'pack', 'each', 'original', 'classic', 'coles', 'woolworths', 'aldi', 'macro', 'select']);
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d/.test(w));

/** Specials that look like something you buy: they share a word with one of your pantry items. */
export function likeYourPantry(items: StoreProduct[], pantryNames: string[]): StoreProduct[] {
  const mine = new Set(pantryNames.flatMap(words));
  return items.filter((p) => words(p.name).some((w) => mine.has(w)));
}
