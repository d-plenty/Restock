// 0.15.1: the recommendations are worked out once per change and shared by every screen.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const recommend = vi.fn((g: { id: string }) => ({ group: g, options: [] }));
vi.mock('./verdict', async (orig) => ({ ...(await orig<typeof import('./verdict')>()), recommend: (g: { id: string }) => recommend(g) }));
vi.mock('./shelfWatch', () => ({ processShelf: async () => ({}), shelfNotes: () => undefined }));
vi.mock('./db', () => ({
  allGroups: async () => [{ id: 'g1' }, { id: 'g2' }],
  cardChains: async () => new Set(),
  getSettings: async () => ({ enabledChains: [], sections: {} }),
  getProducts: async () => [],
  getProductsByBarcode: async () => [],
  readingsFor: async () => new Map(),
  groupProductIds: () => [],
}));

const { loadRecommendations } = await import('./recs');
const { changed } = await import('./live');

describe('shared recommendations', () => {
  beforeEach(() => {
    recommend.mockClear();
    changed();
  });
  test('screens asking at the same time, or later with nothing changed, share one run', async () => {
    const [a, b] = await Promise.all([loadRecommendations(), loadRecommendations()]);
    expect(a).toBe(b);
    expect(await loadRecommendations()).toBe(a);
    expect(recommend).toHaveBeenCalledTimes(2); // once per item, once
  });
  test('a change to the database works them out again', async () => {
    const a = await loadRecommendations();
    changed();
    const b = await loadRecommendations();
    expect(b).not.toBe(a);
    expect(recommend).toHaveBeenCalledTimes(4);
  });
  test('after a minute they are worked out again (specials and staleness go by the clock)', async () => {
    const a = await loadRecommendations();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    try {
      expect(await loadRecommendations()).not.toBe(a);
    } finally {
      spy.mockRestore();
    }
  });
});
