import { describe, expect, it } from 'vitest';
import { nameFromLink, shopForUrl, splitShared } from './shared';

describe('sharing a link to Restock', () => {
  it('knows which shop a link is on', () => {
    expect(shopForUrl('https://www.woolworths.com.au/shop/productdetails/12345/milo')).toBe('woolworths');
    expect(shopForUrl('https://bws.com.au/product/1/hard-solo')).toBe('bws');
    expect(shopForUrl('https://example.com/x')).toBeUndefined();
  });
  it('reads a name from the shared text or the link', () => {
    expect(splitShared('Nestle Milo 460g | Woolworths https://www.woolworths.com.au/shop/productdetails/1/x')).toEqual({
      url: 'https://www.woolworths.com.au/shop/productdetails/1/x',
      words: 'Nestle Milo 460g',
    });
    expect(nameFromLink('https://www.coles.com.au/product/nestle-milo-chocolate-malt-460g-1234567')).toBe('Nestle Milo Chocolate Malt 460g');
  });
});
