// 0.14.0: Export data → Send to another phone, and Import data → From another phone (handover.ts),
// over real sockets on this computer (ios/nodeLan.ts stands in for the phones' own).
import { describe, expect, it } from 'vitest';
import { nodeLan } from '../ios/nodeLan';
import { fetchData, isSendCode, offerData, SendProblem } from './handover';

describe('0.14.0: sending your data straight to another phone', () => {
  it('hands over the whole file, once, to the phone that scanned the code', async () => {
    const text = JSON.stringify({ app: 'restock', version: 2, big: 'x'.repeat(1_500_000), tail: 'Añejo ✓' });
    const seen: number[] = [];
    const offer = await offerData(nodeLan(), text, { name: "Declan's phone" }, (p) => seen.push(p));
    expect(isSendCode(offer.code)).toBe(true);
    expect(offer.code).toMatch(/^RESTOCK-SEND:1:[A-Z2-7]+:127\.0\.0\.1:\d+$/);
    const got = await fetchData(nodeLan(), offer.code.toLowerCase());
    expect(got.from).toBe("Declan's phone");
    expect(got.text).toBe(text);
    expect(await offer.done).toBe('sent');
    expect(seen[seen.length - 1]).toBe(1);
    // One use: the code doesn't work again.
    await new Promise((r) => setTimeout(r, 700));
    await expect(fetchData(nodeLan(), offer.code)).rejects.toBeInstanceOf(SendProblem);
  });

  it('gives nothing to a phone that has the address but not the code', async () => {
    const offer = await offerData(nodeLan(), '{"secret":true}', { name: 'A' });
    const wrong = offer.code.replace(/:1:[A-Z2-7]+:/, ':1:AAAAAAAAAAAAAAAAAAAAAAAAAA:');
    await expect(fetchData(nodeLan(), wrong)).rejects.toThrow(/stopped answering/);
    // The real code still works afterwards.
    expect((await fetchData(nodeLan(), offer.code)).text).toBe('{"secret":true}');
  });

  it('stops when the sender closes the code, and says so plainly for a wrong code', async () => {
    const offer = await offerData(nodeLan(), '{}', { name: 'A' });
    offer.stop();
    expect(await offer.done).toBe('stopped');
    await new Promise((r) => setTimeout(r, 50));
    await expect(fetchData(nodeLan(), offer.code)).rejects.toBeInstanceOf(SendProblem);
    await expect(fetchData(nodeLan(), 'RESTOCK:3:ABC:1.2.3.4:5')).rejects.toThrow(/isn't a code for receiving data/);
    expect(isSendCode('https://example.com')).toBe(false);
  });
});
