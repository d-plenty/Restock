import type { Chain } from '../types';
import { num } from './http';
import type { StoreProduct } from './types';

// Reading products and prices out of an ordinary shop web page.
//
// Most shop websites carry their products in a form meant for search engines and the page's
// own code: schema.org "JSON-LD", the data a Next.js or Nuxt page starts with, or plain product
// cards. This finds whichever is there. It is used for every bottle shop and pharmacy that
// doesn't have a dedicated connection, and for shops the person adds themselves.

type Raw = Record<string, unknown>;
export type ParseHtml = (html: string) => Document;

const defaultParse: ParseHtml = (html) => new DOMParser().parseFromString(html, 'text/html');

/** Make a link absolute, or undefined if it isn't a web link. */
export function absolute(href: unknown, base: string): string | undefined {
  if (typeof href !== 'string' || !href.trim() || href.startsWith('javascript:') || href.startsWith('#')) return undefined;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const text = (v: unknown): string | undefined => {
  if (typeof v === 'string')
    return (
      v
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim() || undefined
    );
  if (typeof v === 'number') return String(v);
  return undefined;
};

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

/** A price from a number, "12.99", "$12.99", {value: 12.99}, or cents in Shopify-style fields. */
function priceOf(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'object') {
    const o = v as Raw;
    return priceOf(o.value ?? o.Value ?? o.amount ?? o.price ?? o.Price ?? o.current ?? o.now ?? o.formatted ?? o.displayValue);
  }
  const n = num(typeof v === 'string' ? v.replace(/[^\d.,-]/g, '') : v);
  return n !== undefined && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : undefined;
}

function imageOf(v: unknown, base: string): string | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return absolute(v, base);
  if (Array.isArray(v)) return imageOf(v[0], base);
  if (typeof v === 'object') {
    const o = v as Raw;
    return imageOf(o.url ?? o.src ?? o.contentUrl ?? o.href ?? o.large ?? o.medium ?? o.small, base);
  }
  return undefined;
}

/** A size like "375ml", "6 x 375mL", "500g" or "24 Pack" in a product name. */
function sizeIn(name: string): string | undefined {
  const m = name.match(/\b\d+\s*x\s*\d+(?:\.\d+)?\s*(?:ml|l|g|kg)\b|\b\d+(?:\.\d+)?\s*(?:ml|l|g|kg|litres?|pack|pk|tablets|capsules|caplets)\b/i);
  return m?.[0];
}

/**
 * A product name as a shop would write it on a shelf tag: no "View details for", no "(always
 * read the label)", no marketing paragraph after the size.
 */
