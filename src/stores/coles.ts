import {
  BlockedError,
  clearCookies,
  ColesCheckError,
  isNative,
  looksMemberOnly,
  num,
  parseJson,
  promoLabel,
  request,
  sleep,
  stockFlag,
  viaBrowser,
} from './http';
import { logProblem } from '../lib/diagnostics';
import type { StoreAdapter, StoreProduct } from './types';

const BASE = 'https://www.coles.com.au';
const NAME = 'Coles';
const DEFAULT_STORE = '0584';
let apiKey: string | undefined;
let keyAt = 0;

/** Coles' web app publishes its API key in the homepage's runtime config. */
export function extractColesKey(html: string): string | undefined {
  const m = html.match(/BFF_API_SUBSCRIPTION_KEY["']?\s*:\s*["']([^"']+)["']/);
  return m?.[1];
}

async function ensureKey(force = false): Promise<string> {
  if (!force && apiKey && Date.now() - keyAt < 60 * 60_000) return apiKey;
  const res = await request({ url: `${BASE}/`, headers: { Accept: 'text/html' } });
  const key = extractColesKey(res.text);
  if (!key) throw new BlockedError(NAME, 'bot protection');
  apiKey = key;
  keyAt = Date.now();
  return key;
}

type Raw = Record<string, unknown>;

/**
 * Is a Coles price a sale? Coles tags most products with a promotion type, and most aren't sales:
 * "EVERYDAY" is its ordinary price and "BONUSCOLLECTABLE" a collectables promotion (seen in a real
 * search, 7 Nov 2026). A sale is "SPECIAL" (with a "was" price), a multi-buy, a half price, a
 * "was" price above today's, or the online-special flag. Mirrored in StoreClient.java.
 */
export function colesOnSale(pricing: Raw, price?: number, was?: number, promo?: string): boolean {
  const type = typeof pricing.promotionType === 'string' ? pricing.promotionType.toUpperCase() : '';
  if (!!was && !!price && was > price) return true;
  if (pricing.onlineSpecial === true) return true;
  if (/^(SPECIAL|MULTI_?SAVE|MULTIBUY|HALF_?PRICE)$/.test(type)) return true;
  return !!promo && /\d+\s*for\s*\$/i.test(promo);
}

/** A promotion worth naming that isn't a sale ("Bonus collectable"). */
const COLES_LABELS: Record<string, string> = { BONUSCOLLECTABLE: 'Bonus collectable' };

export function mapColes(p: Raw): StoreProduct | undefined {
  if (p._type && p._type !== 'PRODUCT') return undefined; // ads and banners
  if (p.adId) return undefined;
  const pricing = (p.pricing ?? null) as Raw | null;
  if (!p.id || !pricing) return undefined;
  // A price of $0 or less is a placeholder, not a price (it would read as 100% off). Same in StoreClient.java.
  const now = num(pricing.now);
  const price = now !== undefined && now > 0 ? now : undefined;
  const was = num(pricing.was);
  const brand = typeof p.brand === 'string' ? p.brand : undefined;
  const baseName = String(p.name ?? 'Unknown product');
  const promoText =
    (typeof pricing.offerDescription === 'string' && pricing.offerDescription) ||
    (typeof pricing.promotionDescription === 'string' && pricing.promotionDescription) ||
    (typeof pricing.specialType === 'string' && promoLabel(pricing.specialType)) ||
    (typeof pricing.promotionType === 'string' && COLES_LABELS[pricing.promotionType.toUpperCase()]) ||
    undefined;
  const images = p.imageUris as { uri?: string }[] | undefined;
  const img = images?.[0]?.uri;
  return {
    chain: 'coles',
    storeProductId: String(p.id),
    name: brand && !baseName.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${baseName}` : baseName,
    brand,
    size: typeof p.size === 'string' ? p.size : undefined,
    imageUrl: img ? `https://productimages.coles.com.au/productimages${img}` : undefined,
    price,
    wasPrice: was && price && was > price ? was : undefined,
    isSpecial: colesOnSale(pricing, price, was, promoText),
    memberOnly: looksMemberOnly(pricing.promotionType, promoText, pricing),
    promo: promoText,
    unitPriceText: typeof pricing.comparable === 'string' ? pricing.comparable : undefined,
    inStock: stockFlag(p.availability),
  };
}

export function flattenColes(data: Raw): StoreProduct[] {
  const results = (data.results ?? (data.searchResults as Raw | undefined)?.results ?? []) as Raw[];
  return results.map(mapColes).filter((x): x is StoreProduct => !!x);
}

/**
 * Coles hands out 24 results at a time; `start` is where the next lot begins (0.8.5). Its own
 * page data says so: `{ noOfResults: 87, start: 0, pageSize: 24 }`.
 */
export const COLES_PAGE = 24;
const startOf = (page: number) => String((Math.max(1, page) - 1) * COLES_PAGE);

async function searchOnce(term: string, storeId: string, key: string, page = 1) {
  const params = new URLSearchParams({
    storeId,
    searchTerm: term,
    start: startOf(page),
    sortBy: 'salesDescending',
    excludeAds: 'true',
    authenticated: 'false',
    'subscription-key': key,
  });
  const res = await request({
    url: `${BASE}/api/bff/products/search?${params}`,
    headers: { Accept: 'application/json', Referer: `${BASE}/search/products?q=${encodeURIComponent(term)}` },
  });
  return flattenColes(parseJson<Raw>(NAME, res));
}

export function colesSearchPath(term: string, storeId: string, page = 1): string {
  const params = new URLSearchParams({
    storeId,
    searchTerm: term,
    start: startOf(page),
    sortBy: 'salesDescending',
    excludeAds: 'true',
    authenticated: 'false',
  });
  return `/api/bff/products/search?${params}`;
}

/** On the phone: ask through a hidden browser page, which Coles' bot protection lets through. */
async function searchViaBrowser(term: string, storeId: string, page = 1): Promise<StoreProduct[]> {
  const r = await viaBrowser('coles', 'GET', colesSearchPath(term, storeId, page));
  const body = r.text.trim();
  if (r.status <= 0 || r.status === 403 || r.status === 429 || body.startsWith('<')) throw new ColesCheckError();
  return flattenColes(parseJson<Raw>(NAME, { ...r, text: body }));
}

export const coles: StoreAdapter = {
  chain: 'coles',

  pages: true,

  async search(term, storeId, page = 1) {
    const store = storeId || DEFAULT_STORE;
    // Your own branch (testing): if Coles won't answer for it, or has nothing, ask its online store instead.
    if (store !== DEFAULT_STORE) {
      try {
        const mine = await searchStore(term, store, page);
        if (mine.length) return mine;
        noteFallback(store, `no results for "${term}"`);
      } catch (e) {
        // Coles' bot check is about the phone, not the store: let the usual "open Coles" help show.
        if (e instanceof ColesCheckError) throw e;
        noteFallback(store, e instanceof Error ? e.message : String(e));
      }
    }
    return searchStore(term, DEFAULT_STORE, page);
  },
};

/** A search at one Coles store only, with no fallback: for "Test it" on My shops. */
export const colesAtStore = (term: string, store: string) => searchStore(term, store);

/** Logs (once a session per store) that your branch didn't answer, for Settings → Diagnostics. */
const noted = new Set<string>();
function noteFallback(store: string, why: string) {
  if (noted.has(store)) return;
  noted.add(store);
  void Promise.resolve(logProblem('coles', 'search', `Your Coles store (${store}) didn't answer (${why}), so the online prices were used.`)).catch(
    () => undefined,
  );
}

async function searchStore(term: string, store: string, page = 1): Promise<StoreProduct[]> {
  if (isNative()) return searchViaBrowser(term, store, page);
  try {
    return await searchOnce(term, store, await ensureKey(), page);
  } catch (e) {
    // Usually an expired key or session. Start fresh, pause, and try once more.
    if (e instanceof BlockedError) {
      clearCookies('www.coles.com.au');
      apiKey = undefined;
      await sleep(1500);
    }
    return searchOnce(term, store, await ensureKey(true), page);
  }
}
