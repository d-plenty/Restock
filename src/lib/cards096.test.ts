import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { backupJson, EVERYTHING, importBackup, readBackup, restoreBackup } from './backup';
import { readCardPhoto, writeCardPhoto } from './cardPhotos';
import { phoneCards } from './cardStore';
import { csvFiles } from './csvExport';
import { addCard, allCards, allGiftCards, deleteGiftCard, ensureDefaults, initDb, queryRows, restoreParts, saveGiftCard, snapshot } from './db';
import { MIGRATIONS, migrate, SYNCED_093 } from './sql/schema';
import { createSqlJsDriver } from './sql/sqljs';
import { sharedPrices } from './sharedPrices';
import { undo } from './undo';
import type { GiftCard, LoyaltyCard } from '../types';

// 0.9.6 (cards): gift cards on the phone: kept here only, in the person's own backups, never synced.
// Sample cards only (made-up numbers).

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
});

describe('gift cards on the phone', () => {
  it('are kept, changed and removed', async () => {
    await saveGiftCard(gift());
    await saveGiftCard(gift({ balance: 20, updatedAt: '2026-11-02T00:00:00.000Z' }));
    expect(await allGiftCards()).toEqual([expect.objectContaining({ id: 'gift-1', balance: 20, pin: PIN })]);
    await deleteGiftCard('gift-1');
    expect(await allGiftCards()).toEqual([]);
  });

  it('are never noted for sync, so they never reach other phones, a folder or a server', async () => {
    await saveGiftCard(gift());
    expect(await queryRows("SELECT * FROM sync_log WHERE tbl = 'gift_cards'")).toEqual([]);
    expect(SYNCED_093.map((t) => t.table)).not.toContain('gift_cards');
    // A Restock server builds household.db from MIGRATIONS only: no gift card table there at all.
    const d = await createSqlJsDriver({ load: () => initSqlJs() });
    await migrate(d);
    expect(await d.query("SELECT name FROM sqlite_master WHERE name = 'gift_cards'")).toEqual([]);
    expect(MIGRATIONS.flat().join('\n')).not.toContain('gift_cards');
  });

  it('come back with Undo after a remove, photos too', async () => {
    await writeCardPhoto('cards/gift-1-front.jpg', 'AAAA');
    await phoneCards.saveGift(gift({ photoFront: 'cards/gift-1-front.jpg' }), 'Bunnings added');
    await phoneCards.removeGift(gift({ photoFront: 'cards/gift-1-front.jpg' }));
    expect(await allGiftCards()).toEqual([]);
    expect(await readCardPhoto('cards/gift-1-front.jpg')).toBeUndefined();
    await undo();
    expect((await allGiftCards()).map((g) => g.id)).toEqual(['gift-1']);
    expect(await readCardPhoto('cards/gift-1-front.jpg')).toBe('AAAA');
  });

  it('keep photos at card photo paths only', async () => {
    await expect(writeCardPhoto('receipts/x.jpg', 'AAAA')).rejects.toThrow();
    await expect(writeCardPhoto('cards/../../db.sqlite', 'AAAA')).rejects.toThrow();
    expect(await readCardPhoto('../secret')).toBeUndefined();
  });
});

describe('backups (for the person themself) have the Cards part', () => {
  it('puts gift cards apart from loyalty cards, with their photos, and brings them back', async () => {
    await addCard(flybuys);
    await writeCardPhoto('cards/gift-1-back.jpg', 'QkFDSw==');
    await saveGiftCard(gift({ photoBack: 'cards/gift-1-back.jpg' }));
    const json = await backupJson(EVERYTHING);
    const file = JSON.parse(json);
    // Loyalty cards stay exactly as 0.9.5 reads them; gift cards have their own key.
    expect(file.tables.cards).toEqual([flybuys]);
    expect(file.tables.giftCards).toHaveLength(1);
    expect(file.cardPhotos).toEqual({ 'cards/gift-1-back.jpg': 'QkFDSw==' });
    // Receipt photos (`photos`) never carry a card photo.
    expect(Object.keys(file.photos ?? {})).toEqual([]);

    const summary = readBackup(json);
    expect(summary.counts).toMatchObject({ cards: 2, giftCards: 1 });

    // A fresh phone.
    await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
    await ensureDefaults();
    await restoreBackup(summary, { pantry: false, list: false, cards: true, settings: false });
    expect(await allCards()).toEqual([flybuys]);
    expect(await allGiftCards()).toEqual([expect.objectContaining({ id: 'gift-1', pin: PIN, photoBack: 'cards/gift-1-back.jpg' })]);
    expect(await readCardPhoto('cards/gift-1-back.jpg')).toBe('QkFDSw==');
  });

  it('leaves the Cards part out when it isn’t picked', async () => {
    await saveGiftCard(gift());
    const json = await backupJson({ ...EVERYTHING, cards: false });
    expect(json).not.toContain(PIN);
    expect(JSON.parse(json).tables.giftCards).toEqual([]);
  });

  it('never puts a card number or PIN in the spreadsheet files or the shared price pack', async () => {
    await addCard(flybuys);
    await saveGiftCard(gift());
    const s = await snapshot();
    const text = csvFiles(s).map((f) => f.text).join('\n') + JSON.stringify(sharedPrices(s));
    expect(text).not.toContain(NUMBER);
    expect(text).not.toContain(PIN);
    expect(text).not.toContain(flybuys.number);
  });

  it('restores a 0.9.5 backup (loyalty cards only) into Cards, leaving gift cards here alone', async () => {
    await saveGiftCard(gift());
    const old = JSON.stringify({
      app: 'restock',
      version: 2,
      exportedAt: '2026-11-10T00:00:00.000Z',
      parts: { pantry: false, list: false, cards: true, settings: false, prices: false },
      tables: { products: [], groups: [], prices: [], list: [], cards: [flybuys], categories: [], kv: [], receipts: [] },
    });
    const summary = readBackup(old);
    expect(summary.counts).toMatchObject({ cards: 1, giftCards: 0 });
    await restoreBackup(summary, { pantry: false, list: false, cards: true, settings: false });
    expect(await allCards()).toEqual([flybuys]);
    expect((await allGiftCards()).map((g) => g.id)).toEqual(['gift-1']);
    // And "replace everything" with it works too.
    await importBackup(old);
    expect(await allCards()).toEqual([flybuys]);
  });

  it('a 0.9.5 phone reading a 0.9.6 backup only finds loyalty cards where it looks', async () => {
    await addCard(flybuys);
    await saveGiftCard(gift());
    const file = JSON.parse(await backupJson(EVERYTHING));
    // What 0.9.5's readBackup / importBackup take from the file: the keys it knows.
    const t = file.tables;
    const as095 = { products: t.products, groups: t.groups, prices: t.prices, list: t.list, cards: t.cards, categories: t.categories, kv: t.kv, receipts: t.receipts };
    for (const c of as095.cards) expect(Object.keys(c).sort()).toEqual(['createdAt', 'id', 'label', 'number', 'program']);
    await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
    await ensureDefaults();
    await restoreParts(as095, { pantry: false, list: false, cards: true, settings: false });
    expect(await allCards()).toEqual([flybuys]);
  });

  it('for the household: adds the backup’s gift cards, removes none', async () => {
    await saveGiftCard(gift({ id: 'here' }));
    await restoreParts({ ...(await snapshot()), cards: [], giftCards: [gift({ id: 'from-backup' })] }, { pantry: false, list: false, cards: true, settings: false }, new Map(), {
      household: true,
    });
    expect((await allGiftCards()).map((g) => g.id).sort()).toEqual(['from-backup', 'here']);
  });
});
