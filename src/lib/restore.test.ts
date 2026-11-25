import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addCard,
  addGroup,
  addListEntry,
  addProduct,
  addReading,
  allCards,
  allListEntries,
  allReceipts,
  ensureDefaults,
  eraseEverything,
  getKV,
  getSettings,
  initDb,
  pruneHistory,
  putKV,
  readingsFor,
  resetSettings,
  restoreParts,
  restoreSnapshot,
  saveReceipt,
  updateSettings,
  type Snapshot,
} from './db';
import { backupJson, EVERYTHING, readBackup } from './backup';
import { tidyReceipts } from './receipts';
import { createSqlJsDriver } from './sql/sqljs';
import type { Group, LoyaltyCard, Receipt } from '../types';

// 0.9.0: restoring a backup only touches what it should, and odd values from a file can't do harm.

beforeEach(async () => {
  await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
  await ensureDefaults();
});

const card = (id: string, number: string): LoyaltyCard => ({ id, program: 'flybuys', label: id, number, createdAt: '2026-11-01T00:00:00Z' });
const item = (id: string, section: Group['section'], productId: string): Group => ({
  id,
  name: id,
  usualProductId: productId,
  sameProductIds: [],
  altProductIds: [],
  alertLevel: 'good',
  section,
  createdAt: '',
});
const empty = (): Snapshot => ({ products: [], groups: [], prices: [], list: [], cards: [], categories: [], kv: [], receipts: [] });
const none = { pantry: false, list: false, cards: false, settings: false };

describe('restoring loyalty cards', () => {
  it('on this phone only, replaces the cards (as before)', async () => {
    await addCard(card('mine', '111'));
    await restoreParts({ ...empty(), cards: [card('backup', '222')] }, { ...none, cards: true });
    expect((await allCards()).map((c) => c.id)).toEqual(['backup']);
  });

  it('for the household, adds the backup’s cards and removes nobody’s', async () => {
    await addCard(card('mine', '111'));
    await addCard(card('sarahs', '333'));
    await restoreParts({ ...empty(), cards: [card('backup', '222'), card('mine', '999')] }, { ...none, cards: true }, new Map(), { household: true });
    const cards = await allCards();
    expect(cards.map((c) => c.id).sort()).toEqual(['backup', 'mine', 'sarahs']);
    expect(cards.find((c) => c.id === 'mine')?.number).toBe('999');
  });
});

describe('restoring shopping lists', () => {
  it('replaces only the tabs the backup has lines for', async () => {
    await addListEntry({ id: 'here-pantry', text: 'Bread', section: 'pantry', checked: false, createdAt: '' });
    await addListEntry({ id: 'here-keg', text: 'Ginger beer', section: 'keg', checked: false, createdAt: '' });
    const backup = { ...empty(), list: [{ id: 'old-pantry', text: 'Milk', section: 'pantry' as const, checked: false, createdAt: '' }] };
    await restoreParts(backup, { ...none, list: true });
    expect((await allListEntries()).map((e) => e.id).sort()).toEqual(['here-keg', 'old-pantry']);
  });

  it('also clears the list of a tab whose items are restored', async () => {
    await addProduct({ id: 'p-keg', chain: 'bws', name: 'Lager', storeProductId: '1', createdAt: '' });
    await addGroup(item('keg-item', 'keg', 'p-keg'));
    await addListEntry({ id: 'here-keg', text: 'Lager', groupId: 'keg-item', checked: false, createdAt: '' });
    await addListEntry({ id: 'here-pharmacy', text: 'Plasters', section: 'pharmacy', checked: false, createdAt: '' });
    const backup = { ...empty(), products: [{ id: 'p-keg', chain: 'bws' as const, name: 'Lager', storeProductId: '1', createdAt: '' }], groups: [item('keg-item', 'keg', 'p-keg')] };
    await restoreParts(backup, { pantry: true, sections: ['keg'], list: true, cards: false, settings: false });
    expect((await allListEntries()).map((e) => e.id)).toEqual(['here-pharmacy']);
  });

  it('keeps a line on its tab when its item doesn’t come back', async () => {
    const backup = {
      ...empty(),
      groups: [item('keg-item', 'keg', 'p-keg')],
      list: [{ id: 'line', text: 'Lager', groupId: 'keg-item', checked: false, createdAt: '' }],
    };
    await restoreParts(backup, { ...none, list: true });
    const [line] = await allListEntries();
    expect(line.groupId).toBeUndefined();
    expect(line.section).toBe('keg');
  });
});

