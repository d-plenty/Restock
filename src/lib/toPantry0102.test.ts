import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addGroup, addListEntry, allListEntries, ensureDefaults, initDb } from './db';
import { createSqlJsDriver } from './sql/sqljs';
import { pickItemFor } from './listPicks';
import { clearUndo } from './undo';
import { toPantryNote } from '../ui/screens/addPickWords';
import type { Group, ListEntry } from '../types';

// 0.10.2: a line added to the list only (a one-off buy, at the shop its product was cheapest) can go
// in the pantry from its sheet. As an item, its line goes to whichever shop is cheapest.

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
beforeEach(async () => {
  const driver = await createSqlJsDriver({ load: async () => SQL });
  await initDb(driver);
  await ensureDefaults();
  clearUndo();
});

const group = (id: string, name: string): Group => ({ id, name, sameProductIds: [], altProductIds: [], alertLevel: 'good', section: 'pantry', createdAt: '2026-11-13T00:00:00.000Z' });
const eggs: ListEntry = {
  id: 'e1',
  text: 'Eggs',
  chain: 'aldi',
  price: 6.19,
  section: 'pantry',
  product: { chain: 'aldi', name: 'Farm Eggs Free Range 12 Pack', storeProductId: '123' },
  checked: false,
  createdAt: '2026-11-13T00:00:00.000Z',
};

describe('Add to pantry from a list line (0.10.2)', () => {
  it('a one-off buy becomes the item, at whichever shop is cheapest', async () => {
    await addGroup(group('g-eggs', 'Eggs'));
    await addListEntry(eggs);
    expect(await pickItemFor((await allListEntries())[0], { id: 'g-eggs', name: 'Eggs' }, false)).toBe(true);
    const [l] = await allListEntries();
    expect(l).toMatchObject({ id: 'e1', groupId: 'g-eggs', text: 'Eggs' });
    expect(l.chain).toBeUndefined();
    expect(l.price).toBeUndefined();
  });

  it('a line you typed keeps the shop you chose for it', async () => {
    await addGroup(group('g-milk', 'Milk'));
    await addListEntry({ id: 'm1', text: 'milk', chain: 'coles', section: 'pantry', checked: false, createdAt: '2026-11-13T00:00:00.000Z' });
    await pickItemFor((await allListEntries())[0], { id: 'g-milk', name: 'Milk' }, false);
    expect((await allListEntries())[0]).toMatchObject({ groupId: 'g-milk', chain: 'coles' });
  });

  it('says the line stays on the list', () => {
    expect(toPantryNote('your pantry')).toContain('stays on your list');
  });
});
