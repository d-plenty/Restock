import { describe, expect, it } from 'vitest';
import { rankAll, rankResults, stem, tokens } from './rank';
import type { StoreProduct } from './types';

const sp = (name: string, size?: string, extra: Partial<StoreProduct> = {}): StoreProduct => ({
  chain: 'woolworths',
  storeProductId: name,
  name,
  size,
  isSpecial: false,
  memberOnly: false,
  ...extra,
});

describe('search ranking', () => {
  it('tokenises and stems', () => {
    expect(tokens("Arnott's Shapes Vegemite & Cheese 175g")).toEqual(['arnott', 'shape', 'vegemite', 'cheese']);
    expect(stem('tomatoes')).toBe('tomato');
  });

  it('puts the 380 g Vegemite jar above Shapes and scrolls', () => {
    const items = [
      sp("Arnott's Shapes Vegemite & Cheese", '175g'),
      sp('Bakery Cheese & Vegemite Scrolls', '4 pack'),
      sp('Vegemite Spread', '380g'),
      sp('Vegemite Spread', '220g'),
    ];
    const { top, rest } = rankResults({ text: 'Vegemite spread', size: '380 g' }, items);
    expect(top[0].size).toBe('380g');
    expect(top[1].size).toBe('220g');
    expect(rest).toContain(items[0]);
  });

  it('sinks ice cream when you scanned a chocolate topping', () => {
    const items = [
      sp('Streets Blue Ribbon Chocolate & Vanilla Ice Cream', '2L'),
      sp("Cottee's Ice Magic Chocolate Topping", '220g'),
      sp('Woolworths Chocolate Flavoured Topping', '600ml'),
    ];
    const { top, rest } = rankResults({ text: 'Chocolate topping', size: '600ml' }, items);
    expect(top[0].name).toContain('Topping');
    expect([...top, ...rest].indexOf(items[0])).toBe(2);
  });

  it('puts tomato paste below diced tomatoes', () => {
    const items = [
      sp('Woolworths Tomato Paste', '140g'),
      sp('Woolworths Diced Tomatoes', '400g'),
      sp('Woolworths Diced Tomatoes With Basil', '400g'),
    ];
    const ranked = rankAll({ text: 'Diced tomatoes', size: '400g' }, items);
    expect(ranked[ranked.length - 1].name).toContain('Paste');
  });

  it('always puts an exact barcode match first', () => {
    const items = [sp('Something else'), sp('Diced Tomatoes', '400g', { barcode: '9300633000001' })];
    expect(rankResults({ text: 'tomatoes', barcode: '9300633000001' }, items).top[0].name).toBe('Diced Tomatoes');
  });

  it('keeps plain text searches broad', () => {
    const items = [sp('Vegemite Spread', '380g'), sp('Vegemite Spread Squeezy', '200g'), sp('Vegemite Spread', '560g')];
    expect(rankResults({ text: 'vegemite' }, items).top).toHaveLength(3);
  });
});
