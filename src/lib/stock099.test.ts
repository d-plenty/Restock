import { describe, expect, it } from 'vitest';
import { branchAdvice, stockRows, stockTag } from './stock';

const s = { stores: { coles: { primary: 'Coles Thuringowa', secondary: 'Coles Kirwan', branchStoreNo: '4655', branchStoreNo2: '0844' } }, localPrices: true, accounts: {} } as never;

describe('0.9.9 stock', () => {
  it('a row per shop, plus your second Coles; Aldi is unknown', () => {
    const rows = stockRows(
      [
        { chain: 'coles', name: 'Milk 2L', inStock: false, inStock2: true, stockAt: '2026-11-11T00:00:00Z' },
        { chain: 'aldi', name: 'Milk 2L', inStock: true },
      ] as never,
      s,
    );
    expect(rows.map((r) => [r.where, r.state])).toEqual([
      ['Coles Thuringowa', 'out'],
      ['Coles Kirwan', 'in'],
      ['Aldi', 'unknown'],
    ]);
    expect(stockTag(rows).text).toBe('Out at Coles Thuringowa');
    expect(stockTag([rows[2]]).text).toBe('Stock unknown');
  });

  it('suggests the other branch when your main one is missing things', () => {
    const one = stockRows([{ chain: 'coles', name: 'Milk', inStock: false, inStock2: true }] as never, s);
    const two = stockRows([{ chain: 'coles', name: 'Bread', inStock: false, inStock2: true }] as never, s);
    expect(branchAdvice([one, two])).toBe('Go to Coles Kirwan: 2 items are out at Coles Thuringowa.');
    expect(branchAdvice([stockRows([{ chain: 'coles', name: 'Eggs', inStock: true, inStock2: true }] as never, s)])).toBeUndefined();
  });
});
