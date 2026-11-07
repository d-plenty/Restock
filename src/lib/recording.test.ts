import { describe, expect, it } from 'vitest';
import { tidyRecording } from './recording';

describe('trolley recordings', () => {
  it("keeps the shop's own trolley calls and removes personal and sign-in details", () => {
    const raw = JSON.stringify(
      JSON.stringify([
        {
          kind: 'fetch',
          method: 'POST',
          url: '/api/bff/trolley/items',
          status: 200,
          body: '{"productId":"8100621","quantity":1}',
          response: '{"items":[{"id":"8100621"}],"email":"me@x.com","firstName":"Dec"}',
        },
        { kind: 'fetch', method: 'POST', url: '/api/bff/auth/login', status: 200, body: '{"password":"secret"}', response: '{}' },
        { kind: 'xhr', method: 'GET', url: 'https://www.google-analytics.com/collect?x=1', status: 200, body: '', response: '' },
        {
          kind: 'fetch',
          method: 'GET',
          url: 'https://www.coles.com.au/api/bff/products/search?q=milk',
          status: 200,
          body: '',
          response: '{"results":[]}',
        },
      ]),
    );
    const out = tidyRecording(raw, 'https://www.coles.com.au/');
    expect(out.map((c) => c.url)).toEqual(['/api/bff/trolley/items', 'https://www.coles.com.au/api/bff/products/search?q=milk']);
    expect(out[0].response).not.toContain('me@x.com');
    expect(out[0].response).not.toContain('Dec');
    expect(out[0].body).toContain('8100621');
  });
});
