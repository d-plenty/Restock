import { cachedSettings } from '../lib/db';
import {
  COSTCO_CHANGED_MESSAGE,
  COSTCO_BUSY_MESSAGE,
  COSTCO_MEMBER_ONLY,
  COSTCO_OUT_OF_STOCK,
  COSTCO_PRICE_INCLUDES_DELIVERY,
  COSTCO_PRICE_SHIPPING_AT_CHECKOUT,
  COSTCO_STILL_BLOCKED_MESSAGE,
  costcoBlockedMessage,
  costcoCantShip,
  costcoMinimum,
  costcoSpecialUntil,
} from '../lib/costcoNotice';
import { formatUnitPrice, money, packSize } from '../lib/units';
import { isNative, NativeOnlyError, request, sleep, viaBrowser, type HttpResult } from './http';
import type { CostcoInfo, StoreAdapter, StoreProduct } from './types';

// 0.9.6: Costco (costco.com.au). 0.9.7: everything Costco sells (not just food), as an ordinary shop,
// asked from inside Costco's own page on the phone (so a sign-in gives member prices).
//
// Costco's website terms ask people not to collect product listings by automated means. Declan
// decided to build this anyway for family use, so it is kept as small and gentle as it can be:
//   - OFF unless this phone has turned it on (settings.costco, after reading the notice);
//   - only when someone presses Search: one page (one request) per search, never in the background,
//     never in bulk, never from the server or the web page (it needs the phone's own HTTP);
//   - at most one request a second and a few a minute; if Costco turns it away (403, 429, a robot
//     check) it stops, says so plainly, and does not try again for a while. No retries, no fallbacks;
//   - what it reads stays on the phone (price history is never shared, exported or backed up to a server).
//
// NOTE: costco.com.au could not be reached from where this was written. The page reading below is
// written from how Costco's pages are described (a price, its own unit price, "Price includes
// delivery", "Minimum purchase of 2", "We cannot ship this product to WA", "Member Only Item", item
// numbers) and tested on hand-made pages (fixtures-costco/). It tries the page's own product data
// (JSON-LD) first, then the page's words, and gives up quietly rather than guess. It needs a test
// on a real phone.

const SITE = 'https://www.costco.com.au';
const NAME = 'Costco';
/** The cookie jar Costco's pages are asked with: its own, apart from the in-app browser's (no sign-in, no shared cookies). */
const JAR = 'costco';
/** At most this many results from a page. */
const MAX_RESULTS = 48;
/** The longest search words taken. */
const MAX_TERM = 80;

export const costcoSearchUrl = (term: string) => `${SITE}/search?text=${encodeURIComponent(term)}`;
/**
 * 0.9.7: the product search Costco's own website uses (SAP Commerce, "australia" site). Not yet seen
 * from a real phone: if it isn't there, the search page above is read instead.
 */
export const costcoApiUrl = (term: string, page = 1) =>
  `${SITE}/rest/v2/australia/products/search?query=${encodeURIComponent(term)}&fields=FULL&pageSize=48&currentPage=${Math.max(0, page - 1)}&lang=en_AU&curr=AUD`;

// ---------- being gentle ----------

/** Costco turned the search away (403, 429 or a robot check). Restock stops, with a plain message. */
export class CostcoBlockedError extends Error {
  constructor(detail: string, again = false) {
    super(again ? COSTCO_STILL_BLOCKED_MESSAGE : costcoBlockedMessage(detail));
    this.name = 'CostcoBlockedError';
  }
}
/** Too many searches in a minute. Nothing was sent to Costco. */
export class CostcoBusyError extends Error {
  constructor() {
    super(COSTCO_BUSY_MESSAGE);
    this.name = 'CostcoBusyError';
  }
}

/**
 * The pace of requests to Costco, kept in memory (so a restart is a fresh minute, but a stop after a
 * block holds until the time is up): one request at a time apart by `minGapMs`, at most `perMinute` in
 * any minute, and after a block nothing at all for `blockMs`.
 */
