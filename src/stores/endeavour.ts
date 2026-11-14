import type { StoreChain } from '../shops';
import { brandKind } from '../lib/brandKinds';
import { BlockedError, isNative, looksMemberOnly, num, parseJson, request, stockFlag, viaBrowser, type HttpResult } from './http';
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

/**
 * A sales blurb isn't a name: "Canadian Club was first established in Walkerville…" (Dan
 * Murphy's sometimes puts one where the name goes, 0.8.6).
 */
const blurb = (s: string) => s.length > 80 || /…$|\.\.\.$/.test(s) || /\b(is|was|were|are)\s+(a|an|the|known|brewed|first|made|crafted|perfect|great)\b/i.test(s);

/** The product's name: the first of the shop's name fields that's a name and not a blurb. */
function nameOf(p: Raw): string {
  const list = [
    typeof p.Name === 'string' ? p.Name.trim() : undefined,
    typeof p.DisplayName === 'string' ? p.DisplayName.trim() : undefined,
    detail(p, 'productname'),
    detail(p, 'product_short_name'),
    detail(p, 'webtitle'),
    detail(p, 'producttitle'),
    detail(p, 'webdescriptionshort'),
  ].filter((x): x is string => !!x);
  return list.find((x) => !blurb(x)) ?? list[0] ?? 'Unknown product';
}

