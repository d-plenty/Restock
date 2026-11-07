import { describe, expect, it } from 'vitest';
import { flattenAldi } from './aldi';
import { extractColesKey, flattenColes } from './coles';
import { looksMemberOnly, num, splitSetCookie } from './http';
import { flattenWoolworths } from './woolworths';

describe('Woolworths parsing', () => {
  it('flattens bundles, skips marketplace items, reads specials', () => {
    const data = {
      Products: [
        {
          Products: [
            {
              Stockcode: 123456,
              Barcode: '9300605123456',
              DisplayName: 'Reflex A4 Copy Paper 500 Pack',
              Brand: 'Reflex',
              Price: 4.5,
              WasPrice: 9,
              IsOnSpecial: true,
              IsHalfPrice: true,
              PackageSize: '500 pack',
              CupString: '$0.90 / 100EA',
              MediumImageFile: 'https://cdn0.woolworths.media/content/wowproductimages/medium/123456.jpg',
            },
          ],
        },
        { Products: [{ Stockcode: 999, DisplayName: 'Marketplace thing', Price: 10, IsMarketProduct: true }] },
        { Stockcode: 42, Name: 'Flat product', Price: 2, WasPrice: 2, PackageSize: '1L' },
      ],
    };
    const out = flattenWoolworths(data);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      chain: 'woolworths',
      storeProductId: '123456',
      barcode: '9300605123456',
      price: 4.5,
      wasPrice: 9,
      isSpecial: true,
      promo: '1/2 price',
      memberOnly: false,
    });
    expect(out[1]).toMatchObject({ storeProductId: '42', isSpecial: false, wasPrice: undefined });
  });
});

describe('Coles parsing', () => {
  it('maps products, drops ads, spots member prices', () => {
    const data = {
      results: [
        { _type: 'SINGLE_TILE', adId: 'x' },
        {
          _type: 'PRODUCT',
          id: 5551234,
          name: 'Toilet Tissue 24 Pack',
          brand: 'Coles',
          size: '24 pack',
          pricing: { now: 3.5, was: 6, comparable: '$0.15 per 1ea', promotionType: 'SPECIAL' },
          imageUris: [{ uri: '/5/5551234.jpg' }],
        },
        {
          _type: 'PRODUCT',
          id: 777,
          name: 'Ground Coffee',
          brand: 'Brand',
          size: '1kg',
          pricing: { now: 15, was: 20, offerDescription: 'Flybuys member price' },
        },
      ],
    };
    const out = flattenColes(data);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      storeProductId: '5551234',
      name: 'Coles Toilet Tissue 24 Pack',
      price: 3.5,
      wasPrice: 6,
      isSpecial: true,
      memberOnly: false,
      imageUrl: 'https://productimages.coles.com.au/productimages/5/5551234.jpg',
    });
    expect(out[1].memberOnly).toBe(true);
  });

  it('finds the API key in the homepage', () => {
    const html = '<script>window.__RUNTIME_CONFIG__={"ENV":"prod","BFF_API_SUBSCRIPTION_KEY":"abc123def"};</script>';
    expect(extractColesKey(html)).toBe('abc123def');
    expect(extractColesKey('<html>Checking your browser…</html>')).toBeUndefined();
  });
});

describe('Aldi parsing', () => {
  it('converts cents and reads was-prices', () => {
    const data = {
      data: [
        {
          sku: '000000000538441002',
          name: 'Toilet Tissue 24 Pack',
          brandName: 'ALDI',
          sellingSize: '24 pack',
          price: { amount: 500, amountRelevantDisplay: '$5.00', comparisonDisplay: '$0.21 per 1 ea' },
        },
        {
          sku: '2',
          name: 'Coffee',
          sellingSize: '1 kg',
          price: { amountRelevant: 1299, wasPriceDisplay: '$14.99' },
          badges: [{ displayText: 'Super Saver' }],
        },
      ],
    };
    const out = flattenAldi(data);
    expect(out[0]).toMatchObject({ price: 5, isSpecial: false, size: '24 pack', unitPriceText: '$0.21 per 1 ea' });
    expect(out[1]).toMatchObject({ price: 12.99, wasPrice: 14.99, isSpecial: true, promo: 'Super Saver' });
  });
});

describe('helpers', () => {
  it('splits Set-Cookie headers without breaking Expires dates', () => {
    const h = 'a=1; Path=/; Expires=Wed, 05 Nov 2026 10:00:00 GMT, b=2; Path=/; HttpOnly';
    expect(splitSetCookie(h).map((c) => c.split(';')[0])).toEqual(['a=1', 'b=2']);
  });
  it('reads numbers from strings', () => {
    expect(num('$1,234.50')).toBe(1234.5);
    expect(num(undefined)).toBeUndefined();
  });
  it('spots member wording', () => {
    expect(looksMemberOnly({ IsMemberPrice: true })).toBe(true);
    expect(looksMemberOnly('Save $2')).toBe(false);
  });
});

describe('stock flags', () => {
  it('reads stock from each store, and leaves it unknown when not given', () => {
    const ww = flattenWoolworths({
      Products: [
        { Stockcode: 1, Price: 2, IsInStock: false, IsAvailable: true },
        { Stockcode: 2, Price: 2, IsAvailable: true },
        { Stockcode: 3, Price: 2 },
      ],
    });
    expect(ww.map((p) => p.inStock)).toEqual([false, true, undefined]);
    const co = flattenColes({
      results: [
        { _type: 'PRODUCT', id: 1, pricing: { now: 2 }, availability: false },
        { _type: 'PRODUCT', id: 2, pricing: { now: 2 } },
      ],
    });
    expect(co.map((p) => p.inStock)).toEqual([false, undefined]);
    const al = flattenAldi({
      data: [
        { sku: '1', price: { amount: 100 }, notForSale: true },
        { sku: '2', price: { amount: 100 } },
      ],
    });
    // Aldi marks everything "not for sale" (no online shopping), so its stock is unknown.
    expect(al.map((p) => p.inStock)).toEqual([undefined, undefined]);
  });
});
