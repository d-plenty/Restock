import { describe, expect, it } from 'vitest';
import { shopAnswerCopy } from './ShopTest';

describe("0.10.7 Copy the shop's answer", () => {
  it('keeps the shape, a few products, and takes out anything personal', () => {
    const body = JSON.stringify({
      Products: Array.from({ length: 30 }, (_, i) => ({ Stockcode: String(i), Prices: { singleprice: { Value: 17.99, Message: 'Pack (4)' } } })),
      Customer: { Email: 'a@b.c' },
      StoreId: '1234',
      Location: { Suburb: 'Kirwan', Postcode: '4817' },
    });
    const out = shopAnswerCopy({ kind: 'browser fetch', url: 'https://api.danmurphys.com.au/apis/ui/Browse?x=1', status: 200, body });
    expect(out).toContain('api.danmurphys.com.au/apis/ui/Browse');
    expect(out).toContain('Pack (4)');
    expect(out).not.toContain('a@b.c');
    expect(out).not.toContain('1234');
    expect(out).not.toContain('Kirwan');
    expect(out).not.toContain('4817');
    expect(out).not.toContain('"Stockcode": "5"');
    expect(out).not.toContain('x=1');
    expect(shopAnswerCopy({ kind: 'browser page', url: 'https://www.cellarbrations.com.au/sm/planning/rsid/8159/results', status: 200, body: '<p>x</p>' })).not.toContain('8159');
  });

  it('a web page loses its scripts and styles, and is cut short', () => {
    const body = `<html><style>.a{}</style><script>var t="secret"</script><script type="application/ld+json">{"name":"Beer"}</script>${'<p>x</p>'.repeat(20000)}</html>`;
    const out = shopAnswerCopy({ kind: 'browser page', url: 'https://www.cellarbrations.com.au/sm/planning/rsid/8159/results?q=beer', status: 200, body }, 5000);
    expect(out).not.toContain('secret');
    expect(out).toContain('"name":"Beer"');
    expect(out).toContain('(cut short)');
  });

  it('0.10.8: takes out names, emails and phone numbers wherever they are', () => {
    const body = JSON.stringify({
      FirstName: 'Declan',
      Greeting: 'Hi Declan',
      Note: 'Contact a@b.com.au or 0412 345 678',
      Products: [{ Name: 'Milk 2L', Stockcode: 123456 }],
    });
    const out = shopAnswerCopy({
      kind: 'browser fetch',
      url: 'https://www.woolworths.com.au/apis/x',
      status: 200,
      body,
    });
    expect(out).not.toContain('Declan');
    expect(out).not.toContain('a@b.com.au');
    expect(out).not.toContain('0412 345 678');
    expect(out).toContain('Milk 2L');
    expect(out).toContain('123456');
    const page = shopAnswerCopy({
      kind: 'browser page',
      url: 'https://www.iga.com.au/x',
      status: 200,
      body: '<p>Signed in as me@home.net, +61 412 345 678</p>',
    });
    expect(page).not.toContain('me@home.net');
    expect(page).not.toContain('412 345 678');
  });
});
