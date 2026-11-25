import { describe, expect, it, vi } from 'vitest';

// 0.10.4: a shop that answers 403 is "blocking Restock", never "found nothing for beer".
let status = 403;
let webItems: unknown[] = [];
vi.mock('./http', async (orig) => {
  const real = await orig<typeof import('./http')>();
  return {
    ...real,
    isNative: () => false,
    request: async () => ({ status, text: status === 403 ? '<html>Access Denied</html>' : '[]', headers: {} }),
  };
});
vi.mock('./web', async (orig) => {
  const real = await orig<typeof import('./web')>();
  return { ...real, searchWeb: async () => webItems };
});

describe("Dan Murphy's turning Restock away", () => {
  it('says it is blocked when the data answers 403 and its search page has nothing', async () => {
    const { endeavourAdapter } = await import('./endeavour');
    const { BlockedError } = await import('./http');
    status = 403;
    webItems = [];
    await expect(endeavourAdapter('danmurphys').search('beer')).rejects.toBeInstanceOf(BlockedError);
    await expect(endeavourAdapter('danmurphys').search('peroni')).rejects.toBeInstanceOf(BlockedError);
  });
  it("uses its normal search page when that has products", async () => {
    const { endeavourAdapter } = await import('./endeavour');
    status = 403;
    webItems = [{ chain: 'danmurphys', storeProductId: '1', name: 'Peroni', price: 20 }];
    expect(await endeavourAdapter('danmurphys').search('beer')).toHaveLength(1);
  });
  it('still answers nothing when the shop really has nothing', async () => {
    const { endeavourAdapter } = await import('./endeavour');
    status = 200;
    webItems = [];
    expect(await endeavourAdapter('danmurphys').search('zzqx')).toEqual([]);
  });
});