export function mapEndeavour(chain: 'danmurphys' | 'bws', p: Raw): StoreProduct | undefined {
  const id = p.Stockcode ?? p.stockcode ?? p.Sku;
  if (id === undefined || id === null) return undefined;
  const prices = (p.Prices ?? p.prices ?? {}) as Raw;
  const single = priceOf(prices.singleprice ?? prices.SinglePrice) ?? num(p.Price) ?? num(p.InstorePrice);
  const promo = priceOf(prices.promoprice ?? prices.PromoPrice);
  const member = priceOf(prices.memberprice ?? prices.MemberPrice ?? prices.memberofferprice);
  const was = priceOf(prices.wasprice) ?? num(p.WasPrice);
  const promoText =
    (typeof (prices.promoprice as Raw | undefined)?.Message === 'string' && ((prices.promoprice as Raw).Message as string)) ||
    (typeof p.PromotionDescription === 'string' ? p.PromotionDescription : undefined) ||
    detail(p, 'webpromotiondescription', 'promotiondescription');
  // 0.10.7: "2 for $55" is a deal on two, not the price of one: the price stays the shelf price
  // and the deal goes in as its words (the multi-buy setting counts it from those).
  const price = promo !== undefined && !isMultiBuy(promoText || undefined) ? promo : single;
  const brand = detail(p, 'webbrandname', 'brand') ?? (typeof p.Brand === 'string' ? p.Brand : undefined);
  const baseName = nameOf(p);
  const image =
    detail(p, 'image1', 'webimage1', 'image') ??
    (typeof p.MediumImageFile === 'string' ? p.MediumImageFile : undefined) ??
    (typeof p.SmallImageFile === 'string' ? p.SmallImageFile : undefined);
  const one = detail(p, 'webliquorsize', 'liquorsize', 'webpacksize') ?? (typeof p.PackageSize === 'string' ? p.PackageSize : undefined);
  // The same beer comes as a single, a pack and a case under one name: say which this is.
  const qty = num(detail(p, 'displayunitquantity', 'productunitquantity')) ?? 1;
  const kind = detail(p, 'webpacktype')?.toLowerCase();
  const pack = qty > 1 ? (kind === 'case' ? `Case of ${qty}` : `${qty} Pack`) : undefined;
  const size = pack && one ? `${qty} x ${one}` : one;
  const before = was ?? (price !== undefined && single !== undefined && single > price ? single : undefined);
  return {
    chain,
    storeProductId: String(id),
    name: withPack(cleanName(brand && !baseName.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${baseName}` : baseName) || baseName, pack),
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

const withPack = (name: string, pack: string | undefined) =>
  pack && !new RegExp(`\\b${pack.replace(/\s+/g, '\\s*')}\\b`, 'i').test(name) ? `${name} · ${pack}` : name;

/** "2 for $55", "Any 6 for $20": a deal on several (same rule as multiBuy in lib/verdict.ts). */
const isMultiBuy = (t?: string) => !!t && /(?<!\d)([2-9]|1[0-2])\s*for\s*\$\s*\d/i.test(t);

type Unit = { kind: 'single' | 'pack' | 'case'; qty: number };

/** What one of the shop's prices is for, from its own words: "per case of 24", "Pack (4)", "per bottle". */
export function unitOf(text?: string): Unit | undefined {
  if (!text || isMultiBuy(text)) return undefined;
  const n = Number(text.match(/(\d{1,3})/)?.[1] ?? 0);
  if (/\bcase/i.test(text)) return { kind: 'case', qty: n };
  if (/\bpack/i.test(text)) return { kind: 'pack', qty: n };
  if (/\b(bottle|can|each|single|unit)s?\b/i.test(text)) return { kind: 'single', qty: 1 };
  return undefined;
}

/**
 * How the name counts what's in the product (Dan Murphy's names the biggest way it's sold):
 *  "6x4x375mL": a case of 24 made of 4 packs; "500mLx12": a case of 12 bottles; "6X375ml": a 6 pack.
 * `cut` takes the count out of the name (the size stays), so every way it's sold shares one name.
 */
export function countIn(name: string): { base: Unit; all?: number; cut: (s: string) => string } | undefined {
  const size = String.raw`\d+(?:\.\d+)?\s*(?:ml|l|g|kg)(?![a-wyz])`;
  let m = name.match(new RegExp(String.raw`\b(\d{1,2})\s*x\s*(\d{1,2})\s*x\s*(?=${size})`, 'i'));
  if (m) return { base: { kind: 'pack', qty: Number(m[2]) }, all: Number(m[1]) * Number(m[2]), cut: (s) => s.replace(/\b\d{1,2}\s*x\s*\d{1,2}\s*x\s*/i, '') };
  m = name.match(new RegExp(String.raw`(${size})\s*x\s*(\d{1,2})\b`, 'i'));
  if (m) return { base: { kind: 'single', qty: 1 }, all: Number(m[2]), cut: (s) => s.replace(new RegExp(String.raw`(${size})\s*x\s*\d{1,2}\b`, 'i'), '$1') };
  m = name.match(new RegExp(String.raw`\b(\d{1,2})\s*x\s*(?=${size})`, 'i'));
  if (m) {
    const n = Number(m[1]);
    return { base: n >= 10 ? { kind: 'case', qty: n } : { kind: 'pack', qty: n }, cut: (s) => s.replace(new RegExp(String.raw`\b\d{1,2}\s*x\s*(?=${size})`, 'i'), '') };
  }
  return undefined;
}

const label = (u: Unit) => (u.kind === 'single' || u.qty <= 1 ? undefined : u.kind === 'case' ? (u.qty ? `Case of ${u.qty}` : 'Case') : `${u.qty} Pack`);

/**
 * 0.10.7: Dan Murphy's sells one product several ways under one stock code: a 4 pack and a case of
 * 24, say. Its answer has a price for each ("singleprice" is the smallest way it's sold online,
 * "caseprice" the case), and the name describes the case. Before 0.10.7 Restock showed the case's
 * name with the pack's price. Now each way it's sold is its own item, like BWS (which already lists
 * them separately): "4 Pines Dark Lager Cans 375mL · 4 Pack" $17.99 and "… · Case of 24" $89.99.
 */
export function mapEndeavourAll(chain: 'danmurphys' | 'bws', p: Raw): StoreProduct[] {
  const first = mapEndeavour(chain, p);
  if (!first || chain !== 'danmurphys') return first ? [first] : [];
  const prices = (p.Prices ?? p.prices ?? {}) as Raw;
  const msg = (o: unknown) => (o && typeof o === 'object' && typeof (o as Raw).Message === 'string' ? ((o as Raw).Message as string) : undefined);
  const singleRaw = prices.singleprice ?? prices.SinglePrice;
  const caseRaw = prices.caseprice ?? prices.CasePrice;
  const promoRaw = prices.promoprice ?? prices.PromoPrice;
  const casePrice = priceOf(caseRaw);
  const counted = countIn(first.name);
  const base: Unit | undefined = unitOf(msg(singleRaw)) ?? counted?.base;
  if (!base) return [first];
  const caseUnit: Unit = unitOf(msg(caseRaw)) ?? { kind: 'case', qty: counted?.all ?? 0 };
  if (caseUnit.kind !== 'case') caseUnit.kind = 'case';
  if (!caseUnit.qty && counted?.all) caseUnit.qty = counted.all;
  // the name without its count ("… Can 6x4x375mL" → "… Can 375mL"), and without a pack word we add back
  const plain = (counted ? counted.cut(first.name) : first.name).replace(/\s{2,}/g, ' ').trim();
  const one = (first.size ?? '').replace(/^\d+\s*x\s*/i, '') || undefined;
  const sizeFor = (u: Unit) => (u.qty > 1 && one ? `${u.qty} x ${one}` : one);
  // a special worded for the case is on the case, unless the main price already is the case's
  const promoOnCase = base.kind !== 'case' && unitOf(msg(promoRaw))?.kind === 'case';
  const out: StoreProduct[] = [];
  const baseItem: StoreProduct = { ...first, name: withPack(plain, label(base)), size: sizeFor(base) };
  if (promoOnCase) {
    // the special is on the case: the pack keeps its shelf price
    const shelf = priceOf(singleRaw) ?? first.price;
    Object.assign(baseItem, { price: shelf, wasPrice: undefined, isSpecial: false, promo: undefined });
  }
  out.push(baseItem);
  if (casePrice !== undefined && caseUnit.qty !== base.qty) {
    const special = promoOnCase ? priceOf(promoRaw) : undefined;
    out.push({
      ...first,
      storeProductId: `${first.storeProductId}-case`,
      name: withPack(plain, label(caseUnit)),
      size: sizeFor(caseUnit),
      barcode: undefined,
      price: special !== undefined && special < casePrice ? special : casePrice,
      wasPrice: special !== undefined && special < casePrice ? casePrice : undefined,
      isSpecial: special !== undefined && special < casePrice,
      memberOnly: promoOnCase ? first.memberOnly : false,
      promo: promoOnCase ? first.promo : undefined,
      unitPriceText: undefined,
    });
  }
  return out;
}

/** Search answers nest products inside bundles; flatten them. */
export function flattenEndeavour(chain: 'danmurphys' | 'bws', data: Raw): StoreProduct[] {
  const out: StoreProduct[] = [];
  const outer = (data.Products ?? data.products ?? data.Bundles ?? data.Items ?? []) as Raw[];
  if (!Array.isArray(outer)) return out;
  for (const entry of outer) {
    const inner = Array.isArray(entry.Products) ? (entry.Products as Raw[]) : [entry];
    for (const p of inner) {
      for (const m of mapEndeavourAll(chain, p)) if (m.price !== undefined) out.push(m);
    }
  }
  return out;
}

/**
 * Category words ("beer", "shiraz") aren't searched: the shop sends you to the category page
 * instead. These are the pages it uses, for when it doesn't say where.
 */
const CATEGORY: Record<string, string> = {
  beer: '/beer',
  cider: '/beer/cider',
  wine: '/wine',
  'red wine': '/wine/red-wine',
  'white wine': '/wine/white-wine',
  shiraz: '/wine/red-wine/shiraz',
  'cabernet sauvignon': '/wine/red-wine/cabernet-sauvignon',
  merlot: '/wine/red-wine/merlot',
  'pinot noir': '/wine/red-wine/pinot-noir',
  'sauvignon blanc': '/wine/white-wine/sauvignon-blanc',
  chardonnay: '/wine/white-wine/chardonnay',
  'pinot grigio': '/wine/white-wine/pinot-grigio-pinot-gris',
  moscato: '/wine/white-wine/moscato',
  rose: '/wine/rose',
  rosé: '/wine/rose',
  sparkling: '/wine/sparkling-wine',
  champagne: '/wine/champagne',
  spirits: '/spirits',
  premix: '/spirits/premix',
};

const TIMEOUT = 12_000;

/** How a request goes out: straight from the app, or from inside the shop's own page in the hidden browser. */
type Send = (o: { url: string; method?: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown }) => Promise<HttpResult>;
const direct: Send = (o) => request({ ...o, timeoutMs: TIMEOUT });
const inBrowser =
  (chain: 'danmurphys' | 'bws'): Send =>
  (o) =>
    viaBrowser(chain, o.method ?? 'GET', o.url, o.body);

/** A list of products, or nothing (an answer that isn't a list is nothing; a refusal is still thrown). */
function readList(chain: 'danmurphys' | 'bws', name: string, res: HttpResult): StoreProduct[] {
  try {
    return flattenEndeavour(chain, parseJson<Raw>(name, res));
  } catch (err) {
    if (err instanceof BlockedError) throw err;
    return [];
  }
}

async function browse(chain: 'danmurphys' | 'bws', location: string, headers: Record<string, string>, send: Send, page = 1): Promise<StoreProduct[]> {
  const e = ENDEAVOUR[chain];
  // "/beer/all" is the whole beer department.
  const path = new URL(location, e.site).pathname.replace(/\/$/, '').replace(/\/all$/, '');
  const [department, sub, category] = path.split('/').filter(Boolean);
  if (!department || /search|resource-not-found/.test(department)) return [];
  const q = new URLSearchParams({
    Location: path,
    department,
    pageNumber: String(page),
    pageSize: '40',
    sortType: 'Browse_Relevance_LocalSales',
    banner: 'true',
  });
  if (sub) q.set('subDepartment', sub.replace(/-/g, ' '));
  if (category) q.set('category', category);
  const res = await send({ url: `${e.api}/Browse?${q}`, headers });
  let out = readList(chain, e.name, res);
  // 0.10.6: the shop's own pages ask for a department with a POST. If the GET doesn't bring
  // products back (it can answer empty, or not at all, from inside the shop's page), ask that way.
  if (!out.length) {
    const body = {
      department,
      ...(sub ? { subDepartment: sub.replace(/-/g, ' ') } : {}),
      ...(category ? { category } : {}),
      filters: [],
      pageNumber: page,
      pageSize: 40,
      sortType: 'Browse_Relevance_LocalSales',
      Location: path,
    };
    out = await send({ url: `${e.api}/Browse`, method: 'POST', headers, body })
      .then((r) => readList(chain, e.name, r))
      .catch((err) => {
        if (err instanceof BlockedError) throw err;
        return [] as StoreProduct[];
      });
  }
  if (out.length || sub) return out;
  // A whole department's page ("/beer") is made of lists: best sellers and specials.
  const lists = await Promise.all(
    ['bestsellers', 'specials'].map((kind) =>
      send({
        url: `${e.api}/ProductGroup/Products/${department}-${kind}?Location=${encodeURIComponent(path)}&pageNumber=0&pageSize=24&showOnlyAvailable=true&sortType=ProductGroup_Relevance`,
        headers,
      })
        .then((r) => flattenEndeavour(chain, parseJson<Raw>(e.name, r)))
        .catch(() => [] as StoreProduct[]),
    ),
  );
  const seen = new Set<string>();
  return lists.flat().filter((p) => (seen.has(p.storeProductId) ? false : seen.add(p.storeProductId)));
}

export function goTo(res: HttpResult): string | undefined {
  if (res.status !== 200 || !res.text.includes('RedirectUrl')) return undefined;
  let d: unknown;
  try {
    d = JSON.parse(res.text);
  } catch {
    return undefined;
  }
  const first = (Array.isArray(d) ? d[0] : d) as Raw | undefined;
  const url = first && typeof first.RedirectUrl === 'string' ? first.RedirectUrl : undefined;
  return url && !(first as Raw).Products ? url : undefined;
}

async function apiSearch(chain: 'danmurphys' | 'bws', term: string, send: Send = direct, page = 1, again = false): Promise<StoreProduct[]> {
  const e = ENDEAVOUR[chain];
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: e.site,
    Referer: `${e.site}/search?searchTerm=${encodeURIComponent(term)}`,
  };
  const body = {
    SearchTerm: term,
    PageSize: 36,
    PageNumber: page,
    SortType: 'Relevance',
    Location: `/search?searchTerm=${encodeURIComponent(term)}`,
    Filters: [],
  };
  let moved: string | undefined;
  const redirect = (res: HttpResult) => {
    // Dan Murphy's answers a category or brand word with where to go instead, in an ordinary
    // answer: [{ ActionType: 'GoToUrl', RedirectUrl: 'https://www.danmurphys.com.au/beer/all' }] (0.8.6).
    const sent = goTo(res);
    if (sent) {
      moved = sent;
      return true;
    }
    if (res.status < 300 || res.status >= 400) return false;
    const where = Object.entries(res.headers).find(([k]) => k.toLowerCase() === 'location')?.[1];
    moved = where || moved || CATEGORY[term.trim().toLowerCase()] || '';
    return true;
  };
  // 0.10.4: a refusal (403, a bot-check page) is remembered, so "beer" (read as the beer
  // department) never ends as "found nothing" when the shop actually turned Restock away.
  let failed: unknown;
  try {
    const res = await send({ url: `${e.api}/Search/products`, method: 'POST', headers, body });
    if (!redirect(res)) {
      const out = flattenEndeavour(chain, parseJson<Raw>(e.name, res));
      if (out.length) return out;
    }
  } catch (err) {
    // try the other way of asking
    if (err instanceof BlockedError) failed = err;
  }
  if (moved === undefined) {
    try {
      const q = new URLSearchParams({ searchTerm: term, pageSize: '36', pageNumber: String(page), sortType: 'Relevance' });
      const res = await send({ url: `${e.api}/Search/products?${q}`, headers });
      if (!redirect(res)) {
        const out = flattenEndeavour(chain, parseJson<Raw>(e.name, res));
        if (out.length) return out;
      }
    } catch (err) {
      failed = err;
    }
  }
  // Sent to a category page, or nothing found for a category word: read that category.
  const where = moved || CATEGORY[term.trim().toLowerCase()];
  if (where) {
    const out = await browse(chain, where, headers, send, page).catch((err) => {
      if (err instanceof BlockedError) failed = err;
      return [] as StoreProduct[];
    });
    if (out.length) return out;
    if (failed instanceof BlockedError) throw failed;
    // Sent to a brand's page Restock can't read ("great northern" → its brand page): search for
    // the brand and what it is instead, which the shop does answer (0.8.6).
    const kind = brandKind(term);
    if (kind && !again) return apiSearch(chain, `${term} ${kind}`, send, page, true);
    return out;
  }
  if (failed) throw failed;
  return [];
}

export function endeavourAdapter(chain: 'danmurphys' | 'bws'): StoreAdapter {
  return {
    chain,
    pages: true,
    async search(term, _storeId, page = 1) {
      try {
        // The shop answered: that's the answer, even when it's nothing. Reading its website
        // instead only finds the same page of featured products for every word (0.8.6).
        return await apiSearch(chain, term, direct, page);
      } catch (err) {
        let refused = err instanceof BlockedError ? err : undefined;
        // turned away: ask again from inside the shop's own page, the way the site itself does
        if (isNative())
          try {
            return await apiSearch(chain, term, inBrowser(chain), page);
          } catch (again) {
            if (again instanceof BlockedError) refused = again;
            // fall back to reading the website
          }
        // 0.10.4: then the shop's normal search page in the built-in browser. The website's own
        // page only has the first lot. If that finds nothing too, say the shop is blocking
        // Restock, not that it found nothing.
        const web = page > 1 ? [] : await searchWeb(chain as StoreChain, term);
        if (!web.length && refused) throw refused;
        return web;
      }
    },
  };
}