describe('receipt photos from a backup', () => {
  const receipt = (id: string, photo?: string, pages?: string[]): Receipt => ({
    id,
    scannedAt: '2026-11-01T00:00:00Z',
    section: 'pantry',
    pinned: false,
    photo,
    pages,
  });

  it('only keeps paths a receipt photo really has', async () => {
    const backup = {
      ...empty(),
      receipts: [
        receipt('good', 'receipts/good.jpg', ['receipts/good-2.jpg', '../backups/before-joining.json', 'receipts/x.png']),
        receipt('bad', '../../databases/restock.db', ['/etc/passwd']),
      ],
    };
    await restoreParts(backup, { ...none, receipts: true });
    const byId = new Map((await allReceipts()).map((r) => [r.id, r]));
    expect(byId.get('good')?.photo).toBe('receipts/good.jpg');
    expect(byId.get('good')?.pages).toEqual(['receipts/good-2.jpg']);
    expect(byId.get('bad')?.photo).toBeUndefined();
    expect(byId.get('bad')?.pages).toBeUndefined();
    // The whole-backup restore checks them too.
    await restoreSnapshot(backup);
    expect((await allReceipts()).find((r) => r.id === 'bad')?.photo).toBeUndefined();
  });
});

describe('odd settings can’t delete things', () => {
  it('keeps every price for a nonsense history length', async () => {
    await addProduct({ id: 'p', chain: 'coles', name: 'Milk', storeProductId: '1', createdAt: '' });
    for (const date of ['2025-01-01T00:00:00Z', '2025-06-01T00:00:00Z', '2026-11-01T00:00:00Z'])
      await addReading({ productId: 'p', date, price: 2, isSpecial: false, memberOnly: false, source: 'auto' });
    const now = Date.parse('2026-11-09T00:00:00Z');
    for (const weeks of [-3, 0, NaN, 1e9, 5]) expect(await pruneHistory(weeks, now)).toBe(0);
    expect((await readingsFor(['p'])).get('p')).toHaveLength(3);
    expect(await pruneHistory(8, now)).toBe(2);
  });

  it('keeps every receipt for a nonsense keep time', async () => {
    await saveReceipt({ id: 'r', scannedAt: '2020-01-01T00:00:00Z', section: 'pantry', pinned: false });
    const s = await getSettings();
    for (const keepMonths of [-1, 0, 1.5, 999]) expect(await tidyReceipts({ ...s, receipts: { ...s.receipts, keepMonths } })).toBe(0);
    expect(await allReceipts()).toHaveLength(1);
    expect(await tidyReceipts({ ...s, receipts: { ...s.receipts, keepMonths: 3 } })).toBe(1);
  });

  it('fixes damaged saved settings when they are read', async () => {
    await putKV('settings', { onboarded: true, look: { accent: 5 }, receipts: { keepMonths: -1 }, historyWeeks: -3, enabledChains: null });
    const s = await getSettings();
    expect(s.onboarded).toBe(true);
    expect(s.look.accent).toBeUndefined();
    expect(s.receipts.keepMonths).toBe(3);
    expect(s.historyWeeks).toBe(8);
    expect(s.enabledChains).toEqual(['woolworths', 'coles', 'aldi']);
  });
});