export class Gate {
  private stamps: number[] = [];
  private last = 0;
  private blockedUntil = 0;
  constructor(
    private minGapMs = 1100,
    private perMinute = 6,
    private blockMs = 30 * 60_000,
    private now: () => number = Date.now,
    private wait: (ms: number) => Promise<unknown> = sleep,
  ) {}

  /** Wait for a turn, or say why there isn't one. Counts the request. */
  async turn(): Promise<void> {
    if (this.now() < this.blockedUntil) throw new CostcoBlockedError('', true);
    this.stamps = this.stamps.filter((t) => this.now() - t < 60_000);
    if (this.stamps.length >= this.perMinute) throw new CostcoBusyError();
    const gap = this.last + this.minGapMs - this.now();
    if (gap > 0) await this.wait(gap);
    this.last = this.now();
    this.stamps.push(this.last);
  }

  /** Costco turned a request away: no more until the stop is over. */
  block() {
    this.blockedUntil = this.now() + this.blockMs;
  }

  reset() {
    this.stamps = [];
    this.last = 0;
    this.blockedUntil = 0;
  }
}

/** The one gate every Costco request on this phone goes through. */
export const costcoGate = new Gate();

// ---------- reading a page ----------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  times: 'x',
};
const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
const safeChar = (n: number) => (n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ');

/** The words on a page (or part of one), on one line. */
export function textOf(html: string): string {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \s]+/g, ' ')
    .trim();
}

const attr = (tag: string, name: string): string | undefined => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  const v = m ? (m[2] ?? m[3]) : undefined;
  return v === undefined ? undefined : decode(v);
};

const cents = (s: string | undefined) => {
  if (!s) return undefined;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
};

const MONEY = '\\$\\s?(\\d[\\d,]*(?:\\.\\d{1,2})?)';

/** "$1.67 per 100 g", "$62.88 per kg", "$0.42 per each", "$2.10 per litre": Costco's own unit price, as a price per gram, ml or each. */
export function parseUnitPrice(text: string): { text: string; perBase: number; unit: 'g' | 'ml' | 'ea' } | undefined {
  const m = text.match(new RegExp(`${MONEY}\\s*(?:per|/)\\s*(\\d+(?:\\.\\d+)?)?\\s*(each|ea|kg|g|ml|litres?|liters?|l)\\b`, 'i'));
  if (!m) return undefined;
  const amount = cents(m[1]);
  if (amount === undefined) return undefined;
  const n = m[2] ? parseFloat(m[2]) : 1;
  const u = m[3].toLowerCase();
  if (!(n > 0)) return undefined;
  const per =
    u === 'each' || u === 'ea'
      ? { f: 1, unit: 'ea' as const }
      : u === 'kg'
        ? { f: 1000, unit: 'g' as const }
        : u === 'g'
          ? { f: 1, unit: 'g' as const }
          : u === 'ml'
            ? { f: 1, unit: 'ml' as const }
            : { f: 1000, unit: 'ml' as const };
  return {
    text: m[0].replace(/\s+/g, ' ').trim(),
    perBase: amount / (n * per.f),
    unit: per.unit,
  };
}

const STATES: Record<string, string> = {
  'australian capital territory': 'ACT',
  'new south wales': 'NSW',
  'northern territory': 'NT',
  queensland: 'QLD',
  'south australia': 'SA',
  tasmania: 'TAS',
  victoria: 'VIC',
  'western australia': 'WA',
};
const STATE_WORD =
  '(?:Australian Capital Territory|New South Wales|Northern Territory|Queensland|South Australia|Tasmania|Victoria|Western Australia|ACT|NSW|NT|QLD|SA|TAS|VIC|WA)';

/** "We cannot ship this product to WA" (or "WA, NT and TAS"): the states, as abbreviations. */
function cantShipStates(text: string): string[] | undefined {
  const m = text.match(new RegExp(`We cannot ship this product to\\s+((?:${STATE_WORD}\\b(?:\\s*(?:,|and|&)\\s*)?)+)`, 'i'));
  if (!m) return undefined;
  const found = [...m[1].matchAll(new RegExp(STATE_WORD, 'gi'))].map((x) => STATES[x[0].toLowerCase()] ?? x[0].toUpperCase());
  return found.length ? [...new Set(found)] : undefined;
}

