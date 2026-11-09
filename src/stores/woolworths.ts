import { looksMemberOnly, num, parseJson, request, stockFlag, viaBrowser } from './http';
import type { StoreAdapter, StoreProduct } from './types';

const BASE = 'https://www.woolworths.com.au';
const NAME = 'Woolworths';
/** When each cookie jar last visited the homepage: "" is the usual one, others are anonymous (0.9.1). */
const sessionAt = new Map<string, number>();

async function ensureSession(force = false, jar = '') {
  // Woolworths hands out the cookies its API needs on the homepage.
  if (!force && Date.now() - (sessionAt.get(jar) ?? 0) < 20 * 60_000) return;
  await request({ url: `${BASE}/`, headers: { Accept: 'text/html' }, anonymous: jar || undefined });
  sessionAt.set(jar, Date.now());
}

const apiHeaders = (referer: string) => ({
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  Origin: BASE,
  Referer: referer,
});

type Raw = Record<string, unknown>;

export function mapWoolworths(p: Raw): StoreProduct | undefined {
  const id = p.Stockcode ?? p.stockcode;
  if (id === undefined || id === null) return undefined;
  // A price of $0 or less is a placeholder, not a price (it would read as 100% off). Same in StoreClient.java.
  const positive = (n?: number) => (n !== undefined && n > 0 ? n : undefined);
  const price = positive(num(p.Price)) ?? positive(num(p.InstorePrice));
  const was = num(p.WasPrice) ?? num(p.InstoreWasPrice);
  const isSpecial = p.IsOnSpecial === true || p.IsHalfPrice === true || p.InstoreIsOnSpecial === true || (!!was && !!price && was > price);
  const centreTag = (p.CentreTag as Raw | undefined)?.TagContent;
  const promo =
    (typeof p.PromotionDescription === 'string' && p.PromotionDescription) ||
    (p.IsHalfPrice === true ? '1/2 price' : undefined) ||
    (typeof centreTag === 'string' ? centreTag.replace(/<[^>]+>/g, '').trim() || undefined : undefined);
  // The large picture is sharper on a phone screen (0.7.6).
  const image =
    (typeof p.LargeImageFile === 'string' && p.LargeImageFile) ||
    (typeof p.MediumImageFile === 'string' && p.MediumImageFile.replace('/wowproductimages/medium/', '/wowproductimages/large/')) ||
    (typeof p.SmallImageFile === 'string' && p.SmallImageFile) ||
    ((p.ImageUris as Raw | undefined)?.medium as string | undefined);
  return {
    chain: 'woolworths',
    storeProductId: String(id),
    name: String(p.DisplayName ?? p.Name ?? 'Unknown product'),
    brand: typeof p.Brand === 'string' ? p.Brand : undefined,
    size: typeof p.PackageSize === 'string' ? p.PackageSize : undefined,
    barcode: typeof p.Barcode === 'string' && p.Barcode ? p.Barcode : undefined,
    imageUrl: image || undefined,
    price,
    wasPrice: was && price && was > price ? was : undefined,
    isSpecial,
    memberOnly: looksMemberOnly(p.IsMemberPrice === true ? 'member price' : undefined, promo, p.MemberPriceData),
    promo: promo || undefined,
    unitPriceText: typeof p.CupString === 'string' ? p.CupString : undefined,
    inStock: p.IsInStock === false || p.IsAvailable === false ? false : stockFlag(p.IsInStock, p.IsAvailable),
  };
}

/** The search response nests products inside "bundles"; flatten them. */
export function flattenWoolworths(data: Raw): StoreProduct[] {
  const out: StoreProduct[] = [];
  const outer = (data.Products ?? data.products ?? data.Bundles ?? data.bundles ?? []) as Raw[];
  for (const entry of outer) {
    const inner = Array.isArray(entry.Products) ? (entry.Products as Raw[]) : [entry];
    for (const p of inner) {
      if (p.IsMarketProduct === true) continue; // third-party marketplace sellers
      const mapped = mapWoolworths(p);
      if (mapped) out.push(mapped);
    }
  }
  return out;
}

