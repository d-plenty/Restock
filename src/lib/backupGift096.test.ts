import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { AUTO_GIFT_NOTE, autoParts } from './autoBackup';
import { backupJson, EVERYTHING, GIFT_NO_PASSWORD_WARNING, giftCardsUnlocked, importBackup, readBackup, restoreBackup } from './backup';
import { unlockBackup } from './backupLock';
import { writeCardPhoto } from './cardPhotos';
import { addCard, allCards, allGiftCards, ensureDefaults, initDb, restoreSnapshot, saveGiftCard } from './db';
import { createSqlJsDriver } from './sql/sqljs';
import type { GiftCard, LoyaltyCard } from '../types';

// 0.9.6 (review M3, L6): gift cards stay out of unlocked automatic backups, and a backup without
// gift cards never wipes the phone's. Sample cards only (made-up numbers).

const PIN = '7391';
const NUMBER = '6280004455667788';
const gift = (over: Partial<GiftCard> = {}): GiftCard => ({
  id: 'gift-1',
  name: 'Bunnings',
  barcode: NUMBER,
  barcodeType: 'CODE128',
  number: NUMBER,
  pin: PIN,
  balance: 50,
  colour: 'green',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});
const flybuys: LoyaltyCard = { id: 'loy-1', program: 'flybuys', label: 'Flybuys', number: '6008943212345678', createdAt: '2026-11-01T00:00:00.000Z' };

beforeEach(async () => {
  await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
  await ensureDefaults();
  await addCard(flybuys);
  await writeCardPhoto('cards/gift-1-front.jpg', 'RlJPTlQ=');
  await saveGiftCard(gift({ photoFront: 'cards/gift-1-front.jpg' }));
});

describe('automatic backups and gift cards', () => {
  it('without a password: loyalty cards in, gift cards (numbers, PINs, photos) out', async () => {
    const parts = autoParts({ enabled: true, everyDays: 7, keep: 5, folder: 'content://x' });
    expect(parts.giftCards).toBe(false);
    const json = await backupJson(parts);
    const file = JSON.parse(json);
    expect(file.tables.cards).toEqual([flybuys]);
    expect('giftCards' in file.tables).toBe(false);
    expect(file.cardPhotos).toBeUndefined();
    expect(json).not.toContain(PIN);
    expect(json).not.toContain(NUMBER);
    expect(json).not.toContain('RlJPTlQ=');
  });

  it('with a password: gift cards go in, locked', async () => {
    const parts = autoParts({ enabled: true, everyDays: 7, keep: 5, folder: 'content://x', password: 'correct horse' });
    expect(parts.giftCards).toBe(true);
    const locked = await backupJson(parts);
    expect(locked).not.toContain(PIN);
    const file = JSON.parse(await unlockBackup(locked, 'correct horse'));
    expect(file.tables.giftCards).toEqual([expect.objectContaining({ pin: PIN })]);
    expect(file.cardPhotos).toEqual({ 'cards/gift-1-front.jpg': 'RlJPTlQ=' });
  });

  it('restoring an automatic backup without gift cards leaves the phone’s gift cards alone', async () => {
    const json = await backupJson(autoParts({ enabled: true, everyDays: 7, keep: 5, folder: 'content://x' }));
    const summary = readBackup(json);
    expect(summary.counts).toMatchObject({ cards: 1, giftCards: 0 });
    await restoreBackup(summary, { pantry: false, list: false, cards: true, settings: false });
    expect(await allCards()).toEqual([flybuys]);
    expect((await allGiftCards()).map((g) => g.id)).toEqual(['gift-1']);
    await importBackup(json);
    expect((await allGiftCards()).map((g) => g.id)).toEqual(['gift-1']);
  });

  it('says so in the setting', () => {
    expect(AUTO_GIFT_NOTE).toBe('Gift cards are only included when the backup has a password.');
  });
});

describe('Export a backup: gift cards without a password', () => {
  it('warns only when gift cards are ticked, there are some, and no password is set', () => {
    expect(giftCardsUnlocked({ cards: true }, 1)).toBe(true);
    expect(giftCardsUnlocked({ cards: true, password: 'abcdefgh' }, 1)).toBe(false);
    expect(giftCardsUnlocked({ cards: false }, 1)).toBe(false);
    expect(giftCardsUnlocked({ cards: true }, 0)).toBe(false);
    expect(GIFT_NO_PASSWORD_WARNING).not.toMatch(/—/);
  });

  it('a manual export with Cards still has the gift cards', async () => {
    const file = JSON.parse(await backupJson(EVERYTHING));
    expect(file.tables.giftCards).toHaveLength(1);
  });
});

describe('restoreSnapshot (review L6)', () => {
  it('leaves gift cards alone when the backup has none, and replaces them when it has some', async () => {
    const empty = { products: [], groups: [], prices: [], list: [], cards: [], categories: [], kv: [], receipts: [] };
    await restoreSnapshot(empty);
    expect((await allGiftCards()).map((g) => g.id)).toEqual(['gift-1']);
    await restoreSnapshot({ ...empty, giftCards: [gift({ id: 'gift-2' })] });
    expect((await allGiftCards()).map((g) => g.id)).toEqual(['gift-2']);
    await restoreSnapshot({ ...empty, giftCards: [] });
    expect(await allGiftCards()).toEqual([]);
  });
});