/** "26/10/2026" as "2026-10-26". */
const isoDay = (d: string, m: string, y: string) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;

/** What a product's words say (a result tile's, or a product page's). */
export interface Facts {
  price?: number;
  wasPrice?: number;
  save?: number;
  validFrom?: string;
  validTo?: string;
  ownUnit?: CostcoInfo['ownUnit'];
  delivery?: CostcoInfo['delivery'];
  minQty?: number;
  cantShipTo?: string[];
  memberOnlyItem?: boolean;
  outOfStock?: boolean;
  itemNumber?: string;
}

export function readFacts(text: string): Facts {
  const f: Facts = {};
  const unit = parseUnitPrice(text);
  if (unit) f.ownUnit = unit;
  // Prices, once Costco's unit price, "Save $X" and "Less -$X" are out of the way.
  let rest = text;
  if (unit) rest = rest.replace(unit.text, ' ');
  const save = rest.match(new RegExp(`\\bSave\\s*${MONEY}`, 'i'));
  if (save) {
    f.save = cents(save[1]);
    rest = rest.replace(save[0], ' ');
  }
  rest = rest.replace(new RegExp(`\\bLess\\s*-?\\s*${MONEY}`, 'gi'), ' ');
  const your = rest.match(new RegExp(`\\bYour Price\\s*:?\\s*${MONEY}`, 'i'));
  const online = rest.match(new RegExp(`\\bOnline Price\\s*:?\\s*${MONEY}`, 'i'));
  const was = rest.match(new RegExp(`\\b(?:Was|Usual price)\\s*:?\\s*${MONEY}`, 'i'));
  const plain = rest.match(new RegExp(MONEY));
  if (your) {
    f.price = cents(your[1]);
    const o = online ? cents(online[1]) : undefined;
    if (o !== undefined && f.price !== undefined && o > f.price) f.wasPrice = o;
  } else if (online) {
    f.price = cents(online[1]);
  } else if (plain) {
    f.price = cents(plain[1]);
  }
  if (f.wasPrice === undefined && was) {
    const w = cents(was[1]);
    if (w !== undefined && f.price !== undefined && w > f.price) f.wasPrice = w;
  }
  if (f.wasPrice === undefined && f.save !== undefined && f.save > 0 && f.price !== undefined) f.wasPrice = Math.round((f.price + f.save) * 100) / 100;
  const dates = text.match(/(?:price\s+)?valid\s+from\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+to\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (dates) {
    f.validFrom = isoDay(dates[1], dates[2], dates[3]);
    f.validTo = isoDay(dates[4], dates[5], dates[6]);
  }
  if (/price includes delivery/i.test(text)) f.delivery = 'included';
  else if (/shipping[^.]{0,40}added at checkout/i.test(text)) f.delivery = 'checkout';
  const min = text.match(/minimum purchase of (\d{1,3})\b/i);
  if (min && parseInt(min[1], 10) > 1) f.minQty = parseInt(min[1], 10);
  const cant = cantShipStates(text);
  if (cant) f.cantShipTo = cant;
  if (/member only item/i.test(text)) f.memberOnlyItem = true;
  if (/\b(?:out of stock|sold out)\b/i.test(text)) f.outOfStock = true;
  const num = text.match(/#\s?(\d{4,8})\b/) ?? text.match(/\bItem\s*(?:number|no\.?|#)\s*:?\s*(\d{4,8})\b/i);
  if (num) f.itemNumber = num[1];
  return f;
}

// ---------- food only ----------

const FOOD =
  /\b(?:grocery|groceries|food|pantry|snacks?|beverages?|drinks?|dairy|meat|seafood|fresh|frozen|bakery|confectionery|chocolate|lollies|coffee|tea|water|juice|produce|fruit|vegetables?|deli|cereal|breakfast|rice|pasta|baby food|nuts?|sauces?|oil|condiments?)\b/i;
const NOT_FOOD =
  /\b(?:home|homewares?|furniture|electronics?|appliances?|garden|outdoor|toys?|clothing|apparel|footwear|health|beauty|tools?|automotive|office|travel|sports?|luggage|bedding|mattress|tyres?|jewellery|cleaning|laundry|pet|party|christmas|baby|kitchenware|computers?|tvs?|phones?|vitamins?)\b/i;

/**
 * Is a category path food? "Online Grocery / Snacks" and "Grocery-Household / Pantry" are; "Home / Furniture"
 * isn't. No category at all counts as food (nothing says it isn't), a category that says neither doesn't.
 */
export function isFoodPath(path: string | undefined): boolean {
  const p = (path ?? '').replace(/[-_/]+/g, ' ').trim();
  if (!p) return true;
  if (/\b(?:grocery|groceries|food)\b/i.test(p)) return true;
  if (NOT_FOOD.test(p) && !/\bbaby food\b/i.test(p)) return false;
  return FOOD.test(p);
}

/** "Online-Grocery/Snacks/Bars/Name/p/12345" as "Online Grocery / Snacks / Bars". */
function categoryFromUrl(href: string): string | undefined {
  let path = href;
  try {
    path = new URL(href, SITE).pathname;
  } catch {
    // keep as is
  }
  const parts = path.split('/').filter(Boolean);
  const at = parts.lastIndexOf('p');
  const dirs = (at > 0 ? parts.slice(0, at) : parts).slice(0, -1);
  const cats = dirs.map((d) => decodeURIComponent(d).replace(/[-_]+/g, ' ').trim()).filter(Boolean);
  return cats.length ? cats.join(' / ') : undefined;
}

// ---------- names and sizes ----------

const SIZE_RE = /\b\d+\s*x\s*\d+(?:\.\d+)?\s*(?:kg|g|ml|l|litres?)\b|\b\d+(?:\.\d+)?\s*(?:kg|g|ml|l|litres?)\b/i;
const COUNT_RE = /\b(\d{1,4})\s*(?:pack|pk|ct|count|capsules?|pods?|bags?|cans?|bottles?|bars?|pieces?|sachets?|tablets?|tubs?|cups?|sticks?|packets?)\b/i;

/** The size as the name writes it ("36 x 40g", "1.58kg", "100 capsules"). */
export function sizeFromName(name: string): string | undefined {
  const m = name.match(SIZE_RE) ?? name.match(COUNT_RE);
  return m ? m[0].replace(/\s+/g, ' ').trim() : undefined;
}

/** How many items are in the pack, from the name ("36 x 40g" is 36, "100 capsules" is 100). */
export function countFromName(name: string): number | undefined {
  const x = name.match(/\b(\d{1,4})\s*x\s*\d/i);
  if (x && parseInt(x[1], 10) > 1) return parseInt(x[1], 10);
  const c = name.match(COUNT_RE);
  const n = c ? parseInt(c[1], 10) : 0;
  return n > 1 ? n : undefined;
}

/** A size worked out from Costco's unit price and the price, as a tidy number ("1.5kg"): an estimate. */
export function estimateSize(price: number, own: CostcoInfo['ownUnit']): string | undefined {
  if (!own || own.unit === 'ea' || !(own.perBase > 0) || !(price > 0)) return undefined;
  const total = price / own.perBase;
  const step = total < 200 ? 1 : total < 2000 ? 5 : 25;
  const tidy = Math.round(total / step) * step;
  if (!(tidy > 0)) return undefined;
  if (own.unit === 'g') return tidy >= 1000 ? `${+(tidy / 1000).toFixed(3)}kg` : `${tidy}g`;
  return tidy >= 1000 ? `${+(tidy / 1000).toFixed(3)}L` : `${tidy}ml`;
}

// ---------- making a product ----------

export interface RawCostco {
  id: string;
  name: string;
  url?: string;
  imageUrl?: string;
  barcode?: string;
  brand?: string;
  category?: string;
  /** What the page's own data (JSON-LD) says, when it does. */
  price?: number;
  inStock?: boolean;
  /** The words around it. */
  text: string;
}

export function buildProduct(r: RawCostco, state?: string): StoreProduct {
  const f = readFacts(r.text);
  const memberOnly = !!f.memberOnlyItem;
  // A member-only item has no price on the page: don't read a delivery fee or a minimum as one.
  let price = memberOnly ? undefined : (f.price ?? r.price);
  if (price !== undefined && price <= 0) price = undefined;
  let wasPrice = price !== undefined ? f.wasPrice : undefined;
  if (wasPrice !== undefined && price !== undefined && wasPrice <= price) wasPrice = undefined;
  const isSpecial = wasPrice !== undefined;

  let size = sizeFromName(r.name);
  let sizeFrom: CostcoInfo['sizeFrom'] = size ? 'name' : undefined;
  const ps = size ? packSize(size, r.name) : undefined;
  if (!ps && price !== undefined) {
    const est = estimateSize(price, f.ownUnit);
    if (est) {
      size = `${est} (estimated)`;
      sizeFrom = 'estimated';
    }
  }
  const count = countFromName(r.name);
  const perItem = price === undefined ? undefined : f.ownUnit?.unit === 'ea' ? f.ownUnit.perBase : count ? Math.round((price / count) * 100) / 100 : undefined;

  const notes: string[] = [];
  if (!memberOnly && price !== undefined) {
    if (f.delivery === 'included') notes.push(COSTCO_PRICE_INCLUDES_DELIVERY);
    else if (f.delivery === 'checkout') notes.push(COSTCO_PRICE_SHIPPING_AT_CHECKOUT);
  }
  if (memberOnly) notes.push(COSTCO_MEMBER_ONLY);
  if (f.minQty) notes.push(costcoMinimum(f.minQty));
  if (f.cantShipTo?.length) {
    // For the person's own state when it's known; the states Costco lists when it isn't.
    if (!state) notes.push(costcoCantShip(f.cantShipTo.join(', ')));
    else if (f.cantShipTo.includes(state)) notes.push(costcoCantShip(state));
  }
  if (isSpecial && f.save !== undefined) notes.push(costcoSpecialUntil(money(f.save), f.validTo ? ddmmyyyy(f.validTo) : undefined));
  if (f.outOfStock) notes.push(COSTCO_OUT_OF_STOCK);

  const unitText = unitLabel(f.ownUnit);
  const info: CostcoInfo = {
    itemNumber: f.itemNumber ?? r.id,
    url: r.url,
    category: r.category,
    delivery: f.delivery,
    minQty: f.minQty,
    cantShipTo: f.cantShipTo,
    memberOnlyItem: memberOnly || undefined,
    ownUnit: f.ownUnit,
    save: f.save,
    validFrom: f.validFrom,
    validTo: f.validTo,
    count,
    perItem,
    sizeFrom,
    notes,
  };
  for (const k of Object.keys(info) as (keyof CostcoInfo)[]) if (info[k] === undefined) delete info[k];
  return {
    chain: 'costco',
    storeProductId: r.id,
    name: r.name,
    brand: r.brand,
    size,
    barcode: r.barcode,
    imageUrl: r.imageUrl,
    price,
    wasPrice,
    isSpecial,
    memberOnly,
    promo: notes.length ? notes.join(' · ') : undefined,
    unitPriceText: unitText,
    inStock: f.outOfStock ? false : price !== undefined ? (r.inStock ?? true) : undefined,
    costco: info,
  };
}

const ddmmyyyy = (iso: string) => iso.split('-').reverse().join('/');

/** Costco's own unit price, as the same kind of label the other shops give ("$1.67 / 100g", "$0.42 each"). */
function unitLabel(own: CostcoInfo['ownUnit']): string | undefined {
  if (!own) return undefined;
  return own.unit === 'ea' ? `${money(own.perBase)} each` : formatUnitPrice(own.perBase, own.unit);
}

// ---------- reading a results page ----------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/** Every Product the page's JSON-LD describes (a lone product, a list, or a @graph). */
function ldProducts(html: string): Json[] {
  const out: Json[] = [];
  const walk = (v: unknown, depth = 0) => {
    if (depth > 6 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Json;
    const type = o['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes('Product')) out.push(o);
    for (const k of ['@graph', 'itemListElement', 'item', 'mainEntity']) if (k in o) walk(o[k], depth + 1);
  };
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1]));
    } catch {
      // not JSON: skip this block
    }
  }
  return out;
}

