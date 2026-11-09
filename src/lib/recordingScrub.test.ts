import { describe, expect, it } from 'vitest';
import { scrub, scrubUrl, tidyRecording } from './recording';

// 0.9.0: trolley recordings blank personal details in anything, not only in JSON.

describe('scrubbing a trolley recording', () => {
  it('blanks personal fields by any name that has a personal word in it', () => {
    const out = JSON.parse(
      scrub(
        JSON.stringify({
          productId: '8100621',
          quantity: 2,
          ShopperEmail: 'x',
          customer: { firstName: 'Dec', deliveryAddress: { line1: '12 Smith St' } },
          LoyaltyCardNumber: '6008940012345678',
          'x-csrf-token': 'abc',
          DateOfBirth: '1990-01-01',
          note: 'call me on 0412 345 678 or me@example.com',
          ref: '6008 9400 1234 5678',
          big: 6008940012345678,
        }),
      ),
    ) as Record<string, unknown>;
    expect(out.productId).toBe('8100621');
    expect(out.quantity).toBe(2);
    for (const k of ['ShopperEmail', 'customer', 'LoyaltyCardNumber', 'x-csrf-token', 'DateOfBirth', 'big']) expect(out[k]).toBe('(removed)');
    expect(out.note).toBe('(removed)');
    expect(out.ref).toBe('(removed)');
  });

  it('never keeps text that isn’t JSON as it was', () => {
    const form = scrub('email=me%40example.com&password=hunter2&qty=1&productId=8100621');
    expect(form).toBe('email=(removed)&password=(removed)&qty=1&productId=8100621');
    const text = scrub('Deliver to 12 Smith Street, Kirwan. Ring 0412 345 678 or (07) 4777 1234. Card 4111 1111 1111 1111. Mail dec@example.com.au');
    for (const bit of ['12 Smith Street', '0412 345 678', '4777 1234', '4111', 'dec@example.com.au']) expect(text).not.toContain(bit);
    expect(text).toContain('Kirwan');
    expect(scrub('x'.repeat(5000)).length).toBe(2000);
  });

  it('keeps the path of a web address but not what was in its query', () => {
    expect(scrubUrl('https://www.coles.com.au/api/bff/products/search?q=milk&storeId=0844#top')).toBe(
      'https://www.coles.com.au/api/bff/products/search?q=(removed)&storeId=(removed)',
    );
    expect(scrubUrl('/api/bff/trolley/items')).toBe('/api/bff/trolley/items');
    expect(scrubUrl('/api/user/me@example.com/cart')).toBe('/api/user/(removed)/cart');
  });

  it('scrubs the page each call was made from', () => {
    const raw = JSON.stringify([
      {
        kind: 'fetch',
        method: 'POST',
        url: '/api/bff/trolley/items?shopper=12345',
        page: 'https://www.coles.com.au/product/x?email=me@example.com',
        status: 200,
        body: 'not json, from 0412345678',
        response: '{}',
      },
    ]);
    const [call] = tidyRecording(raw, 'https://www.coles.com.au/');
    expect(call.url).toBe('/api/bff/trolley/items?shopper=(removed)');
    expect(call.page).toBe('https://www.coles.com.au/product/x?email=(removed)');
    expect(call.body).not.toContain('0412345678');
  });
});
