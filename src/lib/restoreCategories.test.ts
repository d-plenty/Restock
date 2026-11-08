import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { addCategory, addGroup, allCategories, ensureDefaults, initDb, restoreParts, snapshot } from './db';
import { createSqlJsDriver } from './sql/sqljs';

async function freshPhone() {
  await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
  await ensureDefaults();
}

describe('restoring onto a new phone', () => {
  it("doesn't double up the categories", async () => {
    // The old phone: the starting categories plus one of its own, with an item in it.
    await freshPhone();
    await addCategory('Snacks');
    const snacks = (await allCategories()).find((c) => c.name === 'Snacks')!;
    await addGroup({
      id: 'g1',
      name: 'Chips',
      categoryId: snacks.id,
      usualProductId: undefined,
      sameProductIds: [],
      altProductIds: [],
      alertLevel: 'good',
      createdAt: '',
    });
    const backup = JSON.parse(JSON.stringify(await snapshot()));
    const oldNames = (await allCategories()).map((c) => c.name).sort();

    // The new phone already has its own starting categories (different ids) when the backup goes on.
    await freshPhone();
    expect((await allCategories()).length).toBeGreaterThan(0);
    await restoreParts(backup, { pantry: true, list: false, cards: false, settings: false });
    expect((await allCategories()).map((c) => c.name).sort()).toEqual(oldNames);
  });

  it('keeps a category a shopping list line still uses', async () => {
    await freshPhone();
    const backup = JSON.parse(JSON.stringify(await snapshot()));
    await freshPhone();
    const [mine] = await allCategories();
    const { addListEntry } = await import('./db');
    await addListEntry({ id: 'l1', text: 'Bread', qty: 1, checked: false, categoryId: mine.id, createdAt: '' });
    await restoreParts(backup, { pantry: true, list: false, cards: false, settings: false });
    expect((await allCategories()).some((c) => c.id === mine.id)).toBe(true);
  });
});
