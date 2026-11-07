import type { StoreChain } from '../shops';
import { looksMemberOnly, num, parseJson, request, stockFlag } from './http';
import type { StoreAdapter, StoreProduct } from './types';
import { searchWeb } from './web';
import { cleanName } from './webPage';

// Dan Murphy's and BWS. Both run on Endeavour Group's shop system, which started out as
// Woolworths' and answers searches the same way. If it turns the app away, the shop's own
// search page is read instead (web.ts).

type Raw = Record<string, unknown>;

export const ENDEAVOUR: Record<'danmurphys' | 'bws', { api: string; site: string; name: string; product: (id: string, slug?: string) => string }> = {
  danmurphys: {
    api: 'https://api.danmurphys.com.au/apis/ui',
    site: 'https://www.danmurphys.com.au',
    name: "Dan Murphy's",
    product: (id, slug) => `https://www.danmurphys.com.au/product/DM_${id}${slug ? `/${slug}` : ''}`,
  },
  bws: {
    api: 'https://api.bws.com.au/apis/ui',
    site: 'https://bws.com.au',
    name: 'BWS',
    product: (id, slug) => `https://bws.com.au/product/${id}${slug ? `/${slug}` : ''}`,
  },
};

/** Extra facts come as a list of {Name, Value} pairs. */
function detail(p: Raw, ...names: string[]): string | undefined {
  const list = (p.AdditionalDetails ?? p.additionalDetails) as Raw[] | undefined;
  if (!Array.isArray(list)) return undefined;
  for (const n of names) {
    const hit = list.find((d) => String(d.Name ?? d.name ?? '').toLowerCase() === n);
    const v = hit?.Value ?? hit?.value;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

const priceOf = (o: unknown): number | undefined => {
  if (o && typeof o === 'object') return num((o as Raw).Value ?? (o as Raw).value);
  return num(o);
};

/** The shops' own picture servers, used when the feed leaves the picture out or gives half a path. */
const PICTURE: Record<'danmurphys' | 'bws', (id: string) => string> = {
  danmurphys: (id) => `https://media.danmurphys.com.au/dmo/product/${id}-1.png`,
  bws: (id) => `https://edgmedia.bws.com.au/bws/media/products/${id}-1.png`,
};

export function pictureOf(chain: 'danmurphys' | 'bws', id: string, raw?: string): string {
  const v = raw?.trim();
  if (v && /^https?:\/\//i.test(v)) return v.replace(/^http:/i, 'https:');
  if (v && v.startsWith('//')) return `https:${v}`;
  if (v && v.startsWith('/') && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(v)) return `${ENDEAVOUR[chain].site}${v}`;
  return PICTURE[chain](id);
}

export function mapEndeavour(chain: 'danmurphys' | 'bws', p: Raw): StoreProduct | undefined {
  const id = p.Stockcode ?? p.stockcode ?? p.Sku;
  if (id === undefined || id === null) return undefined;
  const prices = (p.Prices ?? p.prices ?? {}) as Raw;
  const single = priceOf(prices.singleprice ?? prices.SinglePrice) ?? num(p.Price) ?? num(p.InstorePrice);
  const promo = priceOf(prices.promoprice ?? prices.PromoPrice);
  const member = priceOf(prices.memberprice ?? prices.MemberPrice ?? prices.memberofferprice);
  const was = priceOf(prices.wasprice) ?? num(p.WasPrice);
  const price = promo ?? single;
  const promoText =
    (typeof (prices.promoprice as Raw | undefined)?.Message === 'string' && ((prices.promoprice as Raw).Message as string)) ||
    (typeof p.PromotionDescription === 'string' ? p.PromotionDescription : undefined) ||
    detail(p, 'webpromotiondescription', 'promotiondescription');
  const brand = detail(p, 'webbrandname', 'brand') ?? (typeof p.Brand === 'string' ? p.Brand : undefined);
  const baseName = String(p.Name ?? p.DisplayName ?? detail(p, 'webdescriptionshort', 'webtitle') ?? 'Unknown product');
  const image =
    detail(p, 'image1', 'webimage1', 'image') ??
    (typeof p.MediumImageFile === 'string' ? p.MediumImageFile : undefined) ??
    (typeof p.SmallImageFile === 'string' ? p.SmallImageFile : undefined);
  const size = detail(p, 'webliquorsize', 'liquorsize', 'webpacksize') ?? (typeof p.PackageSize === 'string' ? p.PackageSize : undefined);
  const before = was ?? (promo !== undefined && single !== undefined && single > promo ? single : undefined);
  return {
    chain,
    storeProductId: String(id),
    name: cleanName(brand && !baseName.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${baseName}` : baseName) || baseName,
    brand,
    size,
    barcode: typeof p.Barcode === 'string' && p.Barcode ? p.Barcode : undefined,
    imageUrl: pictureOf(chain, String(id), image),
    price: member !== undefined && price !== undefined && member < price ? member : price,
    wasPrice: before && price && before > price ? before : undefined,
    isSpecial: promo !== undefined || (!!before && !!price && before > price) || p.IsOnSpecial === true,
    memberOnly:
      (member !== undefined && price !== undefined && member < price) ||
      looksMemberOnly(promoText, p.IsMemberOffer === true ? 'member price' : undefined),
    promo: promoText || undefined,
    unitPriceText: typeof p.CupString === 'string' ? p.CupString : undefined,
    inStock: p.IsPurchasable === false ? false : stockFlag(p.IsInStock, p.IsAvailable),
  };
}

/** Search answers nest products inside bundles; flatten them. */
export function flattenEndeavour(chain: 'danmurphys' | 'bws', data: Raw): StoreProduct[] {
  const out: StoreProduct[] = [];
  const outer = (data.Products ?? data.products ?? data.Bundles ?? []) as Raw[];
  if (!Array.isArray(outer)) return out;
  for (const entry of outer) {
    const inner = Array.isArray(entry.Products) ? (entry.Products as Raw[]) : [entry];
    for (const p of inner) {
      const m = mapEndeavour(chain, p);
      if (m && m.price !== undefined) out.push(m);
    }
  }
  return out;
}

async function apiSearch(chain: 'danmurphys' | 'bws', term: string): Promise<StoreProduct[]> {
  const e = ENDEAVOUR[chain];
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: e.site,
    Referer: `${e.site}/search?searchTerm=${encodeURIComponent(term)}`,
  };
  const body = {
    SearchTerm: term,
    PageSize: 24,
    PageNumber: 1,
    SortType: 'Relevance',
    Location: `/search?searchTerm=${encodeURIComponent(term)}`,
    Filters: [],
  };
  try {
    const res = await request({ url: `${e.api}/Search/products`, method: 'POST', headers, body });
    const out = flattenEndeavour(chain, parseJson<Raw>(e.name, res));
    if (out.length) return out;
  } catch {
    // try the other way of asking
  }
  const q = new URLSearchParams({ searchTerm: term, pageSize: '24', pageNumber: '1', sortType: 'Relevance' });
  const res = await request({ url: `${e.api}/Search/products?${q}`, headers });
  return flattenEndeavour(chain, parseJson<Raw>(e.name, res));
}

export function endeavourAdapter(chain: 'danmurphys' | 'bws'): StoreAdapter {
  return {
    chain,
    async search(term) {
      try {
        const out = await apiSearch(chain, term);
        if (out.length) return out;
      } catch {
        // fall back to the website
      }
      return searchWeb(chain as StoreChain, term);
    },
  };
}
