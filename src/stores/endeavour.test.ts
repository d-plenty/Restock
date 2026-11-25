import { describe, expect, it, vi } from 'vitest';

// 0.10.6: "beer" is Dan Murphy's beer department. When asking for it the GET way brings nothing,
// Restock asks the way the shop's own pages do (a POST), and a shop that answers is never "blocked".
const calls: string[] = [];
vi.mock('./http', async (orig) => {
  const real = await orig<typeof import('./http')>();
  return {
    ...real,
    isNative: () => false,
    request: async (o: { url: string; method?: string }) => {
      calls.push(`${o.method ?? 'GET'} ${o.url.split('?')[0]}`);
      if (o.url.includes('/Search/products')) return { status: 200, text: JSON.stringify([{ ActionType: 'GoToUrl', RedirectUrl: 'https://www.danmurphys.com.au/beer/all' }]), headers: {} };
      if (o.url.endsWith('/Browse') && o.method === 'POST')
        return { status: 200, text: JSON.stringify({ Products: [{ Products: [{ Stockcode: '123', Name: 'Peroni Nastro Azzurro', Prices: { singleprice: { Value: 21.5 } } }] }] }), headers: {} };
      return { status: 200, text: JSON.stringify({ Products: [] }), headers: {} };
    },
  };
});
vi.mock('./web', async (orig) => ({ ...(await orig<typeof import('./web')>()), searchWeb: async () => [] }));

describe("Dan Murphy's beer department", () => {
  it('asks again with a POST when the GET brings nothing back', async () => {
    const { endeavourAdapter } = await import('./endeavour');
    const out = await endeavourAdapter('danmurphys').search('beer');
    expect(out.map((p) => p.name)).toEqual([expect.stringContaining('Peroni')]);
    expect(calls.some((c) => c.startsWith('POST') && c.endsWith('/Browse'))).toBe(true);
  });
});

describe('when to offer Unblock', () => {
  it("doesn't call Dan Murphy's or BWS blocked for finding nothing", async () => {
    const { offerUnblock } = await import('../lib/health');
    expect(offerUnblock('danmurphys', 'The shop answered but found nothing for "beer"')).toBe(false);
    expect(offerUnblock('bws', 'The shop answered but found nothing for "beer"')).toBe(false);
    expect(offerUnblock('danmurphys', "Dan Murphy's blocked the price check (HTTP 403). Try again later, or add the price by hand.")).toBe(true);
    expect(offerUnblock('cellarbrations', 'The shop answered but found nothing for "beer"')).toBe(true);
  });
});
