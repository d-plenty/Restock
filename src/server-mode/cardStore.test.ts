import { describe, expect, it } from 'vitest';
import type { GiftCard } from '../types';
import { askKeepCards, browserCards, memoryBackend, type Ask } from './cardStore';
import { WEB_CARDS_NOTE } from './ui/DeskCards';
import { SERVER_LEAVES_OUT, WEB_LEAVES_OUT } from './engine';

// 0.9.6 (cards): the web page's cards, in this browser only. Sample cards only.

const gift = (over: Partial<GiftCard> = {}): GiftCard => ({
  id: 'g1',
  name: 'Myer',
  barcodeType: 'QR',
  barcode: 'MYER-0001',
  pin: '1234',
  colour: 'red',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

describe("the web's cards (this browser only)", () => {
  it('keeps loyalty and gift cards, photos and drawn codes, and says when they change', async () => {
    const store = browserCards(memoryBackend());
    let changes = 0;
    store.onChange(() => changes++);
    await store.addLoyalty({ id: 'l1', program: 'everyday', label: 'Everyday Rewards', number: '9355 0000 1111', createdAt: '2026-11-02T00:00:00.000Z' });
    const front = await store.writePhoto('g1', 'front', 'AAAA');
    await store.saveGift(gift({ photoFront: front }), 'Myer added');
    expect(await store.loyalty()).toEqual([expect.objectContaining({ number: '935500001111' })]);
    expect(await store.gifts()).toEqual([expect.objectContaining({ id: 'g1', pin: '1234', photoFront: 'g1:front' })]);
    expect(await store.readPhoto('g1:front')).toBe('AAAA');
    expect(await store.readPhoto('../g1:front')).toBeUndefined();
    await store.codeCache!.set('qr:MYER-0001', '<svg/>');
    expect(await store.codeCache!.get('qr:MYER-0001')).toBe('<svg/>');
    expect(await store.count()).toBe(2);
    await store.removeGift((await store.gifts())[0]);
    expect(await store.readPhoto('g1:front')).toBeUndefined();
    await store.removeAll();
    expect(await store.count()).toBe(0);
    expect(changes).toBeGreaterThanOrEqual(4);
    expect(store.where).toBe('browser');
    expect(store.canRemind).toBe(false);
  });

  it('turns away a card it can’t keep, and a photo that’s too big', async () => {
    const store = browserCards(memoryBackend());
    await expect(store.saveGift({ ...gift(), id: '../x' }, 'x')).rejects.toThrow();
    await expect(store.writePhoto('g1', 'back', 'A'.repeat(5 * 1024 * 1024))).rejects.toThrow('too big');
  });

  it('cards are never part of what the web sends the server', () => {
    // The browser's cards aren't in the sync engine's tables at all; and the phones' shared
    // loyalty cards stay out of the web's own file and the server's.
    expect(WEB_LEAVES_OUT).toContain('cards');
    expect(SERVER_LEAVES_OUT).toContain('cards');
    expect(WEB_CARDS_NOTE).toBe('Cards in the web page are kept only in this browser; they are not sent to the server.');
  });
});

describe('signing out: "Keep your cards on this phone/browser?"', () => {
  const record = (answer: string | undefined) => {
    const asked: Parameters<Ask>[] = [];
    const ask: Ask = async (...a) => (asked.push(a), answer);
    return { ask, asked };
  };
  const some = { count: async () => 3 };

  it('asks nothing when this browser has no cards', async () => {
    const r = record('remove');
    expect(await askKeepCards(r.ask, { count: async () => 0 }, true)).toBe('keep');
    expect(r.asked).toHaveLength(0);
  });

  it('on the iPhone home screen app, Keep is the first answer', async () => {
    const r = record('keep');
    expect(await askKeepCards(r.ask, some, true)).toBe('keep');
    const [title, detail, choices] = r.asked[0];
    expect(title).toBe('Keep your cards on this phone?');
    expect(detail).toContain('kept only in this browser; they are not sent to the server');
    expect(choices.map((c) => c.id)).toEqual(['keep', 'remove', 'stay']);
    expect(choices[0].kind).toBe('primary');
  });

  it('in a browser, Remove is the first answer; closing the question stays signed in', async () => {
    const r = record(undefined);
    expect(await askKeepCards(r.ask, some, false)).toBe('stay');
    expect(r.asked[0][0]).toBe('Keep your cards on this browser?');
    expect(r.asked[0][2].map((c) => c.id)).toEqual(['remove', 'keep', 'stay']);
    expect(await askKeepCards(record('remove').ask, some, false)).toBe('remove');
  });
});