describe('Reset settings (the something-went-wrong screen)', () => {
  it('puts the settings back and keeps everything else', async () => {
    await updateSettings({ onboarded: true, theme: 'dark', historyWeeks: 26, privacyAccepted: '9 November 2026' });
    await addCard(card('mine', '111'));
    await addListEntry({ id: 'l', text: 'Bread', checked: false, createdAt: '' });
    const s = await resetSettings();
    expect(s.theme).toBe('system');
    expect(s.historyWeeks).toBe(8);
    expect(s.onboarded).toBe(true);
    expect(s.privacyAccepted).toBe('9 November 2026');
    expect(await allCards()).toHaveLength(1);
    expect(await allListEntries()).toHaveLength(1);
  });

  it('works even when the saved settings can’t be read', async () => {
    await putKV('settings', 'not settings at all');
    expect((await resetSettings()).theme).toBe('system');
  });
});

describe('Erase everything', () => {
  it('also forgets what the app kept in browser storage', async () => {
    const stores = ['localStorage', 'sessionStorage'] as const;
    const g = globalThis as unknown as Record<string, unknown>;
    const cleared: string[] = [];
    for (const name of stores) g[name] = { clear: () => cleared.push(name) };
    try {
      await updateSettings({ onboarded: true });
      await eraseEverything();
      expect(cleared).toEqual(['localStorage', 'sessionStorage']);
      expect((await getSettings()).onboarded).toBe(false);
    } finally {
      for (const name of stores) delete g[name];
    }
  });
});

describe('shared prices in a backup', () => {
  it('only has the tabs in the file, and only prices Restock read from the shop', async () => {
    await addProduct({ id: 'milk', chain: 'coles', name: 'Milk 2L', storeProductId: '123', createdAt: '' });
    await addProduct({ id: 'beer', chain: 'bws', name: 'Lager', storeProductId: '456', createdAt: '' });
    await addProduct({ id: 'typed', chain: 'coles', name: "Mum's tablets", createdAt: '' });
    await addGroup(item('milk-item', 'pantry', 'milk'));
    await addGroup(item('beer-item', 'keg', 'beer'));
    await addGroup(item('typed-item', 'pantry', 'typed'));
    const read = (productId: string, price: number, source: 'auto' | 'manual') =>
      addReading({ productId, date: '2026-11-08T09:15:00Z', price, isSpecial: false, memberOnly: false, source });
    await read('milk', 3.1, 'auto');
    await read('milk', 2.5, 'manual');
    await read('beer', 54, 'auto');
    await read('typed', 9, 'manual');
    const file = JSON.parse(await backupJson({ ...EVERYTHING, sections: ['pantry'] })) as { sharedPrices: { products: { name: string; prices: { price: number }[] }[] } };
    expect(file.sharedPrices.products.map((p) => p.name)).toEqual(['Milk 2L']);
    expect(file.sharedPrices.products[0].prices.map((p) => p.price)).toEqual([3.1]);
  });
});

describe('settings in a backup', () => {
  it('are checked strictly when restored, and the phone’s own sign-ins stay', async () => {
    await updateSettings({ accounts: { woolworths: { signedIn: false } } });
    const raw = JSON.parse(await backupJson(EVERYTHING)) as { tables: Snapshot };
    const settings = raw.tables.kv.find((k) => k.key === 'settings')!;
    settings.value = {
      ...(settings.value as object),
      theme: 'dark',
      historyWeeks: -3,
      accounts: { woolworths: { signedIn: true } },
      customShops: [{ id: 'custom-x1', name: 'Odd', website: 'https://www.odd.com.au', section: 'pantry', search: 'https://elsewhere.example/?q={q}', createdAt: '' }],
      enabledChains: ['coles', 'custom-x1'],
    };
    const summary = readBackup(JSON.stringify(raw));
    await restoreParts(summary.snapshot, { ...none, settings: true, shops: true });
    const s = await getSettings();
    expect(s.theme).toBe('dark');
    expect(s.historyWeeks).toBe(8);
    expect(s.accounts?.woolworths?.signedIn).toBe(false);
    expect(s.customShops).toEqual([]);
    expect(s.enabledChains).toEqual(['coles']);
    // What's saved is already checked, not only what's read back.
    const saved = (await getKV<Record<string, unknown>>('settings'))!;
    expect(saved.historyWeeks).toBe(8);
    expect(saved.customShops).toEqual([]);
  });
});
