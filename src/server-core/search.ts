// 0.9.5: "Let the web page search the shops" (a Restock server setting, off unless someone turns it
// on). When a signed-in browser presses Search, the server runs the same search a phone runs: the
// same shop connections (src/stores/*), the same clean-up of what was typed (normaliseQuery), the
// same ranking (scoreAll and topPicks, as Add.tsx), at the household's shops for that tab, at the
// household's Coles branch. Through src/stores/node.ts: only the shops' own hosts, 10 seconds a
// shop, 3 MB an answer, no redirects to other sites, cookies for one search only, never a sign-in.
//
// What the phone does that the server can't: the hidden browser (Coles, Aldi, Dan Murphy's and BWS
// use it when a shop's bot check turns a direct request away). A shop that turns the server away
// comes back as { status: 'blocked' } with "Search it on a phone instead."
//
// Nothing here runs unless the server calls searchShops: no timer, no background fetching.

import { aldi } from '../stores/aldi';
import { coles } from '../stores/coles';
import { endeavourAdapter } from '../stores/endeavour';
import { BlockedError, NativeOnlyError, request } from '../stores/http';
import { NODE_DEFAULTS, runSearch, runShop, ShopRefusedError, ShopTimeoutError, ShopTooBigError, useNodeTransport, type NodeConfig } from '../stores/node';
import type { StoreProduct } from '../stores/types';
import { looksLikeBotCheck } from '../stores/web';
import { extractProducts, searchUrl } from '../stores/webPage';
import { woolworths } from '../stores/woolworths';
import { normaliseQuery, sameCode, scoreAll, topPicks, unitTextOf } from '../lib/searchHelp';
import { genericName } from '../lib/naming';
import { checkBranch, DEFAULTS } from '../lib/sharedSettings';
import { chainName, isCustom, kindOf, searchChainsIn, sectionOn, setCustomShops, shopDef, type Section, type StoreChain } from '../shops';

export const SEARCH_LIMITS = {
  /** Characters in what's typed. */
  maxQuery: 100,
  /** Results kept per shop (a phone's first page is about 24–36). */
  maxItems: 40,
  ...NODE_DEFAULTS,
} as const;

export { genericName };

/** Sets how the server asks the shops (its fetch, for tests; the limits). Call once at start. */
export function configureShopSearch(c: Partial<NodeConfig> = {}) {
  useNodeTransport(c);
}

/** One shop to search, at a branch (Coles: the household's branch store number). */
export interface ShopAsk {
  chain: StoreChain;
  storeId?: string;
}

/** A found product: the phone's StoreProduct, plus its unit price as the phone shows it. */
export interface FoundProduct extends StoreProduct {
  /** "$1.25 / 100g", worked out the phone's way (unitTextOf). */
  unitText?: string;
  /** Exactly half the usual price. */
  halfPrice?: boolean;
}

export type ShopAnswer =
  | { chain: StoreChain; name: string; status: 'ok'; items: FoundProduct[]; top: string[]; message?: string }
  | { chain: StoreChain; name: string; status: 'blocked'; blocked: true; message: string }
  | { chain: StoreChain; name: string; status: 'error' | 'skipped'; message: string };

export const blockedMessage = (name: string) => `${name} blocked the search from your server. Search it on a phone instead.`;

/** How the server can search a shop: with its own connection, its known search page, or not at all. */
export function searchHow(chain: string): 'direct' | 'page' | 'phone' | 'custom' {
  if (isCustom(chain)) return 'custom';
  const k = kindOf(chain);
  if (k === 'woolworths' || k === 'coles' || k === 'aldi' || k === 'endeavour') return 'direct';
  if (k === 'web' && shopDef(chain)?.search) return 'page';
  return 'phone';
}

/**
 * The shops a search asks: the household's shops on that tab (one per website, as the phone), with
 * the Coles branch from the household's branch:coles row. `only`: just that one (it must be one of them).
 * `settings` is the server's copy of the household's settings (kv 'settings', household rows applied).
 */
export function searchPlan(
  settings: unknown,
  section: Section,
  branchRows: { k: string; v: string }[],
  only?: string,
): { asks: ShopAsk[]; error?: 'tab' | 'shop' } {
  const s = (settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}) as Record<string, unknown>;
  setCustomShops(Array.isArray(s.customShops) ? (s.customShops as never) : []);
  const enabledChains = Array.isArray(s.enabledChains) ? (s.enabledChains as unknown[]).filter((c): c is string => typeof c === 'string') : [...DEFAULTS.enabledChains];
  const sections = (s.sections && typeof s.sections === 'object' ? s.sections : {}) as Partial<Record<Section, boolean>>;
  if (!sectionOn({ sections, enabledChains }, section)) return { asks: [], error: 'tab' };
  let chains = searchChainsIn(enabledChains, section);
  if (only !== undefined) {
    if (!chains.includes(only as StoreChain)) return { asks: [], error: 'shop' };
    chains = [only as StoreChain];
  }
  const branch = new Map<string, { name: string; storeNo?: string }>();
  for (const r of branchRows) {
    let v: unknown;
    try {
      v = JSON.parse(r.v);
    } catch {
      continue;
    }
    const b = checkBranch(r.k, v);
    if (b) branch.set(r.k.slice('branch:'.length), b);
  }
  return { asks: chains.map((chain) => (chain === 'coles' && branch.get('coles')?.storeNo ? { chain, storeId: branch.get('coles')!.storeNo } : { chain })) };
}

const keyOf = (p: StoreProduct) => `${p.chain}:${p.storeProductId}`;
const clip = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100_000 ? Math.round(v * 100) / 100 : undefined);

