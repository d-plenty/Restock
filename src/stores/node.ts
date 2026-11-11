// 0.9.5: how the Restock server asks a shop, for "Let the web page search the shops" (a server
// setting, off unless someone turns it on). The same shop connections as the phone (woolworths.ts,
// coles.ts, aldi.ts, endeavour.ts) run on the server through http.ts `request`, which hands every
// request here once the server's core has called `useNodeTransport` (src/server-core/search.ts).
// A phone and the web app never load this file.
//
// What it allows, and nothing else:
// - only https, and only the shops' own hosts in SHOP_HOSTS (built from shops.ts and the shops' API
//   hosts: nothing a person typed in, so shops people added are never asked from the server);
// - only while a search is running (runSearch), and only for a shop being searched (runShop): no
//   request outside a search, so nothing in the background;
// - a redirect only to another host of the same shop, at most 3;
// - an answer of at most maxBytes (3 MB), and each shop's whole search within timeoutMs (10 s);
// - cookies only for the length of one search (a new jar each time, dropped when it ends), so no shop
//   session, and never any shop sign-in, is kept on the server.
import { SHOPS, isLocalOnlyShop, priceSource, shopDef, type StoreChain } from '../shops';
import { setTransport, type HttpResult, type RequestOptions } from './http';

/** The shops' API hosts, besides their websites (aldi.ts API, endeavour.ts ENDEAVOUR.api). */
export const API_HOSTS: Record<string, StoreChain> = {
  'api.aldi.com.au': 'aldi',
  'api.danmurphys.com.au': 'danmurphys',
  'api.bws.com.au': 'bws',
};

/** Every host the server may ask, and the shop it belongs to (the one whose prices it has). */
export const SHOP_HOSTS: ReadonlyMap<string, StoreChain> = (() => {
  const m = new Map<string, StoreChain>();
  const add = (url: string | undefined, chain: StoreChain) => {
    if (!url) return;
    try {
      const host = new URL(url.replace('{q}', 'x')).host.toLowerCase();
      if (!m.has(host)) m.set(host, chain);
    } catch {
      // not an address
    }
  };
  for (const s of SHOPS) {
    // 0.9.7: Costco may be asked by the server too (web search, when that setting is on), like any shop.
    if (isLocalOnlyShop(s.id)) continue;
    const owner = priceSource(s.id);
    add(s.website, owner);
    add(s.search, owner);
  }
  for (const [host, chain] of Object.entries(API_HOSTS)) m.set(host, chain);
  return m;
})();

/** The shop a host belongs to, or undefined when the server may not ask it. */
export const shopOfHost = (host: string): StoreChain | undefined => SHOP_HOSTS.get(host.toLowerCase());

/** The server refused to make this request (a host that isn't a shop's, or a redirect elsewhere). */
export class ShopRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopRefusedError';
  }
}
/** The shop took longer than its time. */
export class ShopTimeoutError extends Error {
  constructor(name: string) {
    super(`${name} took too long to answer.`);
    this.name = 'ShopTimeoutError';
  }
}
/** The shop's answer was bigger than the server takes. */
export class ShopTooBigError extends Error {
  constructor(name: string) {
    super(`${name} sent back more than the server takes.`);
    this.name = 'ShopTooBigError';
  }
}

export interface NodeConfig {
  fetch: typeof fetch;
  userAgent: string;
  /** Per answer, after unzipping. */
  maxBytes: number;
  /** Per shop, for its whole search (every request it makes). */
  timeoutMs: number;
  maxRedirects: number;
}

export const NODE_DEFAULTS: Omit<NodeConfig, 'fetch' | 'userAgent'> = { maxBytes: 3 * 1024 * 1024, timeoutMs: 10_000, maxRedirects: 3 };

let cfg: NodeConfig = {
  fetch: (...a) => globalThis.fetch(...a),
  userAgent: 'Restock server (self-hosted grocery price tracker)',
  ...NODE_DEFAULTS,
};

/** Hands http.ts `request` to this file (the server's core, once, at start). */
export function useNodeTransport(c: Partial<NodeConfig> = {}) {
  cfg = { ...cfg, ...c };
  setTransport(nodeRequest);
}

interface Shop {
  chain: StoreChain;
  name: string;
  deadline: number;
  controller: AbortController;
  done: boolean;
}
interface Search {
  jar: Map<string, Map<string, string>>;
  shops: Map<StoreChain, Shop>;
}
let current: Search | undefined;
let queue: Promise<unknown> = Promise.resolve();

/**
 * One search at a time (each with its own cookie jar, dropped when it ends). `over`: settings for
 * this search only (the server's fetch in tests, say).
 */
