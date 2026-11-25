import { beforeEach, describe, expect, it, vi } from 'vitest';

// 0.9.1: barcode lookups at the shops go without your sign-in. On the phone, every plain request
// (CapacitorHttp) also carries the in-app browser's cookies, and the hidden browser (storeFetch) is
// the browser; an anonymous search must use neither, only plainFetch on its own cookie jar.

type Call = { via: 'capacitor' | 'plain' | 'browser'; url: string; jar?: string; headers?: Record<string, string>; body?: unknown };
const calls: Call[] = [];
let answer: (c: Call) => { status: number; text: string; headers?: Record<string, string> };

const WOOLIES_HIT = JSON.stringify({
  Products: [{ Products: [{ Stockcode: 1, DisplayName: 'Earth Choice Dishwashing Liquid 900mL', Barcode: '9310692112198', Price: 4.5 }] }],
});
const COLES_HIT = JSON.stringify({ results: [{ _type: 'PRODUCT', id: 7, name: 'Dishwashing Liquid', brand: 'Earth Choice', pricing: { now: 4.2 } }] });

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({}),
  CapacitorHttp: {
    request: async (o: { url: string; headers?: Record<string, string>; data?: unknown }) => {
      const c: Call = { via: 'capacitor', url: o.url, headers: o.headers, body: o.data };
      calls.push(c);
      const a = answer(c);
      return { status: a.status, data: a.text, headers: a.headers ?? {} };
    },
  },
}));
vi.mock('../lib/sql/native', () => ({
  RestockNative: {
    plainFetch: async (o: { jar: string; url: string; headers?: Record<string, string>; body?: string }) => {
      const c: Call = { via: 'plain', url: o.url, jar: o.jar, headers: o.headers, body: o.body };
      calls.push(c);
      const a = answer(c);
      return { status: a.status, body: a.text, headers: a.headers ?? {} };
    },
    storeFetch: async (o: { url: string }) => {
      calls.push({ via: 'browser', url: o.url });
      return { status: 200, body: '{}' };
    },
  },
}));
vi.mock('../lib/diagnostics', () => ({ capture: () => undefined, logProblem: async () => undefined }));

beforeEach(() => {
  calls.length = 0;
  answer = () => ({ status: 200, text: '{}' });
});

describe('anonymous requests (0.9.1)', () => {
  it('go through plainFetch on their jar, without the cookies other requests picked up', async () => {
    const { request, clearCookies } = await import('./http');
    clearCookies();
    // An ordinary request picks up a cookie in this file's own jar...
    answer = () => ({ status: 200, text: '', headers: { 'Set-Cookie': 'auth=SIGNEDIN; Path=/' } });
    await request({ url: 'https://www.woolworths.com.au/' });
    answer = () => ({ status: 200, text: '{}' });
    await request({ url: 'https://www.woolworths.com.au/x' });
    expect(calls[1]).toMatchObject({ via: 'capacitor', headers: { Cookie: 'auth=SIGNEDIN' } });
    // ...which an anonymous one never sends.
    await request({ url: 'https://www.woolworths.com.au/y', method: 'POST', body: { a: 1 }, anonymous: 'lookup' });
    expect(calls[2]).toMatchObject({ via: 'plain', jar: 'lookup', body: '{"a":1}' });
    expect(calls[2].headers?.Cookie).toBeUndefined();
    clearCookies();
  });

  it('Woolworths: the barcode search never uses the usual connection or the hidden browser', async () => {
    const { woolworths } = await import('./woolworths');
    answer = (c) => ({ status: 200, text: c.url.endsWith('/') ? '<html></html>' : WOOLIES_HIT });
    const found = await woolworths.searchAnonymous!('9310692112198', 'lookup');
    expect(found[0].barcode).toBe('9310692112198');
    expect(calls.map((c) => c.via)).toEqual(['plain', 'plain']);
    expect(calls.every((c) => c.jar === 'lookup')).toBe(true);
  });

  it('Woolworths: turned away twice, it gives up rather than ask through the browser', async () => {
    const { woolworths } = await import('./woolworths');
    answer = () => ({ status: 403, text: '<html>blocked</html>' });
    await expect(woolworths.searchAnonymous!('9310692112198', 'lookup')).rejects.toThrow(/blocked/);
    expect(calls.some((c) => c.via !== 'plain')).toBe(false);
  });

  it('Coles: a direct request on the jar, even on the phone (where the usual search uses the browser)', async () => {
    const { coles } = await import('./coles');
    answer = (c) => ({ status: 200, text: c.url.endsWith('coles.com.au/') ? 'BFF_API_SUBSCRIPTION_KEY: "k1"' : COLES_HIT });
    const found = await coles.searchAnonymous!('9310692112198', 'lookup');
    expect(found[0].name).toBe('Earth Choice Dishwashing Liquid');
    expect(calls.map((c) => c.via)).toEqual(['plain', 'plain']);
    expect(new URL(calls[1].url).searchParams.get('subscription-key')).toBe('k1');
    // Blocked: no browser either.
    calls.length = 0;
    answer = () => ({ status: 403, text: '<html></html>' });
    await expect(coles.searchAnonymous!('9310692112198', 'lookup')).rejects.toThrow();
    expect(calls.some((c) => c.via !== 'plain')).toBe(false);
  });

  it('needs a jar name', async () => {
    const { woolworths } = await import('./woolworths');
    await expect(woolworths.searchAnonymous!('1', '')).rejects.toThrow(/jar/);
    expect(calls).toEqual([]);
  });
});