/** Results per page; "Show more" asks for the next page (0.8.5). */
export const WOOLWORTHS_PAGE = 36;

function searchBody(term: string, page = 1) {
  const location = `/shop/search/products?searchTerm=${encodeURIComponent(term)}`;
  return {
    location,
    body: {
      SearchTerm: term,
      PageNumber: page,
      PageSize: WOOLWORTHS_PAGE,
      SortType: 'TraderRelevance',
      Location: location,
      IsSpecial: false,
      IsBundle: false,
      IsMobile: true,
      Filters: [],
      GroupEdmVariants: false,
      EnableAdReRanking: false,
    },
  };
}

async function searchOnce(term: string, page = 1, jar = ''): Promise<StoreProduct[]> {
  const { location, body } = searchBody(term, page);
  const res = await request({
    url: `${BASE}/apis/ui/Search/products`,
    method: 'POST',
    headers: apiHeaders(`${BASE}${location}`),
    body,
    anonymous: jar || undefined,
  });
  return flattenWoolworths(parseJson<Raw>(NAME, res));
}

/** Backup: the same search, made from inside woolworths.com.au in a hidden browser. */
async function searchBrowser(term: string, _storeId?: string, page = 1): Promise<StoreProduct[]> {
  const res = await viaBrowser('woolworths', 'POST', '/apis/ui/Search/products', searchBody(term, page).body);
  return flattenWoolworths(parseJson<Raw>(NAME, res));
}

export const woolworths: StoreAdapter = {
  chain: 'woolworths',

  async search(term, _storeId, page = 1) {
    await ensureSession();
    try {
      return await searchOnce(term, page);
    } catch (e) {
      // Cookies expire; get a fresh session and try once more.
      await ensureSession(true);
      void e;
      return searchOnce(term, page);
    }
  },
  searchBrowser,
  pages: true,

  /** 0.9.1: barcode lookups. Its own session on its own cookies; no hidden browser to fall back on. */
  async searchAnonymous(term, jar) {
    if (!jar) throw new Error('An anonymous search needs a cookie jar');
    await ensureSession(false, jar);
    try {
      return await searchOnce(term, 1, jar);
    } catch {
      await ensureSession(true, jar);
      return searchOnce(term, 1, jar);
    }
  },
};

// ---------- this week's half price ----------

const HALF_PRICE = '/shop/browse/specials/half-price';
function halfPriceBody(page: number) {
  return {
    categoryId: 'specialsgroup.3676',
    pageNumber: page,
    pageSize: 36,
    sortType: 'TraderRelevance',
    url: HALF_PRICE,
    location: HALF_PRICE,
    formatObject: '{"name":"Half Price"}',
    isSpecial: true,
    isBundle: false,
    isMobile: true,
    filters: [],
    token: '',
    gpBoost: 0,
    isHideUnavailableProducts: false,
    enableAdReRanking: false,
    groupEdmVariants: true,
    categoryVersion: 'v2',
  };
}

/** Woolworths' half-price specials this week (the first few pages). */
export async function woolworthsHalfPrice(pages = 3): Promise<StoreProduct[]> {
  await ensureSession();
  const out: StoreProduct[] = [];
  for (let page = 1; page <= pages; page++) {
    let items: StoreProduct[];
    try {
      const res = await request({
        url: `${BASE}/apis/ui/browse/category`,
        method: 'POST',
        headers: apiHeaders(`${BASE}${HALF_PRICE}`),
        body: halfPriceBody(page),
      });
      items = flattenWoolworths(parseJson<Raw>(NAME, res));
    } catch {
      const res = await viaBrowser('woolworths', 'POST', '/apis/ui/browse/category', halfPriceBody(page));
      items = flattenWoolworths(parseJson<Raw>(NAME, res));
    }
    out.push(...items);
    if (items.length < 30) break;
  }
  return out;
}