/** A product as the server hands it to the web: the phone's fields, tidied (an https picture only). */
export function foundOf(p: StoreProduct): FoundProduct {
  const price = money(p.price);
  const was = money(p.wasPrice);
  const img = clip(p.imageUrl, 500);
  return {
    chain: p.chain,
    storeProductId: String(p.storeProductId).slice(0, 80),
    name: clip(p.name, 200) ?? 'Unknown product',
    brand: clip(p.brand, 80),
    size: clip(p.size, 60),
    barcode: typeof p.barcode === 'string' && /^\d{6,14}$/.test(p.barcode) ? p.barcode : undefined,
    imageUrl: img && /^https:\/\/[^\s"'<>]+$/i.test(img) ? img : undefined,
    price,
    wasPrice: was && price && was > price ? was : undefined,
    isSpecial: !!p.isSpecial,
    halfPrice: !!(was && price && Math.abs(price * 2 - was) < 0.005) || undefined,
    memberOnly: !!p.memberOnly,
    promo: clip(p.promo, 120),
    unitPriceText: clip(p.unitPriceText, 60),
    unitText: clip(unitTextOf(p), 60),
    inStock: typeof p.inStock === 'boolean' ? p.inStock : undefined,
  };
}

/** A web shop with a known search page: the page, read for the products it carries as data. */
async function pageSearch(chain: StoreChain, term: string): Promise<StoreProduct[]> {
  const def = shopDef(chain)!;
  const url = searchUrl(def.search!, term);
  const res = await request({ url, headers: { Accept: 'text/html,application/xhtml+xml' } });
  if (res.status === 403 || res.status === 429 || res.status === 503) throw new BlockedError(def.name);
  if (res.status >= 400) throw new Error(`${def.name} returned HTTP ${res.status}`);
  if (looksLikeBotCheck(res.text)) throw new BlockedError(def.name);
  // No page drawing on the server: only the products a page carries as data (JSON-LD, its own JSON).
  return extractProducts(chain, res.text, url, () => {
    throw new Error('no DOM on the server');
  });
}

function searchOne(chain: StoreChain, term: string, storeId?: string): Promise<StoreProduct[]> {
  switch (kindOf(chain)) {
    case 'woolworths':
      return woolworths.search(term);
    case 'coles':
      return coles.search(term, storeId);
    case 'aldi':
      return aldi.search(term);
    case 'endeavour':
      return endeavourAdapter(chain as 'danmurphys' | 'bws').search(term);
    default:
      return pageSearch(chain, term);
  }
}

function answerOfError(chain: StoreChain, name: string, e: unknown): ShopAnswer {
  if (e instanceof BlockedError || e instanceof NativeOnlyError) return { chain, name, status: 'blocked', blocked: true, message: blockedMessage(name) };
  if (e instanceof ShopTimeoutError) return { chain, name, status: 'error', message: `${name} took too long to answer. Try again, or search it on a phone.` };
  if (e instanceof ShopTooBigError || e instanceof ShopRefusedError) return { chain, name, status: 'error', message: `${e.message} Search it on a phone instead.` };
  return { chain, name, status: 'error', message: `Couldn't search ${name} from the server just now. Try again, or search it on a phone.` };
}

/**
 * Searches each shop at once (each within its own time) and ranks what each found the phone's way.
 * One search at a time on the server; each shop's errors stay that shop's answer, never thrown.
 */
export async function searchShops(o: { q: string; barcode?: string; asks: ShopAsk[]; config?: Partial<NodeConfig> }): Promise<{ text: string; shops: ShopAnswer[] }> {
  const text = normaliseQuery(String(o.q ?? '').slice(0, SEARCH_LIMITS.maxQuery));
  const barcode = o.barcode && /^\d{8,14}$/.test(o.barcode) ? o.barcode : undefined;
  const rq = { text, barcode };
  return runSearch(async () => {
    const shops = await Promise.all(
      o.asks.map(async ({ chain, storeId }): Promise<ShopAnswer> => {
        const name = chainName(chain);
        const how = searchHow(chain);
        if (how === 'custom') return { chain, name, status: 'skipped', message: `The server doesn't search shops you added. Search ${name} on a phone instead.` };
        if (how === 'phone') return { chain, name, status: 'skipped', message: `The server can't search ${name}. Search it on a phone instead.` };
        if (!text) return { chain, name, status: 'ok', items: [], top: [] };
        try {
          return await runShop(chain, name, async () => {
            // A scan at Woolworths or Coles: also the barcode itself, which finds the exact product
            // even when the name search doesn't bring it up (as Add.tsx).
            const byCode =
              barcode && (chain === 'woolworths' || chain === 'coles') && barcode !== text
                ? searchOne(chain, barcode, storeId).catch(() => [] as StoreProduct[])
                : Promise.resolve([] as StoreProduct[]);
            const [found, coded] = await Promise.all([searchOne(chain, text, storeId), byCode]);
            const exact = coded.filter((p) => sameCode(p.barcode, barcode));
            const seen = new Set(exact.map(keyOf));
            const items = [...exact, ...found.filter((p) => !seen.has(keyOf(p)))].filter((p) => p && p.storeProductId !== undefined && p.storeProductId !== '');
            const scored = scoreAll(rq, items).slice(0, SEARCH_LIMITS.maxItems);
            const out: ShopAnswer = {
              chain,
              name,
              status: 'ok',
              items: scored.map((x) => foundOf(x.sp)),
              top: topPicks(scored).map((p) => String(p.storeProductId)),
            };
            if (!items.length && how === 'page') out.message = `Nothing found on ${name}'s page from the server. It may only show its products on a phone.`;
            return out;
          });
        } catch (e) {
          return answerOfError(chain, name, e);
        }
      }),
    );
    return { text, shops };
  }, o.config);
}
