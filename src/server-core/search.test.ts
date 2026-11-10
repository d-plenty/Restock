// 0.9.5: "Let the web page search the shops" in the server's core (search.ts, src/stores/node.ts),
// with a stand-in fetch (no real shops are asked): the hosts it may ask, redirects, the time and size
// limits, cookies for one search only, blocked shops, the household's shops and branch, and results
// ranked the phone's way.
import { describe, expect, it } from 'vitest';
import { request } from '../stores/http';
import { runSearch, runShop, SHOP_HOSTS, ShopRefusedError, ShopTimeoutError, ShopTooBigError } from '../stores/node';
import { ENDEAVOUR } from '../stores/endeavour';
import { normaliseQuery, scoreAll } from '../lib/searchHelp';
import { flattenWoolworths } from '../stores/woolworths';
import { configureShopSearch, searchHow, searchPlan, searchShops } from './search';

configureShopSearch();

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;
interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}
function fakeFetch(route: Route) {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push({ url: url.toString(), method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) } });
    return route(url, init);
  }) as typeof fetch;
  return { fetch: f, seen };
}
const json = (v: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, ...init });
const html = (s: string, status = 200, headers: Record<string, string> = {}) => new Response(s, { status, headers: { 'content-type': 'text/html', ...headers } });

const MILK = [
  { Stockcode: 1, DisplayName: 'Cadbury Dairy Milk Chocolate Block 180g', Price: 6, PackageSize: '180g' },
  { Stockcode: 2, DisplayName: 'Woolworths Full Cream Milk 2L', Price: 3.1, WasPrice: 6.2, IsOnSpecial: true, PackageSize: '2L', CupString: '$1.55 / 1L', MediumImageFile: 'https://cdn0.woolworths.media/content/wowproductimages/medium/000002.jpg' },
  { Stockcode: 3, DisplayName: 'Woolworths Lite Milk 2L', Price: 3.1, PackageSize: '2L', LargeImageFile: 'http://not-https.example/3.jpg' },
  { Stockcode: 4, DisplayName: 'Milk Arrowroot Biscuits 250g', Price: 2.2, PackageSize: '250g' },
];

function woolies(products = MILK, extra: Route = () => html('', 404)): Route {
  return (url, init) => {
    if (url.host === 'www.woolworths.com.au' && url.pathname === '/') return html('<html>home</html>', 200, { 'set-cookie': 'bm_sz=abc; Path=/; Secure' });
    if (url.host === 'www.woolworths.com.au' && url.pathname === '/apis/ui/Search/products') return json({ Products: products.map((p) => ({ Products: [p] })) });
    return extra(url, init);
  };
}