const idFromUrl = (u: string | undefined): string | undefined => u?.match(/\/p\/(\d{3,10})(?:[/?#]|$)/)?.[1];

/** Product links on the page, in order: the tiles. Each tile is the page from its first link to the next product's. */
function tiles(html: string): { id: string; href: string; html: string; links: string[] }[] {
  const links: {
    id: string;
    href: string;
    tag: string;
    at: number;
    end: number;
  }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*("[^"]*"|'[^']*')[^>]*>/gi)) {
    const href = decode(m[1].slice(1, -1));
    const id = idFromUrl(href);
    if (id)
      links.push({
        id,
        href,
        tag: m[0],
        at: m.index!,
        end: m.index! + m[0].length,
      });
  }
  const out: { id: string; href: string; html: string; links: string[] }[] = [];
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (out.some((t) => t.id === l.id)) continue;
    // To the next link to a different product.
    let j = i + 1;
    while (j < links.length && links[j].id === l.id) j++;
    const stop = j < links.length ? links[j].at : html.length;
    const region = html.slice(l.at, stop);
    out.push({
      id: l.id,
      href: l.href,
      html: region,
      links: links.filter((x) => x.id === l.id).map((x) => x.tag),
    });
  }
  return out;
}

/** The product's name from its tile: the link's title, the longest link text, or the picture's description. */
function tileName(t: { html: string; links: string[] }): string | undefined {
  const names: string[] = [];
  for (const l of t.links) {
    const title = attr(l, 'title') ?? attr(l, 'aria-label');
    if (title) names.push(title);
  }
  for (const m of t.html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const w = textOf(m[1]);
    if (w) names.push(w);
  }
  const alt = t.html.match(/<img\b[^>]*>/i);
  const a = alt ? attr(alt[0], 'alt') : undefined;
  if (a) names.push(a);
  const best = names.filter((n) => n.length >= 3 && n.length <= 200 && !/^\$/.test(n)).sort((x, y) => y.length - x.length)[0];
  return best?.replace(/\s+/g, ' ');
}

function ldPrice(o: Json): number | undefined {
  const offers = first(o.offers);
  if (!isObj(offers)) return undefined;
  const p = offers.price ?? offers.lowPrice;
  return cents(typeof p === 'number' ? String(p) : str(p));
}

function ldRaw(o: Json): RawCostco | undefined {
  const url = str(o.url);
  const sku = str(o.sku) ?? str(o.productID) ?? idFromUrl(url);
  const name = str(o.name);
  if (!sku || !name) return undefined;
  const offers = first(o.offers);
  const avail = isObj(offers) ? str(offers.availability) : undefined;
  const img = first(o.image);
  const brand = isObj(o.brand) ? str(o.brand.name) : str(o.brand);
  const gtin = str(o.gtin13) ?? str(o.gtin) ?? str(o.gtin14) ?? str(o.gtin12);
  return {
    id: sku.replace(/^#/, ''),
    name: decode(name),
    url: url ? abs(url) : undefined,
    imageUrl: typeof img === 'string' ? abs(img) : isObj(img) ? str(img.url) : undefined,
    barcode: gtin && /^\d{8,14}$/.test(gtin) ? gtin : undefined,
    brand,
    category: str(o.category),
    price: ldPrice(o),
    inStock: avail ? !/out ?of ?stock|soldout|discontinued/i.test(avail) : undefined,
    text: '',
  };
}

function abs(u: string): string {
  try {
    return new URL(u, SITE).toString();
  } catch {
    return u;
  }
}

/** Words on the page that say Costco turned the request away (a robot check, a block page). */
export const looksBlocked = (html: string): string | undefined =>
  /captcha|are you a robot|verify you are (?:a )?human|unusual traffic|access denied|request unsuccessful|pardon our interruption|you have been blocked/i.test(
    textOf(html.slice(0, 30_000)),
  )
    ? 'a robot check came up'
    : undefined;

/** The person's state from their area ("Bohle Plains QLD 4817"), when they've set one. */
export function stateFromArea(label: string | undefined): string | undefined {
  const m = label?.match(/\b(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\b(?=\s*\d{4}\s*$|\s*$|,)/i);
  return m ? m[1].toUpperCase() : undefined;
}

/**
 * The products on a Costco search page (or a product page the search went straight to): JSON-LD first,
 * then the words in each result tile. Never throws on a page it can't read: returns what it
 * could. `state` is the person's, so "Can't ship to WA" shows only for them.
 */
export function parseCostcoPage(html: string, state?: string): StoreProduct[] {
  const ts = tiles(html);
  const byId = new Map(ts.map((t) => [t.id, t]));
  const raws: RawCostco[] = [];
  const seen = new Set<string>();
  const add = (r: RawCostco) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    raws.push(r);
  };
  for (const o of ldProducts(html)) {
    const r = ldRaw(o);
    if (!r) continue;
    const t = byId.get(r.id);
    r.text = t ? textOf(t.html) : '';
    if (t) r.category ??= categoryFromUrl(t.href);
    if (t && !r.url) r.url = abs(t.href);
    add(r);
  }
  for (const t of ts) {
    if (seen.has(t.id)) continue;
    const name = tileName(t);
    if (!name) continue;
    const img = t.html.match(/<img\b[^>]*>/i);
    const src = img ? (attr(img[0], 'src') ?? attr(img[0], 'data-src')) : undefined;
    add({
      id: t.id,
      name,
      url: abs(t.href),
      imageUrl: src ? abs(src) : undefined,
      category: categoryFromUrl(t.href),
      text: textOf(t.html),
    });
  }
  // No tiles and no data: a single product page (a search for an item number can land on one).
  if (!raws.length) {
    const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    const name = h1 ? textOf(h1[1]) : undefined;
    const text = textOf(html);
    const id =
      html.match(/<link[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i)?.[1]?.match(/\/p\/(\d{3,10})/)?.[1] ?? readFacts(text).itemNumber;
    if (name && id) {
      const crumbs = [...html.matchAll(/<(?:li|a)\b[^>]*class\s*=\s*["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|a)>/gi)]
        .map((m) => textOf(m[1]))
        .filter(Boolean);
      add({
        id,
        name,
        category: crumbs.length ? crumbs.join(' / ') : undefined,
        text,
      });
    }
  }
  return raws
    .map((r) => buildProduct(r, state))
    .filter((p) => p.price !== undefined || p.memberOnly || p.inStock === false)
    .slice(0, MAX_RESULTS);
}

// ---------- the adapter ----------

export interface Deps {
  isNative: () => boolean;
  settings: () => { area?: { label: string } } | undefined;
  request: (opts: Parameters<typeof request>[0]) => Promise<HttpResult>;
  /** 0.9.7: a request from inside Costco's own page in the app (its cookies, so a sign-in counts). */
  browser?: (url: string) => Promise<HttpResult>;
  gate: Gate;
}

/** What to say when Costco's reply isn't a page of results: blocked, or a page that doesn't look right. */
export function checkReply(res: HttpResult): void {
  if (res.status === 403 || res.status === 429 || res.status === 401) throw new CostcoBlockedError(`HTTP ${res.status}`);
  if (res.status <= 0) throw new Error("Couldn't reach Costco just now. Check your internet, then try again.");
  if (res.status >= 400) throw new Error(`Costco returned HTTP ${res.status}`);
  const why = looksBlocked(res.text);
  if (why && !/\/p\/\d{3,10}/.test(res.text)) throw new CostcoBlockedError(why);
}

/** 0.9.7: products from Costco's product search answer (JSON). Undefined when it isn't that answer. */
export function parseCostcoApi(text: string, state?: string): StoreProduct[] | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObj(j) || !Array.isArray(j.products)) return undefined;
  const raws: RawCostco[] = [];
  for (const o of j.products as unknown[]) {
    if (!isObj(o)) continue;
    const id = str(o.code);
    const name = str(o.name) ?? str(o.englishName);
    if (!id || !name) continue;
    const price = isObj(o.price) ? (typeof o.price.value === 'number' ? Math.round(o.price.value * 100) / 100 : cents(str(o.price.formattedValue))) : undefined;
    const img = Array.isArray(o.images) ? (o.images as unknown[]).find((x) => isObj(x) && str(x.url)) : undefined;
    const stock = isObj(o.stock) ? str(o.stock.stockLevelStatus) : undefined;
    const url = str(o.url);
    const words = [str(o.summary), str(o.description)].filter(Boolean).join(' ');
    raws.push({
      id,
      name: decode(name.replace(/<[^>]+>/g, '')),
      url: url ? abs(url) : `${SITE}/p/${id}`,
      imageUrl: isObj(img) ? abs(String(img.url)) : undefined,
      brand: str(o.manufacturer),
      price,
      inStock: stock ? !/outofstock|out_of_stock/i.test(stock) : undefined,
      text: textOf(words).slice(0, 2000),
    });
  }
  return raws
    .map((r) => buildProduct(r, state))
    .filter((p) => p.price !== undefined || p.memberOnly || p.inStock === false)
    .slice(0, MAX_RESULTS);
}

export function makeCostco(deps: Deps): StoreAdapter {
  return {
    chain: 'costco',
    pages: true, // 0.9.8: "Get more from Costco"
    async search(term: string, _storeId?: string, page = 1): Promise<StoreProduct[]> {
      // Only when someone presses Search (the caller makes sure). On a phone it asks from inside
      // Costco's own page (cookies, sign-in); on the server, a plain request.
      const q = term.trim().replace(/\s+/g, ' ').slice(0, MAX_TERM);
      if (!q) return [];
      const s = deps.settings();
      const state = stateFromArea(s?.area?.label);
      const get = async (url: string, accept: string): Promise<HttpResult> => {
        try {
          if (deps.isNative() && deps.browser) return await deps.browser(url);
          return await deps.request({ url, headers: { Accept: accept, 'Accept-Language': 'en-AU,en;q=0.9' }, anonymous: JAR, timeoutMs: 20_000 });
        } catch (e) {
          if (e instanceof NativeOnlyError) throw e;
          throw new Error(`Couldn't reach ${NAME} just now. Check your internet, then try again.`);
        }
      };
      await deps.gate.turn();
      // 1. Costco's own product search (what its website asks for).
      const api = await get(costcoApiUrl(q, page), 'application/json');
      if (api.status === 403 || api.status === 429) {
        deps.gate.block();
        throw new CostcoBlockedError(`HTTP ${api.status}`);
      }
      if (api.status === 200) {
        const items = parseCostcoApi(api.text, state);
        if (items) return items;
      }
      // 2. The search page itself (first page only).
      if (page > 1) return [];
      const res = await get(costcoSearchUrl(q), 'text/html,application/xhtml+xml');
      try {
        checkReply(res);
      } catch (e) {
        if (e instanceof CostcoBlockedError) deps.gate.block();
        throw e;
      }
      const items = parseCostcoPage(res.text, state);
      if (
        !items.length &&
        res.text.length > 2000 &&
        !/no results|0 results|did not match|couldn'?t find|nothing found/i.test(textOf(res.text).slice(0, 20_000)) &&
        !/\/p\/\d{3,10}/.test(res.text)
      ) {
        // A page with no products and no "nothing found": probably not the page Restock expects.
        throw new Error(COSTCO_CHANGED_MESSAGE);
      }
      return items;
    },
  };
}

export const costco: StoreAdapter = makeCostco({
  isNative,
  settings: () => cachedSettings(),
  request,
  browser: (url) => viaBrowser('costco', 'GET', url),
  gate: costcoGate,
});
