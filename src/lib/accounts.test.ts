import { describe, expect, it } from 'vitest';
import { readShopper } from './accounts';
import { stockKnown, stockAtBranch } from '../types';

describe('Woolworths account', () => {
  it('reads a guest (from what Woolworths sends someone not signed in)', () => {
    const a = readShopper({ IsGuest: true, FulfilmentStoreId: 1101 });
    expect(a.signedIn).toBe(false);
  });
  it('reads a signed-in shopper and their store', () => {
    const a = readShopper({ Shopper: { IsGuest: false, FulfilmentStoreId: 3304, FulfilmentStoreName: 'Kirwan' } });
    expect(a).toMatchObject({ signedIn: true, storeId: '3304', storeName: 'Kirwan' });
  });
  it('shows stock only when it is about your own store', () => {
    const base = { stores: {}, localPrices: false };
    expect(stockKnown(base, 'woolworths')).toBe(false);
    expect(stockKnown({ ...base, accounts: { woolworths: { signedIn: true } } }, 'woolworths')).toBe(true);
    expect(stockKnown(base, 'aldi')).toBe(false);
    expect(stockKnown({ stores: { coles: { branchStoreNo: '0844' } }, localPrices: true }, 'coles')).toBe(true);
    expect(stockAtBranch({ stores: {}, accounts: { woolworths: { signedIn: true, storeName: 'Kirwan' } } }, 'woolworths')).toBe('Woolworths Kirwan');
  });
});