export function runSearch<T>(body: () => Promise<T>, over: Partial<NodeConfig> = {}): Promise<T> {
  const run = queue.then(async () => {
    const was = cfg;
    cfg = { ...cfg, ...over };
    setTransport(nodeRequest);
    current = { jar: new Map(), shops: new Map() };
    try {
      return await body();
    } finally {
      for (const s of current.shops.values()) {
        s.done = true;
        s.controller.abort();
      }
      current = undefined;
      cfg = was;
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * One shop's part of a search: its requests are allowed while `body` runs, and all of it gets
 * timeoutMs. On time out the shop's requests are cut off and a ShopTimeoutError comes back.
 */
export async function runShop<T>(chain: StoreChain, name: string, body: () => Promise<T>): Promise<T> {
  if (!current) throw new ShopRefusedError('The server only asks a shop while someone searches.');
  const shop: Shop = { chain, name, deadline: Date.now() + cfg.timeoutMs, controller: new AbortController(), done: false };
  current.shops.set(chain, shop);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => {
    timer = setTimeout(() => {
      shop.done = true;
      shop.controller.abort();
      no(new ShopTimeoutError(name));
    }, cfg.timeoutMs);
  });
  try {
    return await Promise.race([body(), late]);
  } finally {
    clearTimeout(timer);
    shop.done = true;
    shop.controller.abort();
  }
}

function cookieOf(jar: Search['jar'], host: string): string | undefined {
  const c = jar.get(host);
  return c?.size ? [...c.entries()].map(([k, v]) => `${k}=${v}`).join('; ') : undefined;
}
function keepCookies(jar: Search['jar'], host: string, res: Response) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!list.length) return;
  const c = jar.get(host) ?? new Map<string, string>();
  for (const line of list) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0 && c.size < 100) c.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  jar.set(host, c);
}

async function readCapped(res: Response, max: number, name: string): Promise<string> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new ShopTooBigError(name);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new ShopTooBigError(name);
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
}

/** http.ts `request`, on the server. */
export async function nodeRequest(opts: RequestOptions): Promise<HttpResult> {
  const search = current;
  if (!search) throw new ShopRefusedError('The server only asks a shop while someone searches.');
  let url: URL;
  try {
    url = new URL(opts.url);
  } catch {
    throw new ShopRefusedError("That isn't a shop's address.");
  }
  const chain = url.protocol === 'https:' && !url.username && !url.password && !url.port ? shopOfHost(url.host) : undefined;
  const shop = chain ? search.shops.get(chain) : undefined;
  if (!chain || !shop) throw new ShopRefusedError(`The server doesn't ask ${url.host} (only the shops' own websites).`);
  if (shop.done) throw new ShopTimeoutError(shop.name);
  let method: 'GET' | 'POST' = opts.method ?? 'GET';
  let body: string | undefined = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  let headers: Record<string, string> = { 'User-Agent': cfg.userAgent, ...(opts.headers ?? {}) };
  for (let hop = 0; ; hop++) {
    const host = url.host.toLowerCase();
    const h: Record<string, string> = { ...headers };
    const cookie = cookieOf(search.jar, host);
    if (cookie) h.Cookie = cookie;
    let res: Response;
    try {
      res = await cfg.fetch(url.toString(), { method, headers: h, body, redirect: 'manual', signal: shop.controller.signal });
    } catch (e) {
      if (shop.done || (e instanceof Error && e.name === 'AbortError')) throw new ShopTimeoutError(shop.name);
      throw new Error(`Couldn't reach ${shop.name} from the server just now.`);
    }
    keepCookies(search.jar, host, res);
    const where = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (where) {
      await res.body?.cancel().catch(() => undefined);
      let next: URL;
      try {
        next = new URL(where, url);
      } catch {
        throw new ShopRefusedError(`${shop.name} sent the search somewhere the server can't follow.`);
      }
      if (next.protocol !== 'https:' || next.username || next.password || next.port || shopOfHost(next.host) !== chain) {
        throw new ShopRefusedError(`${shop.name} sent the search to another website, which the server doesn't follow.`);
      }
      if (hop >= cfg.maxRedirects) throw new ShopRefusedError(`${shop.name} sent the search round in circles.`);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'content-type'));
      }
      url = next;
      continue;
    }
    const text = await readCapped(res, cfg.maxBytes, shop.name).catch((e: unknown) => {
      if (e instanceof ShopTooBigError) throw e;
      if (shop.done) throw new ShopTimeoutError(shop.name);
      throw new Error(`Couldn't reach ${shop.name} from the server just now.`);
    });
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k !== 'set-cookie') out[k] = v;
    });
    return { status: res.status, text, headers: out };
  }
}

/** A shop's name for messages (the built-in name; this file never sees shops people added). */
export const nameOfChain = (c: StoreChain) => shopDef(c)?.name ?? c;
