import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { addCard, addGroup, addListEntry, addProduct, addReading, allCards, allGroups, allListEntries, ensureDefaults, getSettings, initDb, lastAddCounts, readingsFor, restoreParts, updateSettings, type Snapshot } from './db';
import { backupJson, EVERYTHING } from './backup';
import { createSqlJsDriver } from './sql/sqljs';
import type { Group, ListEntry, LoyaltyCard, Product } from '../types';

// 0.14.0: Import data → "Add alongside what's here": nothing on the phone is replaced or removed, and
// anything with the same name as something already here is skipped.

beforeEach(async () => {
  await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
  await ensureDefaults();
});

const product = (id: string): Product => ({ id, chain: 'coles', name: id, createdAt: '2026-11-01T00:00:00Z' }) as Product;
const item = (id: string, name: string, productId: string, section: Group['section'] = 'pantry'): Group => ({ id, name, usualProductId: productId, sameProductIds: [], altProductIds: [], alertLevel: 'good', section, createdAt: '' });
const line = (id: string, text: string, groupId?: string): ListEntry => ({ id, text, groupId, checked: false, createdAt: '2026-11-02T00:00:00Z', qty: 1 }) as ListEntry;
const card = (id: string, number: string): LoyaltyCard => ({ id, program: 'flybuys', label: id, number, createdAt: '2026-11-01T00:00:00Z' });
const price = (productId: string, p: number, source: 'auto' | 'manual' = 'auto') => ({ productId, date: '2026-11-03', price: p, isSpecial: false, memberOnly: false, source });
const empty = (): Snapshot => ({ products: [], groups: [], prices: [], list: [], cards: [], categories: [], kv: [], receipts: [] });
const all = { pantry: true, list: true, cards: true, settings: true, receipts: true };

describe('0.14.0: Import data, adding alongside what is here', () => {
  it('adds what is new, skips what has the same name, and removes nothing', async () => {
    await addProduct(product('p-milk'));
    await addGroup(item('g-milk', 'Milk', 'p-milk'));
    await addReading(price('p-milk', 3));
    await addListEntry(line('l-eggs', 'Eggs'));
    await addCard(card('c-mine', '111'));
    await updateSettings({ household: { ...(await getSettings()).household, name: 'Mine' } });

    const file: Snapshot = {
      ...empty(),
      products: [product('q-milk'), product('q-jam')],
      groups: [item('h-milk', 'milk ', 'q-milk'), item('h-jam', 'Jam', 'q-jam')],
      prices: [price('q-milk', 9), price('q-jam', 4)],
      list: [line('m-eggs', 'eggs'), line('m-milk', 'x', 'h-milk'), line('m-jam', 'x', 'h-jam'), line('m-tea', 'Tea')],
      cards: [card('c-same', '1 1 1'), card('c-new', '222')],
      kv: [{ key: 'settings', value: { household: { name: 'Theirs' } } }],
    };
    await restoreParts(file, all, new Map(), { add: true });

    const groups = await allGroups();
    expect(groups.map((g) => g.name).sort()).toEqual(['Jam', 'Milk']);
    // This phone's Milk is untouched, prices and all; the file's Jam came with its price.
    expect(groups.find((g) => g.name === 'Milk')?.id).toBe('g-milk');
    const prices = await readingsFor(['p-milk', 'q-jam', 'q-milk']);
    expect(prices.get('p-milk')?.map((r) => r.price)).toEqual([3]);
    expect(prices.get('q-jam')?.map((r) => r.price)).toEqual([4]);
    expect(prices.get('q-milk')).toBeUndefined();

    const list = await allListEntries();
    // Eggs was here; Milk is new on the list and joined to this phone's Milk; Jam to the new Jam; Tea as words.
    expect(list.map((e) => e.id).sort()).toEqual(['l-eggs', 'm-jam', 'm-milk', 'm-tea']);
    expect(list.find((e) => e.id === 'm-milk')?.groupId).toBe('g-milk');
    expect(list.find((e) => e.id === 'm-jam')?.groupId).toBe('h-jam');

    expect((await allCards()).map((c) => c.id).sort()).toEqual(['c-mine', 'c-new']);
    // Settings are never changed by adding.
    expect((await getSettings()).household.name).toBe('Mine');
    expect(lastAddCounts()).toEqual({ added: { items: 1, lines: 3, cards: 1, receipts: 0 }, skipped: { items: 1, lines: 1, cards: 1, receipts: 0 } });

    // The same file again: nothing is added twice.
    await restoreParts(file, all, new Map(), { add: true });
    expect((await allGroups()).length).toBe(2);
    expect((await allListEntries()).length).toBe(4);
    expect((await allCards()).length).toBe(2);
    expect(lastAddCounts()?.added).toEqual({ items: 0, lines: 0, cards: 0, receipts: 0 });
  });

  it('a copy sent to someone else leaves out prices typed in by hand; a file you save keeps them', async () => {
    await addProduct(product('p-milk'));
    await addGroup(item('g-milk', 'Milk', 'p-milk'));
    await addReading(price('p-milk', 3, 'auto'));
    await addReading({ ...price('p-milk', 2.5, 'manual'), date: '2026-11-04' });
    const saved = JSON.parse(await backupJson(EVERYTHING)) as { tables: Snapshot; parts: Record<string, unknown> };
    expect(saved.tables.prices.map((r) => r.source).sort()).toEqual(['auto', 'manual']);
    const sent = JSON.parse(await backupJson({ ...EVERYTHING, noTypedPrices: true })) as { tables: Snapshot; parts: Record<string, unknown> };
    expect(sent.tables.prices.map((r) => r.source)).toEqual(['auto']);
    expect('noTypedPrices' in sent.parts && sent.parts.noTypedPrices !== undefined).toBe(false);
  });
});
