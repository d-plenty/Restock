import { describe, expect, it } from 'vitest';
import { mapAldi } from './aldi';
import { mapColes } from './coles';
import { mapWoolworths } from './woolworths';

// A $0 (or below) price is a placeholder, not a 100%-off deal. Same rule in StoreClient.java.
describe('a price of $0 is no price', () => {
  it('Woolworths', () => {
    expect(mapWoolworths({ Stockcode: 1, DisplayName: 'Milk', Price: 0 })?.price).toBeUndefined();
    expect(mapWoolworths({ Stockcode: 1, DisplayName: 'Milk', Price: 0, InstorePrice: 3.1 })?.price).toBe(3.1);
    expect(mapWoolworths({ Stockcode: 1, DisplayName: 'Milk', Price: 3.1 })?.price).toBe(3.1);
  });

  it('Coles', () => {
    expect(mapColes({ id: 1, name: 'Milk', pricing: { now: 0 } })?.price).toBeUndefined();
    expect(mapColes({ id: 1, name: 'Milk', pricing: { now: -1 } })?.price).toBeUndefined();
    expect(mapColes({ id: 1, name: 'Milk', pricing: { now: 2.5 } })?.price).toBe(2.5);
  });

  it('Aldi', () => {
    expect(mapAldi({ sku: '1', name: 'Milk', price: { amountRelevant: 0 } })?.price).toBeUndefined();
    expect(mapAldi({ sku: '1', name: 'Milk', price: { amountRelevant: 199 } })?.price).toBe(1.99);
    expect(mapAldi({ id: '2', name: 'Milk', price: { amountRelevant: 199 } })?.storeProductId).toBe('2');
  });
});
