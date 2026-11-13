import { capture } from '../lib/diagnostics';
import { sameSite } from '../lib/site';
import { getKV, putKV } from '../lib/db';
import { RestockNative } from '../lib/sql/native';
import { chainName, customShop, shopDef, websiteOf, type StoreChain } from '../shops';
import { BlockedError, isNative, NativeOnlyError, parseJson, request } from './http';
import type { StoreAdapter, StoreProduct } from './types';
import { extractProducts, findSearch, fromShopifySuggest, fromWooStore, searchUrl, SEARCH_GUESSES, type SearchInfo } from './webPage';

// Any shop website: find its search page, then read the products on it. Used for every bottle
// shop and pharmacy without a dedicated connection, and for shops people add themselves.
// Tries a plain request first; if the site blocks it or builds its page with scripts, the same
// page is opened in the hidden browser and read once it has finished drawing.

interface Cached extends SearchInfo {
  at: string;
}

// "2": 0.7.6 added known search pages for most pharmacies, so older remembered guesses are dropped.
// "3": 0.8.5 fixed Priceline's (its old address now shows "No results"), so those are dropped too.
const KV = (c: StoreChain) => `webShop3:${c}`;
const DAY = 86_400_000;
/** How long a search page Restock worked out is remembered before it looks again. */
const REMEMBER_FOR = 14 * DAY;

/** Where this shop's search page is: typed in by the person, known, remembered, or worked out from its homepage. */
export async function searchInfo(chain: StoreChain, fresh = false, ignoreKnown = false): Promise<SearchInfo> {
  const typed = customShop(chain)?.search;
  if (typed && typed.includes('{q}')) return { search: typed, platform: 'other', how: 'the search address you typed in' };
  const known = ignoreKnown ? undefined : shopDef(chain)?.search;
  const cached = fresh || ignoreKnown ? undefined : await getKV<Cached>(KV(chain)).catch(() => undefined);
  const site = websiteOf(chain);
  // 0.9.0: never a time in the future (which would keep it forever),
  // and only a search page on the shop's own site (one could come back in an old backup).
  const age = cached?.at ? Date.now() - Date.parse(cached.at) : NaN;
  if (cached?.search && age >= 0 && age < REMEMBER_FOR && (known ? cached.search === known : sameSite(cached.search, site))) return cached;
  if (!site) throw new Error(`${chainName(chain)} has no website set.`);
  let html = '';
  try {
    html = (await request({ url: site, headers: { Accept: 'text/html' } })).text;
    if (html.trim().startsWith('{') || html.length < 500) html = '';
  } catch (e) {
    if (e instanceof NativeOnlyError) throw e;
  }
  if ((!html || looksLikeBotCheck(html)) && isNative()) html = (await render(chain, site).catch(() => ({ html: '' }))).html;
  // 0.10.4: a "checking your browser" page has no search box to find. Guess, and don't remember
  // the guess, so the real page is looked at again once the shop is unblocked.
  const checked = !!html && looksLikeBotCheck(html);
  if (checked) html = '';
  const found = html
    ? findSearch(html, site)
    : { search: new URL(SEARCH_GUESSES.other[0], site).toString(), platform: 'other' as const, how: 'a guess' };
  const info: SearchInfo = known ? { ...found, search: known, how: 'Restock’s saved address for this shop' } : found;
  if (!ignoreKnown && !checked) await putKV(KV(chain), { ...info, at: new Date().toISOString() } satisfies Cached).catch(() => undefined);
  return info;
}

/** Forget the remembered search page (after changing a shop's website, or when it stops working). */
export const forgetSearchInfo = (chain: StoreChain) => putKV(KV(chain), null);

/** Open a page in the hidden browser, let its scripts draw it, and hand back the finished page. */
export async function render(chain: StoreChain, url: string): Promise<{ status: number; html: string; url: string }> {
  if (!isNative()) throw new NativeOnlyError();
  const r = await RestockNative.storeRender({ chain, url, home: websiteOf(chain) });
  capture('browser page', r.url ?? url, r.status, r.html ?? '');
  return { status: r.status, html: r.html ?? '', url: r.url ?? url };
}

