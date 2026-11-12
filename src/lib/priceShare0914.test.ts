import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ cachedSettings: () => ({ sharePrices: 'unasked' }), getKV: async () => undefined, putKV: async () => undefined }));
vi.mock('../stores/http', () => ({ isNative: () => false }));
vi.mock('./sql/native', () => ({ RestockNative: {} }));

import { sharing, shareShape } from './priceShare';

const p = (over: object = {}) => ({ chain: 'coles', storeProductId: '8150288', name: 'Coles Milk 3L', size: '3L', price: 4.95, wasPrice: 5.5, isSpecial: true, memberOnly: false, ...over }) as never;

describe('0.9.14 Send prices back', () => {
  it('is on unless turned off', () => {
    expect(sharing({ sharePrices: 'unasked' } as never)).toBe(true);
    expect(sharing({ sharePrices: 'yes' } as never)).toBe(true);
    expect(sharing({ sharePrices: 'no' } as never)).toBe(false);
  });

  it("sends only the shop's own facts, in the collector's shape", () => {
    expect(shareShape(p(), '2026-11-12')).toEqual({
      id: 'coles:8150288',
      chain: 'coles',
      store_product_id: '8150288',
      name: 'Coles Milk 3L',
      size: '3L',
      day: '2026-11-12',
      price: { price: 4.95, was_price: 5.5, is_special: true, member_only: false },
    });
  });

  it('leaves out other shops, sample items, odd product numbers and missing prices', () => {
    expect(shareShape(p({ chain: 'bws' }))).toBeUndefined();
    expect(shareShape(p({ chain: 'custom-1' }))).toBeUndefined();
    expect(shareShape(p({ storeProductId: 'demo-1' }))).toBeUndefined();
    expect(shareShape(p({ storeProductId: '../x' }))).toBeUndefined();
    expect(shareShape(p({ price: undefined }))).toBeUndefined();
    expect(shareShape(p({ chain: 'costco', storeProductId: '51210' }))?.chain).toBe('costco');
  });
});
