import { beforeEach, describe, expect, it, vi } from 'vitest';

// Coles searched at your own branch (testing): if it fails or has nothing, the online store is used.
const calls: string[] = [];
let answer: (store: string) => { status: number; text: string };

vi.mock('./http', async (orig) => {
  const real = await orig<typeof import('./http')>();
  return {
    ...real,
    isNative: () => false,
    sleep: async () => undefined,
    request: async (o: { url: string }) => {
      if (o.url.endsWith('coles.com.au/')) return { status: 200, text: 'BFF_API_SUBSCRIPTION_KEY: "k"', headers: {} };
      const store = new URL(o.url).searchParams.get('storeId') ?? '';
      calls.push(store);
      return { ...answer(store), headers: {} };
    },
  };
});
vi.mock('../lib/diagnostics', () => ({ logProblem: vi.fn(async () => undefined) }));

const product = (price: number) =>
  JSON.stringify({ results: [{ _type: 'PRODUCT', id: 1, name: 'Peanut Butter Smooth', size: '500g', pricing: { now: price } }] });

describe('Coles at your store', () => {
  beforeEach(() => (calls.length = 0));

  it("uses your store's prices when it answers", async () => {
    const { coles } = await import('./coles');
    answer = (store) => ({ status: 200, text: product(store === '0844' ? 3.2 : 3.5) });
    const out = await coles.search('peanut butter', '0844');
    expect(out[0].price).toBe(3.2);
    expect(calls).toEqual(['0844']);
  });

  it('falls back to the online store when yours has nothing', async () => {
    const { coles } = await import('./coles');
    answer = (store) => ({ status: 200, text: store === '0844' ? JSON.stringify({ results: [] }) : product(3.5) });
    const out = await coles.search('peanut butter', '0844');
    expect(out[0].price).toBe(3.5);
    expect(calls).toEqual(['0844', '0584']);
  });

  it('falls back when your store errors', async () => {
    const { coles } = await import('./coles');
    answer = (store) => (store === '0844' ? { status: 500, text: 'oops' } : { status: 200, text: product(3.5) });
    const out = await coles.search('peanut butter', '0844');
    expect(out[0].price).toBe(3.5);
    expect(calls[calls.length - 1]).toBe('0584');
  });
});

describe('Coles specials, from a real search (7 Nov 2026)', () => {
  it('counts only real sales, not everyday prices or collectables', async () => {
    const { flattenColes } = await import('./coles');
    const data = (await import('./fixtures-coles-weetbix.json')).default;
    const all = flattenColes(data as never);
    const by = (id: string) => all.find((p) => p.storeProductId === id)!;
    expect(by('9393015').isSpecial).toBe(false); // EVERYDAY, $7.00
    expect(by('4951398').isSpecial).toBe(false); // BONUSCOLLECTABLE
    expect(by('4951398').promo).toBe('Bonus collectable');
    expect(by('2001784').isSpecial).toBe(true); // SPECIAL, was $5.00, now $3.50
    expect(by('2001784').wasPrice).toBe(5);
    expect(all.filter((p) => p.isSpecial)).toHaveLength(4);
  });
});
