import { describe, expect, it } from 'vitest';
import { secondHasAll } from './stockCheck';
import { stockPlaces } from './stockWhere';

describe('0.10.7 Check stock', () => {
  const s = { stores: { coles: { primary: 'Coles Aitkenvale', secondary: 'Coles Townsville City', branchStoreNo: '4655', branchStoreNo2: '0844' } }, accounts: {} } as never;
  it('says where each shop can be checked, and why not', () => {
    expect(stockPlaces(s, 'coles')).toEqual({ where: 'Coles Aitkenvale', where2: 'Coles Townsville City' });
    expect(stockPlaces(s, 'woolworths').cant).toMatch(/signed in/);
    expect(stockPlaces(s, 'aldi').cant).toMatch(/Aldi/);
    expect(stockPlaces(s, 'babybunting' as never).cant).toMatch(/doesn’t share stock/);
    expect(stockPlaces({ stores: {}, accounts: { woolworths: { signedIn: true, storeName: 'Woolworths Kirwan' } } } as never, 'woolworths').where).toBe('Woolworths Kirwan');
  });
  it('only suggests the second store when it has everything', () => {
    const shop = (rows: { main: 'in' | 'out' | 'unknown'; second?: 'in' | 'out' | 'unknown' }[]) => ({ chain: 'coles' as const, where: 'A', where2: 'B', rows: rows.map((r, i) => ({ name: `x${i}`, ...r })) });
    expect(secondHasAll(shop([{ main: 'out', second: 'in' }, { main: 'in', second: 'in' }]))).toBe(true);
    expect(secondHasAll(shop([{ main: 'out', second: 'in' }, { main: 'in', second: 'out' }]))).toBe(false);
    expect(secondHasAll(shop([{ main: 'out', second: 'in' }, { main: 'in', second: 'unknown' }]))).toBe(false);
    expect(secondHasAll(shop([{ main: 'in', second: 'in' }]))).toBe(false);
  });
});