export function cleanName(raw: string): string {
  let n = decode(raw)
    .replace(/\s+/g, ' ')
    .replace(/^(view (product )?details( for)?|shop now|buy now|quick view|add to (cart|trolley))[:\s-]*/i, '')
    .replace(/\((always )?read the label[^)]*\)/gi, '')
    .replace(/\b(always read the label|use only as directed)\b\.?/gi, '')
    .replace(/[\^®™*†]+/g, '')
    // Icon-font symbols and badges that sit next to the name on the card.
    .replace(/[\u2190-\u21ff\u2200-\u22ff\u2300-\u23ff\u25a0-\u27bf\ue000-\uf8ff]+/g, ' ')
    .replace(/\b\d{1,2}\s?% off( rrp)?\b|\b(save|was|now|only)\s*\$\s?\d[\d,]*(\.\d{2})?/gi, ' ')
    .replace(/^(new|sale|special|hot price|online only|clearance|best seller|exclusive)[\s:!-]+(?=[A-Z0-9])/i, '')
    // A price is never part of a product's name.
    .replace(/\s*\$\s?\d[\d,]*(\.\d{1,2})?\b/g, ' ')
    // The brand shown above the name and again at its start ("ApoHealth ApoHealth Paracetamol").
    .replace(/^\s*((?:[\w'&.-]+\s){1,3}?)\1/i, '$1')
    .replace(/\s+/g, ' ')
    .replace(/([a-z])\.?(\d)([A-Z])/g, '$1.$2 $3') // "No.7Tennessee" → "No.7 Tennessee"
    .trim();
  if (n.length > 70) {
    // Stop after the size ("… 700ML One of the few…" → "… 700ML"), else after the first sentence.
    const size = n.match(/^(.{10,}?\b\d+(?:\.\d+)?\s*(?:x\s*\d+(?:\.\d+)?\s*)?(?:ml|l|litres?|g|kg|pack|pk|tablets|capsules|caplets)\b)/i);
    if (size) n = size[1];
    else {
      const sentence = n.match(/^(.{25,}?[a-z0-9)])\.\s+[A-Z]/);
      if (sentence) n = sentence[1];
    }
  }
  n = n.replace(/\s*\.{3,}\s*$|\s*…\s*$/, '').replace(/[\s,;:-]+$/, '');
  return n.length > 110 ? `${n.slice(0, 107).replace(/\s+\S*$/, '')}…` : n;
}

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The words in a product link, like /p/hard-rated-orange-passionfruit-zero-sugar-cans-375ml/929475. */
function slugWords(url: string | undefined): string[] {
  if (!url) return [];
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return [];
  }
  const segs = path
    .split('/')
    .map((x) => {
      try {
        return decodeURIComponent(x);
      } catch {
        return x;
      }
    })
    .map((x) => x.replace(/\.(html?|aspx?|php)$/i, ''))
    .filter((x) => /[a-z]/i.test(x) && /[-_]/.test(x));
  const slug = segs.sort((a, b) => b.split(/[-_]/).length - a.split(/[-_]/).length)[0];
  if (!slug) return [];
  const words = slug
    .split(/[-_+]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  // Product numbers at either end aren't part of the name.
  while (words.length && /^[a-z]{0,3}\d{4,}$/.test(words[words.length - 1])) words.pop();
  while (words.length && /^[a-z]{0,3}\d{4,}$/.test(words[0])) words.shift();
  return words.length >= 3 ? words : [];
}

const UNITS = /^(\d+(\.\d+)?)?(ml|l|g|kg|mg|mcg|cm|mm|m|x|pk|pack|ea)$/;

/**
 * Fix a name using the product's link, which usually spells the whole name out:
 * "Hard Rated OrangePassionfruit Zero... 375ML" with a link ending
 * "hard-rated-orange-passionfruit-zero-sugar-cans-375ml" becomes
 * "Hard Rated Orange Passionfruit Zero Sugar Cans 375ML". Only used when the link clearly
 * matches what the card shows.
 */
export function repairName(name: string, url: string | undefined): string {
  const words = slugWords(url);
  if (!words.length || !name) return name;
  const all = words.join('');
  const tokens = name.split(/\s+/).filter(Boolean);
  const cased = new Map<string, string>();
  for (const t of tokens) cased.set(alnum(t), t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9%)]+$/g, ''));
  const cut = name.match(/^(.*?)\s*(?:\.{3,}|…)\s*(.*)$/);
  if (cut) {
    // Cut short by the shop: rebuild from the link when it holds both visible ends.
    const head = alnum(cut[1]);
    const tail = alnum(cut[2]);
    if (head.length < 4 || !all.startsWith(head) || (tail && !all.includes(tail, head.length))) return name.replace(/\s*(\.{3,}|…)\s*/, '… ');
    const out = words.map((w) => cased.get(w) ?? (UNITS.test(w) || /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)));
    return out.join(' ');
  }
  // Words run together on the card ("OrangePassionfruit", "PackCans"): split them where the link does.
  const fixed = tokens.flatMap((t) => {
    if (!/^[A-Za-z0-9]{6,}$/.test(t) || words.includes(t.toLowerCase())) return [t];
    const k = t.toLowerCase();
    for (let i = 0; i < words.length; i++) {
      let acc = '';
      for (let j = i; j < Math.min(words.length, i + 3); j++) {
        acc += words[j];
        if (acc === k && j > i) {
          const parts: string[] = [];
          let pos = 0;
          for (const w of words.slice(i, j + 1)) {
            parts.push(t.slice(pos, pos + w.length));
            pos += w.length;
          }
          return parts;
        }
        if (!k.startsWith(acc)) break;
      }
    }
    return [t];
  });
  return fixed.join(' ');
}

function product(chain: Chain, p: Partial<StoreProduct> & { name?: string; url?: string; id?: string }): StoreProduct | undefined {
  const name = p.name && repairName(cleanName(p.name), p.url);
  if (!name || name.length < 2 || p.price === undefined) return undefined;
  const id = p.url ?? p.id;
  if (!id) return undefined;
  let price = p.price;
  let was = p.wasPrice && p.wasPrice > price ? p.wasPrice : undefined;
  // More than 75% off is almost always a misread (a "save $83" or "4 payments of" amount taken
  // as the price). Trust the higher number and don't call it a special.
  if (was && price < was * 0.25) {
    price = was;
    was = undefined;
  }
  p = { ...p, price };
  return {
    chain,
    storeProductId: id,
    name,
    brand: p.brand,
    size: p.size ?? sizeIn(name),
    barcode: p.barcode,
    imageUrl: goodImage(p.imageUrl),
    price,
    wasPrice: was,
    isSpecial: !!was || !!p.promo,
    memberOnly: !!p.memberOnly,
    promo: p.promo,
    inStock: p.inStock,
  };
}

