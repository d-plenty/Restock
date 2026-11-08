import { looksMemberOnly, num, parseJson, request, stockFlag, viaBrowser } from './http';
import type { StoreAdapter, StoreProduct } from './types';

const BASE = 'https://www.woolworths.com.au';
const NAME = 'Woolworths';
let sessionAt = 0;

async function ensureSession(force = false) {
  // Woolworths hands out the cookies its API needs on the homepage.
  if (!force && Date.now() - sessionAt < 20 * 60_000) return;
  await request({ url: `${BASE}/`, headers: { Accept: 'text/html' } });
  sessionAt = Date.now();
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
  const price = num(p.Price) ?? num(p.InstorePrice);
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

function searchBody(term: string) {
  const location = `/shop/search/products?searchTerm=${encodeURIComponent(term)}`;
  return {
    location,
    body: {
      SearchTerm: term,
      PageNumber: 1,
      PageSize: 36,
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

async function searchOnce(term: string): Promise<StoreProduct[]> {
  const { location, body } = searchBody(term);
  const res = await request({ url: `${BASE}/apis/ui/Search/products`, method: 'POST', headers: apiHeaders(`${BASE}${location}`), body });
  return flattenWoolworths(parseJson<Raw>(NAME, res));
}

/** Backup: the same search, made from inside woolworths.com.au in a hidden browser. */
async function searchBrowser(term: string): Promise<StoreProduct[]> {
  const res = await viaBrowser('woolworths', 'POST', '/apis/ui/Search/products', searchBody(term).body);
  return flattenWoolworths(parseJson<Raw>(NAME, res));
}

export const woolworths: StoreAdapter = {
  chain: 'woolworths',

  async search(term) {
    await ensureSession();
    try {
      return await searchOnce(term);
    } catch (e) {
      // Cookies expire; get a fresh session and try once more.
      await ensureSession(true);
      void e;
      return searchOnce(term);
    }
  },
  searchBrowser,
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