async function platformSearch(chain: StoreChain, info: SearchInfo, term: string): Promise<StoreProduct[]> {
  const site = websiteOf(chain)!;
  const origin = new URL(info.search ?? site).origin;
  if (info.platform === 'shopify') {
    const res = await request({
      url: `${origin}/search/suggest.json?q=${encodeURIComponent(term)}&resources[type]=product&resources[limit]=10`,
      headers: { Accept: 'application/json' },
    });
    return fromShopifySuggest(chain, parseJson(chainName(chain), res), origin);
  }
  if (info.platform === 'woocommerce') {
    const res = await request({
      url: `${origin}/wp-json/wc/store/v1/products?search=${encodeURIComponent(term)}&per_page=24`,
      headers: { Accept: 'application/json' },
    });
    return fromWooStore(chain, parseJson(chainName(chain), res), origin);
  }
  return [];
}

/** The holding page a bot-protection service shows instead of the shop. */
export function looksLikeBotCheck(html: string | undefined): boolean {
  if (!html) return true;
  const head = html.slice(0, 20000).toLowerCase();
  return (
    /just a moment|checking your browser|verify you are human|are you a robot|pardon our interruption|request unsuccessful|access denied/.test(
      head,
    ) || /cf-chl|challenge-platform|_incapsula_|px-captcha|captcha-delivery/.test(head)
  );
}

/** Search a shop's website. */
export async function searchWeb(chain: StoreChain, term: string): Promise<StoreProduct[]> {
  if (!isNative()) throw new NativeOnlyError();
  const name = chainName(chain);
  let info = await searchInfo(chain);
  // Shops on Shopify or WooCommerce answer searches with data directly.
  if (info.platform === 'shopify' || info.platform === 'woocommerce') {
    try {
      const out = await platformSearch(chain, info, term);
      if (out.length) return out;
    } catch {
      // fall through to the search page
    }
  }
  const attempt = async (template: string): Promise<{ items: StoreProduct[]; blocked: boolean }> => {
    const url = searchUrl(template, term);
    let blocked = false;
    try {
      const res = await request({ url, headers: { Accept: 'text/html,application/xhtml+xml' } });
      blocked = res.status === 403 || res.status === 429 || res.status === 503;
      if (res.status < 400) {
        const items = extractProducts(chain, res.text, url);
        if (items.length) return { items, blocked };
      }
    } catch (e) {
      if (e instanceof NativeOnlyError) throw e;
      blocked = true;
    }
    // Blocked, or a page that draws its products with scripts: open it in the hidden browser.
    const r = await render(chain, url);
    // What the hidden browser saw decides it: a page that loaded properly isn't "blocked", it
    // just had nothing we could read.
    blocked = (r.status >= 400 && r.status !== 404) || looksLikeBotCheck(r.html);
    return { items: extractProducts(chain, r.html, r.url), blocked };
  };
  let out = await attempt(info.search!);
  if (!out.items.length && !customShop(chain)?.search) {
    // Nothing on that page: look for the search box on the homepage again, then try the usual
    // search pages. Slower, but better than no results. A blocked site stops here.
    const tried = new Set([info.search]);
    const again = await searchInfo(chain, true, true).catch(() => undefined);
    const site = websiteOf(chain)!;
    const more = [again?.search, ...SEARCH_GUESSES.other.slice(0, 3).map((g) => new URL(g, site).toString())].filter(
      (u): u is string => !!u && !tried.has(u),
    );
    for (const next of more.slice(0, 2)) {
      if (out.blocked) break;
      tried.add(next);
      const got = await attempt(next);
      out = { items: got.items, blocked: got.blocked };
      if (got.items.length) {
        // Remember the page that worked.
        await putKV(KV(chain), { search: next, platform: info.platform, how: 'a search page that worked', at: new Date().toISOString() }).catch(
          () => undefined,
        );
        break;
      }
    }
  }
  if (!out.items.length && out.blocked) throw new BlockedError(name);
  return out.items;
}

export function webAdapter(chain: StoreChain): StoreAdapter {
  return { chain, search: (term) => searchWeb(chain, term) };
}