/** Drop placeholder images (spacers, "loading" pictures, tiny gifs and svgs). */
function goodImage(url?: string): string | undefined {
  if (
    !url ||
    /^data:|placeholder|no[-_]?image|image[-_]coming|Product-Image-and-Receipt|spacer|blank\.|loading|lazy[-_]?load|1x1|pixel\.gif|\.svg(\?|$)/i.test(
      url,
    )
  )
    return undefined;
  return url;
}

// ---------- schema.org JSON-LD ----------

function ldBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1].trim().replace(/^<!--|-->$/g, '')));
    } catch {
      // a broken block; skip it
    }
  }
  return out;
}

const typeIs = (o: Raw, t: string) => {
  const ty = o['@type'];
  return ty === t || (Array.isArray(ty) && ty.includes(t));
};

function ldAvailability(offer: Raw | undefined): boolean | undefined {
  const a = offer?.availability;
  if (typeof a !== 'string') return undefined;
  if (/InStock|LimitedAvailability|OnlineOnly|InStoreOnly/i.test(a)) return true;
  if (/OutOfStock|SoldOut|Discontinued/i.test(a)) return false;
  return undefined;
}

/** One schema.org Product (or its first offer) as a StoreProduct. */
export function fromLdProduct(chain: Chain, o: Raw, base: string): StoreProduct | undefined {
  const offers = Array.isArray(o.offers) ? (o.offers as Raw[]) : o.offers ? [o.offers as Raw] : [];
  const offer = offers[0] && typeIs(offers[0], 'AggregateOffer') ? offers[0] : (offers.find((x) => priceOf(x.price) !== undefined) ?? offers[0]);
  const price = priceOf(offer?.price) ?? priceOf(offer?.lowPrice) ?? priceOf((offer?.priceSpecification as Raw | undefined)?.price);
  // A crossed-out price, when the page gives one.
  const specs = [offer?.priceSpecification].flat().filter(Boolean) as Raw[];
  const strike = specs.find((s) => typeof s.priceType === 'string' && /Strikethrough|ListPrice|SRP/i.test(s.priceType));
  const brand = typeof o.brand === 'string' ? o.brand : text((o.brand as Raw | undefined)?.name);
  return product(chain, {
    name: text(o.name),
    url: absolute(o.url ?? offer?.url ?? o['@id'], base),
    id: text(o.sku ?? o.productID ?? o.mpn),
    brand,
    barcode: text(o.gtin13 ?? o.gtin ?? o.gtin14 ?? o.gtin12),
    imageUrl: imageOf(o.image, base),
    price,
    wasPrice: priceOf(strike?.price),
    inStock: ldAvailability(offer),
  });
}

/** Every product in the page's JSON-LD: single products, lists of products, and @graph bundles. */
export function fromJsonLd(chain: Chain, html: string, base: string): StoreProduct[] {
  const out: StoreProduct[] = [];
  const visit = (v: unknown, depth: number) => {
    if (!v || depth > 6) return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    if (typeof v !== 'object') return;
    const o = v as Raw;
    if (typeIs(o, 'Product')) {
      const p = fromLdProduct(chain, o, base);
      if (p) out.push(p);
      return;
    }
    if (Array.isArray(o['@graph'])) visit(o['@graph'], depth + 1);
    if (Array.isArray(o.itemListElement)) for (const li of o.itemListElement as Raw[]) visit(li.item ?? li, depth + 1);
    if (o.mainEntity) visit(o.mainEntity, depth + 1);
  };
  for (const b of ldBlocks(html)) visit(b, 0);
  return out;
}

// ---------- data the page's own code starts with ----------