describe('the hosts the server may ask', () => {
  it('has the built-in shops and their API hosts, and nothing else', () => {
    expect(SHOP_HOSTS.get('www.woolworths.com.au')).toBe('woolworths');
    expect(SHOP_HOSTS.get('www.coles.com.au')).toBe('coles');
    expect(SHOP_HOSTS.get('api.aldi.com.au')).toBe('aldi');
    for (const c of ['danmurphys', 'bws'] as const) expect(SHOP_HOSTS.get(new URL(ENDEAVOUR[c].api).host)).toBe(c);
    // Liquorland Warehouse's prices are Liquorland's.
    expect(SHOP_HOSTS.get('www.liquorland.com.au')).toBe('liquorland');
    expect([...SHOP_HOSTS.keys()].every((h) => /\.com\.au$/.test(h))).toBe(true);
  });

  it('refuses another host, plain http, a port, and any request outside a search', async () => {
    const { fetch, seen } = fakeFetch(() => html('ok'));
    await expect(request({ url: 'https://www.woolworths.com.au/' })).rejects.toBeInstanceOf(ShopRefusedError);
    await runSearch(
      () =>
        runShop('woolworths', 'Woolworths', async () => {
          for (const url of ['https://evil.example/', 'http://www.woolworths.com.au/', 'https://www.woolworths.com.au:8443/', 'https://user@www.woolworths.com.au/', 'https://www.coles.com.au/'])
            await expect(request({ url })).rejects.toBeInstanceOf(ShopRefusedError);
        }),
      { fetch },
    );
    expect(seen).toHaveLength(0);
  });

  it('follows a redirect only to the same shop, at most 3', async () => {
    const { fetch, seen } = fakeFetch((url) => {
      if (url.pathname === '/away') return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
      if (url.pathname === '/api') return new Response(null, { status: 301, headers: { location: 'https://api.danmurphys.com.au/apis/ui/x' } });
      if (url.pathname === '/loop') return new Response(null, { status: 302, headers: { location: '/loop' } });
      return json({ ok: true });
    });
    await runSearch(
      () =>
        runShop('danmurphys', "Dan Murphy's", async () => {
          await expect(request({ url: 'https://www.danmurphys.com.au/away' })).rejects.toThrow(/another website/);
          const r = await request({ url: 'https://www.danmurphys.com.au/api', method: 'POST', body: { a: 1 }, headers: { 'Content-Type': 'application/json' } });
          expect(r.status).toBe(200);
          await expect(request({ url: 'https://www.danmurphys.com.au/loop' })).rejects.toThrow(/circles/);
        }),
      { fetch },
    );
    expect(seen.some((s) => s.url.includes('evil.example'))).toBe(false);
    // A 301 after a POST goes on as a GET (as a phone's connection does).
    expect(seen.find((s) => s.url === 'https://api.danmurphys.com.au/apis/ui/x')?.method).toBe('GET');
    expect(seen.filter((s) => s.url.endsWith('/loop'))).toHaveLength(4);
  });

  it('cuts a shop off at its time, and an answer over the size cap', async () => {
    const slow = fakeFetch((_url, init) => new Promise<Response>((_, no) => init.signal?.addEventListener('abort', () => no(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const t = Date.now();
    await expect(runSearch(() => runShop('aldi', 'Aldi', () => request({ url: 'https://api.aldi.com.au/v3/product-search' })), { fetch: slow.fetch, timeoutMs: 150 })).rejects.toBeInstanceOf(
      ShopTimeoutError,
    );
    expect(Date.now() - t).toBeLessThan(2000);
    const big = fakeFetch(() => new Response('x'.repeat(5000)));
    await expect(runSearch(() => runShop('aldi', 'Aldi', () => request({ url: 'https://api.aldi.com.au/v3/product-search' })), { fetch: big.fetch, maxBytes: 1000 })).rejects.toBeInstanceOf(ShopTooBigError);
    const said = fakeFetch(() => new Response('x', { headers: { 'content-length': '999999' } }));
    await expect(runSearch(() => runShop('aldi', 'Aldi', () => request({ url: 'https://api.aldi.com.au/v3/product-search' })), { fetch: said.fetch, maxBytes: 1000 })).rejects.toBeInstanceOf(ShopTooBigError);
  });
});

describe('searchShops', () => {
  it('ranks results the phone way, with the phone fields, and keeps cookies for one search only', async () => {
    const one = fakeFetch(woolies());
    const r = await searchShops({ q: 'Milk', asks: [{ chain: 'woolworths' }], config: { fetch: one.fetch } });
    expect(r.text).toBe('milk');
    const shop = r.shops[0];
    expect(shop.status).toBe('ok');
    if (shop.status !== 'ok') return;
    const want = scoreAll({ text: normaliseQuery('Milk') }, flattenWoolworths({ Products: MILK.map((p) => ({ Products: [p] })) })).map((x) => x.sp.storeProductId);
    expect(shop.items.map((p) => p.storeProductId)).toEqual(want);
    expect(shop.items[0].name).not.toMatch(/Chocolate|Biscuit/);
    const full = shop.items.find((p) => p.storeProductId === '2')!;
    expect(full).toMatchObject({ chain: 'woolworths', price: 3.1, wasPrice: 6.2, isSpecial: true, halfPrice: true, memberOnly: false, size: '2L', unitPriceText: '$1.55 / 1L' });
    expect(full.imageUrl).toMatch(/^https:\/\/cdn0\.woolworths\.media\//);
    expect(shop.items.find((p) => p.storeProductId === '3')!.imageUrl).toBeUndefined();
    expect(shop.top.length).toBeGreaterThan(0);
    // The homepage's cookie went with the search request, and the honest User-Agent with both.
    const api = one.seen.find((s) => s.url.includes('/apis/ui/Search/products'))!;
    expect(api.headers.Cookie).toBe('bm_sz=abc');
    expect(api.headers['User-Agent']).toMatch(/Restock/);
    // The next search starts with an empty jar: no cookie from the last one.
    const two = fakeFetch(woolies());
    await searchShops({ q: 'milk', asks: [{ chain: 'woolworths' }], config: { fetch: two.fetch } });
    // (woolworths.ts remembers it visited the homepage within 20 minutes, so it asks straight away.)
    const first = two.seen[0];
    expect(first.url).toContain('/apis/ui/Search/products');
    expect(first.headers.Cookie).toBeUndefined();
  });

  it('a shop that turns the server away is blocked, and the others still answer', async () => {
    const { fetch } = fakeFetch(
      woolies(MILK, (url) => {
        if (url.host === 'www.coles.com.au') return html('<html><title>Pardon Our Interruption</title></html>', 403);
        return html('', 404);
      }),
    );
    const r = await searchShops({ q: 'milk', asks: [{ chain: 'woolworths' }, { chain: 'coles' }], config: { fetch } });
    expect(r.shops.map((s) => s.status)).toEqual(['ok', 'blocked']);
    expect(r.shops[1]).toEqual({ chain: 'coles', name: 'Coles', status: 'blocked', blocked: true, message: 'Coles blocked the search from your server. Search it on a phone instead.' });
  }, 15_000);

  it("never throws for a shop's error, and says when one took too long", async () => {
    const { fetch } = fakeFetch(() => {
      throw new Error('ECONNRESET');
    });
    const r = await searchShops({ q: 'milk', asks: [{ chain: 'aldi' }], config: { fetch } });
    expect(r.shops[0].status).toBe('error');
    expect(r.shops[0]).toHaveProperty('message');
    const slow = fakeFetch((_u, init) => new Promise<Response>((_, no) => init.signal?.addEventListener('abort', () => no(Object.assign(new Error('x'), { name: 'AbortError' })))));
    const t = await searchShops({ q: 'beer', asks: [{ chain: 'bws' }], config: { fetch: slow.fetch, timeoutMs: 200 } });
    expect(t.shops[0]).toMatchObject({ status: 'error', message: 'BWS took too long to answer. Try again, or search it on a phone.' });
  }, 15_000);

  it('asks Coles for the household branch, and searches a barcode too', async () => {
    const { fetch, seen } = fakeFetch((url) => {
      if (url.host === 'www.coles.com.au' && url.pathname === '/') return html('<script>window.cfg={"BFF_API_SUBSCRIPTION_KEY":"k123"}</script>');
      if (url.pathname === '/api/bff/products/search')
        return json({ results: [{ _type: 'PRODUCT', id: 77, name: 'Full Cream Milk', brand: 'Coles', size: '2L', pricing: { now: 3.1, comparable: '$1.55 per 1L' }, imageUris: [{ uri: '/7/77.jpg' }] }] });
      return html('', 404);
    });
    const r = await searchShops({ q: 'milk', barcode: '9300633000000', asks: [{ chain: 'coles', storeId: '0844' }], config: { fetch } });
    expect(r.shops[0].status).toBe('ok');
    const asked = seen.filter((s) => s.url.includes('/api/bff/products/search')).map((s) => new URL(s.url).searchParams);
    expect(asked.every((p) => p.get('storeId') === '0844')).toBe(true);
    expect(asked.map((p) => p.get('searchTerm')).sort()).toEqual(['9300633000000', 'milk']);
    if (r.shops[0].status === 'ok') expect(r.shops[0].items[0]).toMatchObject({ name: 'Coles Full Cream Milk', imageUrl: 'https://productimages.coles.com.au/productimages/7/77.jpg' });
  });

  it("reads a chemist's known search page for its data, and skips shops people added", async () => {
    const ld = (name: string, price: number) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name, url: `/p/${name}`, offers: { price } })}</script>`;
    const { fetch, seen } = fakeFetch((url) => (url.host === 'www.chemistwarehouse.com.au' ? html(`<html>${ld('Panadol 20 Tablets', 4.99)}${ld('Panadol Rapid 20', 6.49)}</html>`) : html('', 404)));
    const r = await searchShops({ q: 'panadol', asks: [{ chain: 'chemistwarehouse' }, { chain: 'custom-abc' as never }, { chain: 'guardian' }], config: { fetch } });
    expect(r.shops[0].status).toBe('ok');
    if (r.shops[0].status === 'ok') expect(r.shops[0].items.map((p) => p.name)).toContain('Panadol 20 Tablets');
    expect(r.shops[1]).toMatchObject({ status: 'skipped', message: expect.stringMatching(/shops you added/) });
    expect(r.shops[2]).toMatchObject({ status: 'skipped' });
    expect(seen.every((s) => new URL(s.url).host === 'www.chemistwarehouse.com.au')).toBe(true);
    expect(searchHow('custom-x')).toBe('custom');
    expect(searchHow('coles')).toBe('direct');
  });
});

describe('searchPlan', () => {
  it("is the household's shops on that tab, one per website, with the Coles branch", () => {
    const s = { enabledChains: ['woolworths', 'coles', 'liquorland', 'liquorlandwarehouse', 'bws'], sections: { keg: true } };
    const rows = [
      { k: 'branch:coles', v: JSON.stringify({ name: 'Coles Kirwan', storeNo: '0844' }) },
      { k: 'branch:woolworths', v: 'not json' },
    ];
    expect(searchPlan(s, 'pantry', rows).asks).toEqual([{ chain: 'woolworths' }, { chain: 'coles', storeId: '0844' }]);
    expect(searchPlan(s, 'keg', rows).asks).toEqual([{ chain: 'liquorland' }, { chain: 'bws' }]);
    expect(searchPlan(s, 'pharmacy', rows)).toEqual({ asks: [], error: 'tab' });
    expect(searchPlan(s, 'pantry', rows, 'coles').asks).toEqual([{ chain: 'coles', storeId: '0844' }]);
    expect(searchPlan(s, 'pantry', rows, 'aldi')).toEqual({ asks: [], error: 'shop' });
    // No settings yet: the usual three.
    expect(searchPlan({}, 'pantry', []).asks.map((a) => a.chain)).toEqual(['woolworths', 'coles', 'aldi']);
  });
});
