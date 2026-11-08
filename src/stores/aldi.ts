import { APP_UA, BlockedError, num, parseJson, request, sleep, viaBrowser } from './http';
import type { StoreAdapter, StoreProduct } from './types';

const API = 'https://api.aldi.com.au/v3/product-search';
const NAME = 'Aldi';

type Raw = Record<string, unknown>;

export function mapAldi(p: Raw): StoreProduct | undefined {
  const sku = p.sku ?? p.id;
  if (!sku) return undefined;
  const priceObj = (p.price ?? {}) as Raw;
  // Aldi reports prices in cents.
  const cents = num(priceObj.amountRelevant) ?? num(priceObj.amount) ?? num(p.priceAmountCents);
  const amount = cents !== undefined ? cents / 100 : num(priceObj.amountRelevantDisplay);
  // A price of $0 or less is a placeholder, not a price (it would read as 100% off). Same in StoreClient.java.
  const price = amount !== undefined && amount > 0 ? amount : undefined;
  const wasDisplay = priceObj.wasPriceDisplay ?? priceObj.strikePriceDisplay;
  const was = num(wasDisplay);
  const brand = typeof p.brandName === 'string' ? p.brandName : undefined;
  const assets = p.assets as { url?: string }[] | undefined;
  const badges = (p.badges ?? []) as { displayText?: string; text?: string }[];
  const badgeText = badges
    .map((b) => b.displayText ?? b.text)
    .filter(Boolean)
    .join(', ');
  const img = assets?.[0]?.url?.replace('{width}', '600').replace('{slug}', String(p.urlSlugText ?? 'product'));
  return {
    chain: 'aldi',
    storeProductId: String(sku),
    name: String(p.name ?? 'Unknown product'),
    brand,
    size: typeof p.sellingSize === 'string' ? p.sellingSize : undefined,
    imageUrl: img,
    price,
    wasPrice: was && price && was > price ? was : undefined,
    isSpecial: (!!was && !!price && was > price) || /super saver|special|price drop|lower price/i.test(badgeText),
    memberOnly: false, // Aldi has no loyalty program
    promo: badgeText || undefined,
    // Aldi Australia doesn't sell groceries online, so its data marks everything "not for sale".
    // That says nothing about the shelf, so Aldi stock is always unknown.
    inStock: undefined,
    unitPriceText:
      typeof priceObj.comparisonDisplay === 'string'
        ? priceObj.comparisonDisplay
        : typeof p.comparisonPriceDisplay === 'string'
          ? p.comparisonPriceDisplay
          : undefined,
  };
}

export function flattenAldi(data: Raw): StoreProduct[] {
  const items = (data.data ?? data.results ?? []) as Raw[];
  return items.map(mapAldi).filter((x): x is StoreProduct => !!x);
}

/** Results per page, as Aldi's own website asks (0.8.5: was 24). */
export const ALDI_PAGE = 30;

function searchUrl(term: string, storeId?: string, page = 1): string {
  const params = new URLSearchParams({
    currency: 'AUD',
    serviceType: 'walk-in',
    q: term,
    limit: String(ALDI_PAGE),
    offset: String((page - 1) * ALDI_PAGE),
    sort: 'relevance',
  });
  if (storeId) params.set('servicePoint', storeId);
  return `${API}?${params}`;
}

/** Backup: the same search, made from inside aldi.com.au in a hidden browser. */
async function searchBrowser(term: string, storeId?: string, page = 1): Promise<StoreProduct[]> {
  return flattenAldi(parseJson<Raw>(NAME, await viaBrowser('aldi', 'GET', searchUrl(term, storeId, page))));
}

async function search(term: string, storeId?: string, page = 1): Promise<StoreProduct[]> {
  const url = searchUrl(term, storeId, page);
  let last: unknown;
  // Aldi's bot protection is picky. Try the style that worked last, then the other, pausing between.
  for (let attempt = 0; attempt < 3; attempt++) {
    const style = (aldiStyle + attempt) % 2;
    try {
      const res = await request({ url, headers: aldiHeaders(style) });
      const out = flattenAldi(parseJson<Raw>(NAME, res));
      aldiStyle = style;
      return out;
    } catch (e) {
      last = e;
      if (!(e instanceof BlockedError)) throw e;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw last;
}

/** 0 = app identity, 1 = browser style. Same as StoreClient.java. */
let aldiStyle = 0;

export function aldiHeaders(style: number): Record<string, string> {
  return style === 0
    ? { Accept: 'application/json', 'User-Agent': APP_UA }
    : { Accept: 'application/json', Origin: 'https://www.aldi.com.au', Referer: 'https://www.aldi.com.au/' };
}

export const aldi: StoreAdapter = {
  chain: 'aldi',
  search,
  searchBrowser,
  pages: true,
};