/** JSON the page embeds for its own code: __NEXT_DATA__, application/json scripts, window.__STATE__ = {...}. */
export function embeddedJson(html: string): unknown[] {
  const out: unknown[] = [];
  const scripts = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scripts.exec(html))) {
    const attrs = m[1];
    const body = m[2].trim();
    if (!body || /ld\+json/i.test(attrs)) continue;
    if (/type=["']application\/(json|vnd\.[^"']*json)["']|id=["']__NEXT_DATA__["']/i.test(attrs)) {
      try {
        out.push(JSON.parse(body));
      } catch {
        // not JSON after all
      }
      continue;
    }
    if (/type=["'](?!text\/javascript|module)/i.test(attrs)) continue;
    // window.__INITIAL_STATE__ = {...}; and friends.
    const assign =
      /(?:window\.|self\.|var |let |const )?(__[A-Z0-9_]+__|__[A-Za-z]+State|initialState|INITIAL_STATE|__NUXT__|__APOLLO_STATE__)\s*=\s*/g;
    let a: RegExpExecArray | null;
    while ((a = assign.exec(body))) {
      const start = body.indexOf('{', a.index + a[0].length - 1);
      if (start < 0 || start > a.index + a[0].length + 2) continue;
      const json = balanced(body, start);
      if (!json) continue;
      try {
        out.push(JSON.parse(json));
      } catch {
        // JavaScript, not JSON
      }
    }
  }
  return out;
}

/** The {...} starting at `start`, minding strings. */
function balanced(s: string, start: number): string | undefined {
  let depth = 0;
  let inStr: string | undefined;
  for (let i = start; i < s.length && i - start < 5_000_000; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = undefined;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return undefined;
}

const NAME_KEYS = ['name', 'productName', 'displayName', 'title', 'Name', 'DisplayName', 'ProductName', 'Title'];
const PRICE_KEYS = [
  'price',
  'salePrice',
  'finalPrice',
  'currentPrice',
  'priceNow',
  'nowPrice',
  'Price',
  'SalePrice',
  'sellPrice',
  'priceValue',
  'prices',
  'Prices',
  'pricing',
];
const WAS_KEYS = [
  'wasPrice',
  'regularPrice',
  'originalPrice',
  'listPrice',
  'compareAtPrice',
  'compare_at_price',
  'rrp',
  'RRP',
  'oldPrice',
  'WasPrice',
  'retailPrice',
];
const URL_KEYS = ['url', 'productUrl', 'href', 'link', 'canonicalUrl', 'permalink', 'pdpUrl', 'Url', 'slug', 'urlKey', 'url_key', 'handle'];
const ID_KEYS = ['sku', 'id', 'productId', 'Stockcode', 'stockcode', 'code', 'itemId', 'SKU', 'Id'];
const IMG_KEYS = ['image', 'imageUrl', 'image_url', 'thumbnail', 'images', 'img', 'ImageUrl', 'featured_image', 'media', 'smallImage'];

const first = (o: Raw, keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

/** The current price from a price field that may be a number, a string, or an object of prices. */
function priceFrom(v: unknown): { price?: number; was?: number } {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Raw;
    const now = priceOf(first(o, ['sale', 'now', 'current', 'final', 'promo', 'special', 'value', 'Value', 'amount', 'price', 'regular', 'single']));
    const was = priceOf(first(o, ['was', 'regular', 'original', 'list', 'rrp', 'old', 'before']));
    // Endeavour-style {singleprice: {Value}, promoprice: {Value}}.
    const promo = priceOf((o.promoprice as Raw | undefined)?.Value);
    const single = priceOf((o.singleprice as Raw | undefined)?.Value);
    if (promo !== undefined || single !== undefined)
      return { price: promo ?? single, was: promo !== undefined && single !== undefined ? single : undefined };
    return { price: now, was: was !== now ? was : undefined };
  }
  return { price: priceOf(v) };
}

/** Product-looking objects anywhere in embedded data: they have a name and a price, and a link or id. */
export function fromEmbedded(chain: Chain, data: unknown[], base: string, limit = 60): StoreProduct[] {
  const out: StoreProduct[] = [];
  const seen = new Set<string>();
  let visited = 0;
  const visit = (v: unknown, depth: number) => {
    if (!v || depth > 14 || out.length >= limit || ++visited > 200_000) return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    if (typeof v !== 'object') return;
    const o = v as Raw;
    const name = text(first(o, NAME_KEYS));
    const rawPrice = first(o, PRICE_KEYS);
    if (name && rawPrice !== undefined && !Array.isArray(rawPrice)) {
      const { price, was } = priceFrom(rawPrice);
      const urlish = first(o, URL_KEYS);
      let url =
        typeof urlish === 'string' ? absolute(urlish.includes('/') || urlish.startsWith('http') ? urlish : `/products/${urlish}`, base) : undefined;
      if (url && !url.startsWith(new URL(base).origin)) url = undefined;
      const id = text(first(o, ID_KEYS));
      if (price !== undefined && (url || id)) {
        const p = product(chain, {
          name,
          url,
          id: id ? `${new URL(base).origin}#${id}` : undefined,
          brand: text(typeof o.brand === 'object' ? (o.brand as Raw)?.name : o.brand),
          imageUrl: imageOf(first(o, IMG_KEYS), base),
          price,
          wasPrice: priceOf(first(o, WAS_KEYS)) ?? was,
          barcode: text(o.gtin ?? o.gtin13 ?? o.barcode ?? o.ean),
          size: text(o.size ?? o.packageSize ?? o.PackageSize ?? o.volume),
          inStock:
            typeof o.inStock === 'boolean'
              ? o.inStock
              : typeof o.available === 'boolean'
                ? o.available
                : typeof o.is_in_stock === 'boolean'
                  ? o.is_in_stock
                  : undefined,
        });
        if (p && !seen.has(p.storeProductId)) {
          seen.add(p.storeProductId);
          out.push(p);
        }
        return;
      }
    }
    for (const k of Object.keys(o)) visit(o[k], depth + 1);
  };
  data.forEach((d) => visit(d, 0));
  return out;
}

// ---------- product cards on the page ----------

const MONEY = /\$\s?(\d{1,5}(?:,\d{3})*(?:\.\d{2})?)/;
const MONEY_ALL = /\$\s?(\d{1,5}(?:,\d{3})*(?:\.\d{2})?)/g;

/** A short CSS-ish signature, so repeated cards (same tag and classes) can be grouped. */
function signature(el: Element): string {
  return `${el.tagName}.${(el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).sort().join('.')}`;
}

/**
 * Product cards: repeated blocks that each hold a link, a name and a $ price. Finds the most
 * repeated card shape on the page and reads each one.
 */
export function fromCards(chain: Chain, html: string, base: string, parse: ParseHtml = defaultParse, limit = 48): StoreProduct[] {
  let doc: Document;
  try {
    doc = parse(html);
  } catch {
    return [];
  }
  // Lazy-loading pages often keep the real picture inside <noscript>; turn it back into an <img>.
  doc.querySelectorAll('noscript').forEach((n) => {
    const src = (n.innerHTML || n.textContent || '').match(/<img[^>]+?\bsrc=["']([^"']+)["']/i)?.[1];
    if (src && n.parentElement) {
      const img = doc.createElement('img');
      img.setAttribute('src', decode(src));
      n.parentElement.replaceChild(img, n);
    }
  });
  doc.querySelectorAll('script,style,noscript,svg,header,footer,nav').forEach((e) => e.remove());
  // Elements whose own text holds a price.
  const priceEls: Element[] = [];
  doc.querySelectorAll('body *').forEach((el) => {
    if (el.children.length > 3) return;
    const t = el.textContent ?? '';
    if (t.length < 40 && MONEY.test(t)) priceEls.push(el);
  });
  // Climb from each price to the smallest block that also has a product link.
  const groups = new Map<string, Element[]>();
  for (const pe of priceEls) {
    let el: Element | null = pe;
    for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
      const links = el.querySelectorAll('a[href]');
      if (!links.length) continue;
      const prices = (el.textContent ?? '').match(MONEY_ALL) ?? [];
      if (prices.length > 4) break; // grown past one card
      const sig = signature(el);
      const list = groups.get(sig) ?? [];
      if (!list.includes(el)) list.push(el);
      groups.set(sig, list);
      break;
    }
  }
  const best = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length)[0] ?? [...groups.values()][0];
  if (!best) return [];
  const out: StoreProduct[] = [];
  const seen = new Set<string>();
  for (const card of best.slice(0, limit)) {
    const link = [...card.querySelectorAll('a[href]')].find((a) => (a.textContent ?? '').trim().length > 3) ?? card.querySelector('a[href]');
    const url = absolute(link?.getAttribute('href'), base);
    const heading = card.querySelector('h1,h2,h3,h4,h5,[class*="name" i],[class*="title" i],[itemprop="name"]');
    const img = cardPicture(card);
    const name = bestName([
      text(spaced(heading)),
      text(link?.getAttribute('title')),
      text(link?.getAttribute('aria-label')),
      text(img?.getAttribute('alt')),
      text(spaced(link)),
    ]);
    const { price, was } = cardPrice(card);
    const sold = /out of stock|sold out|unavailable/i.test(card.textContent ?? '');
    const p = product(chain, {
      name,
      url,
      price,
      wasPrice: was,
      imageUrl: unwrapImage(absolute(cardImage(img) ?? backgroundImage(card), base)),
      inStock: sold ? false : undefined,
    });
    if (p && !seen.has(p.storeProductId)) {
      seen.add(p.storeProductId);
      out.push(p);
    }
  }
  return out;
}

/**
 * The fullest name on offer: sites often cut the heading short ("TerryWhite Chemmart ...ears")
 * but keep the whole name in the image's alt text or the link's title.
 */
function bestName(candidates: (string | undefined)[]): string | undefined {
  const ok = candidates.filter((c): c is string => !!c && c.length >= 3 && !/^(image|product|photo|view|add|buy)$/i.test(c));
  const whole = ok.filter((c) => !/\.{3}|…/.test(c) && c.length <= 160);
  const pick = (list: string[]) => list.sort((a, b) => b.length - a.length)[0];
  // Prefer a whole name; among those the longest that isn't a paragraph.
  return pick(whole.filter((c) => c.length <= 120)) ?? pick(whole) ?? ok[0];
}

/** An element's text with a space wherever one element ends and the next begins ("Orange<br>Passionfruit"). */
function spaced(el: Element | null | undefined): string | undefined {
  if (!el) return undefined;
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === 3) out += n.nodeValue ?? '';
    else if (n.nodeType === 1) {
      out += ' ';
      n.childNodes.forEach(walk);
      out += ' ';
    }
  };
  el.childNodes.forEach(walk);
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s+(['’](s|t|re|ll|d)\b|[,.;:!?)%])/gi, '$1')
    .replace(/\(\s+/g, '(')
    .trim();
}

/** A picture set as a CSS background, or on a <picture>'s source. */
function backgroundImage(card: Element): string | undefined {
  const source = card.querySelector('picture source[srcset], source[data-srcset]');
  const set = source?.getAttribute('srcset') ?? source?.getAttribute('data-srcset');
  const fromSet = set
    ?.split(',')
    .map((x) => x.trim().split(/\s+/)[0])
    .filter(Boolean)
    .pop();
  if (goodImage(fromSet)) return fromSet;
  for (const el of [card, ...card.querySelectorAll('[style*="background"],[data-bg],[data-background-image]')]) {
    const v =
      el.getAttribute('data-bg') ?? el.getAttribute('data-background-image') ?? el.getAttribute('style')?.match(/url\(\s*['"]?([^'")]+)/i)?.[1];
    if (goodImage(v)) return v;
  }
  return undefined;
}

/**
 * The card's picture. Some sites put the picture beside the name-and-price block rather than in
 * it, so look one or two levels up as long as that still holds just this one product.
 */
function cardPicture(card: Element): Element | null {
  const find = (el: Element) => [...el.querySelectorAll('img')].find((i) => goodImage(cardImage(i)));
  const own = find(card);
  if (own) return own;
  const prices = ((card.textContent ?? '').match(MONEY_ALL) ?? []).length;
  let el = card.parentElement;
  for (let i = 0; i < 3 && el; i++, el = el.parentElement) {
    if (((el.textContent ?? '').match(MONEY_ALL) ?? []).length > prices) break;
    const hit = find(el);
    if (hit) return hit;
  }
  return card.querySelector('img');
}

/**
 * The real picture behind an image resizer (Next.js "/_next/image?url=")
 * so photos load straight from the shop's own picture at full size.
 */
export function unwrapImage(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (/\/_next\/image\/?$|\/_vercel\/image\/?$/.test(u.pathname)) {
      const inner = u.searchParams.get('url');
      if (inner) return absolute(inner, u.origin) ?? url;
    }
    return url;
  } catch {
    return url;
  }
}

/** The image a card shows, including lazy-loaded ones. */
function cardImage(img: Element | null): string | undefined {
  if (!img) return undefined;
  const real = (v: string | null | undefined) => (v && !v.startsWith('data:') ? v : undefined);
  const fromSet = (v: string | null | undefined) =>
    real(
      v
        ?.split(',')
        .map((x) => x.trim().split(/\s+/)[0])
        .filter(Boolean)
        .pop(),
    );
  return (
    real(img.getAttribute('data-src')) ??
    real(img.getAttribute('data-lazy')) ??
    real(img.getAttribute('data-image')) ??
    real(img.getAttribute('data-zoom-image')) ??
    fromSet(img.getAttribute('data-lazy-srcset')) ??
    real(img.getAttribute('data-lazy-src')) ??
    real(img.getAttribute('data-original')) ??
    fromSet(img.getAttribute('data-srcset')) ??
    real(img.getAttribute('src')) ??
    fromSet(img.getAttribute('srcset'))
  );
}

/**
 * Today's price and the "was" price on a card. Skips amounts that aren't the shelf price:
 * savings ("Save $8"), unit prices ("$2.31 / L", "$0.16 per 100ml"), instalments ("4 payments
 * of $3.75"), and points or cashback.
 */
export function cardPrice(card: Element): { price?: number; was?: number } {
  const t = (card.textContent ?? '').replace(/\s+/g, ' ');
  const struckEl = card.querySelector(
    's,del,strike,[class*="was" i],[class*="old" i],[class*="strike" i],[class*="rrp" i],[class*="compare" i],[class*="regular" i]',
  );
  const struck = struckEl?.textContent?.match(MONEY)?.[1];
  let was = struck ? parseFloat(struck.replace(/,/g, '')) : undefined;
  const found: number[] = [];
  for (const m of t.matchAll(MONEY_ALL)) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    const before = t.slice(Math.max(0, m.index! - 24), m.index!).toLowerCase();
    const after = t.slice(m.index! + m[0].length, m.index! + m[0].length + 14).toLowerCase();
    if (/(was|rrp|reg\.?|regular|normally|compare at)\s*:?\s*$/.test(before)) {
      was ??= v;
      continue;
    }
    if (/(save|saving|off|earn|points|cashback|back|payments? of|instalments? of|x|from|up to|over|spend|delivery)\s*:?\s*$/.test(before)) continue;
    if (/^\s*(\/|per\b|off\b|each\s*\/|back\b|cashback)/.test(after)) continue;
    if (v === was || v <= 0) continue;
    found.push(v);
  }
  // A price label on the card (not the crossed-out one) wins; otherwise the first shelf price.
  const priceEl = [...card.querySelectorAll('[class*="price" i],[itemprop="price"]')].find(
    (e) =>
      !e.closest('s,del,strike,[class*="was" i],[class*="old" i],[class*="rrp" i],[class*="save" i],[class*="unit" i],[class*="cup" i]') &&
      MONEY.test(e.textContent ?? ''),
  );
  const labelled = priceEl?.getAttribute('content') ?? priceEl?.textContent?.match(MONEY)?.[1];
  const fromLabel = labelled ? parseFloat(labelled.replace(/,/g, '')) : undefined;
  const price = fromLabel !== undefined && fromLabel > 0 && fromLabel !== was ? fromLabel : found[0];
  return { price, was: was && price && was > price ? was : undefined };
}

/** Everything the page offers, best source first: JSON-LD, then embedded data, then cards. */
export function extractProducts(chain: Chain, html: string, base: string, parse: ParseHtml = defaultParse): StoreProduct[] {
  const ld = fromJsonLd(chain, html, base);
  if (ld.length >= 2) return ld;
  const embedded = fromEmbedded(chain, embeddedJson(html), base);
  if (embedded.length >= 2) return embedded;
  const cards = fromCards(chain, html, base, parse);
  const all = [ld, embedded, cards].sort((a, b) => b.length - a.length)[0];
  return all;
}

// ---------- finding a shop's search page ----------

export type Platform = 'shopify' | 'woocommerce' | 'magento' | 'other';

export interface SearchInfo {
  /** The search page, with {q} where the words go. */
  search?: string;
  platform: Platform;
  /** How the search page was found, for Test connections. */
  how: string;
}

export function platformOf(html: string): Platform {
  if (/cdn\.shopify\.com|Shopify\.theme|shopify-section/i.test(html)) return 'shopify';
  if (/woocommerce|wp-content\/plugins\/woo/i.test(html)) return 'woocommerce';
  if (/Magento_|mage\/cookies|data-mage-init|static\/version\d+\/frontend/i.test(html)) return 'magento';
  return 'other';
}

/** Common search pages, tried in order when a site doesn't say. */
export const SEARCH_GUESSES: Record<Platform, string[]> = {
  shopify: ['/search?q={q}&type=product'],
  woocommerce: ['/?s={q}&post_type=product'],
  magento: ['/catalogsearch/result/?q={q}'],
  other: ['/search?q={q}', '/search?query={q}', '/search?searchTerm={q}', '/search?text={q}', '/catalogsearch/result/?q={q}', '/?s={q}'],
};

/** Work out where a shop's search page is from its homepage. */
export function findSearch(html: string, base: string, parse: ParseHtml = defaultParse): SearchInfo {
  const platform = platformOf(html);
  // 1. schema.org SearchAction, which sites add so search engines can search them.
  for (const b of ldBlocks(html)) {
    const found = searchAction(b);
    if (found) {
      const t = found.replace(/\{\s*search_term(_string)?\s*\}|\{\s*query\s*\}|\{\s*q\s*\}/i, '{q}');
      const url = absolute(t, base);
      if (url && url.includes('%7Bq%7D'))
        return { search: url.replace('%7Bq%7D', '{q}'), platform, how: 'the site’s search link for search engines' };
      if (url && url.includes('{q}')) return { search: url, platform, how: 'the site’s search link for search engines' };
    }
  }
  // 2. The search box on the page.
  try {
    const doc = parse(html);
    // Prefer a box that searches products over one for services, stores, articles or recipes.
    const forms = [...doc.querySelectorAll('form')];
    const rank = (f: Element) => {
      const a = (f.getAttribute('action') ?? '').toLowerCase();
      return /product|shop|catalog/.test(a) ? 0 : /service|store-?locat|stores|blog|article|recipe|help|faq/.test(a) ? 2 : 1;
    };
    forms.sort((a, b) => rank(a) - rank(b));
    for (const form of forms) {
      const input = form.querySelector(
        'input[type="search"], input[name="q"], input[name="s"], input[name="query"], input[name="search"], input[name="searchTerm"], input[name="searchtext"], input[name="text"], input[name="keyword"], input[name="keywords"], input[name="term"]',
      );
      const nameAttr = input?.getAttribute('name');
      if (!input || !nameAttr) continue;
      if ((form.getAttribute('method') ?? 'get').toLowerCase() === 'post') continue;
      const action = absolute(form.getAttribute('action') || base, base);
      if (!action) continue;
      const u = new URL(action);
      form.querySelectorAll('input[type="hidden"][name]').forEach((h) => u.searchParams.set(h.getAttribute('name')!, h.getAttribute('value') ?? ''));
      u.searchParams.set(nameAttr, 'QQQ');
      return { search: u.toString().replace('QQQ', '{q}'), platform, how: 'the search box on the site' };
    }
  } catch {
    // no DOM to look at
  }
  // 3. The usual place for this kind of site.
  return { search: new URL(SEARCH_GUESSES[platform][0], base).toString(), platform, how: 'the usual search page for this kind of site' };
}

function searchAction(v: unknown, depth = 0): string | undefined {
  if (!v || typeof v !== 'object' || depth > 5) return undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = searchAction(x, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  const o = v as Raw;
  if (typeIs(o, 'SearchAction')) {
    const t = o.target;
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return (t.find((x) => typeof x === 'string') as string) ?? text((t[0] as Raw)?.urlTemplate);
    if (t && typeof t === 'object') return text((t as Raw).urlTemplate);
  }
  for (const k of ['potentialAction', '@graph']) {
    const r = searchAction(o[k], depth + 1);
    if (r) return r;
  }
  return undefined;
}

export const searchUrl = (template: string, term: string) => template.replace('{q}', encodeURIComponent(term));

// ---------- shop platforms with their own data ----------

/** Shopify's predictive search JSON (/search/suggest.json). */
export function fromShopifySuggest(chain: Chain, data: unknown, base: string): StoreProduct[] {
  const list = (((data as Raw)?.resources as Raw)?.results as Raw)?.products;
  if (!Array.isArray(list)) return [];
  return (list as Raw[])
    .map((p) =>
      product(chain, {
        name: text(p.title),
        url: absolute(typeof p.url === 'string' ? p.url.split('?')[0] : undefined, base),
        brand: text(p.vendor),
        imageUrl: imageOf(p.image ?? (p.featured_image as Raw | undefined)?.url, base),
        price: priceOf(p.price),
        wasPrice: priceOf(p.compare_at_price_max ?? p.compare_at_price_min),
        inStock: typeof p.available === 'boolean' ? p.available : undefined,
      }),
    )
    .filter((x): x is StoreProduct => !!x);
}

/** WooCommerce's Store API (/wp-json/wc/store/v1/products). Prices come in cents as strings. */
export function fromWooStore(chain: Chain, data: unknown, base: string): StoreProduct[] {
  if (!Array.isArray(data)) return [];
  return (data as Raw[])
    .map((p) => {
      const pr = (p.prices ?? {}) as Raw;
      const unit = Math.pow(10, Number(pr.currency_minor_unit ?? 2));
      const cents = (v: unknown) => (num(v) !== undefined ? num(v)! / unit : undefined);
      const sale = cents(pr.sale_price);
      const regular = cents(pr.regular_price);
      return product(chain, {
        name: text(p.name),
        url: absolute(p.permalink, base),
        imageUrl: imageOf(p.images, base),
        price: cents(pr.price) ?? sale,
        wasPrice: sale !== undefined && regular !== undefined && regular > sale ? regular : undefined,
        barcode: text(p.sku),
        inStock: typeof p.is_in_stock === 'boolean' ? p.is_in_stock : undefined,
      });
    })
    .filter((x): x is StoreProduct => !!x);
}
