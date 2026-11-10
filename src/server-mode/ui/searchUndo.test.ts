import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { addGroup, addListEntry, addProduct, addReading, allGroups, allListEntries, ensureDefaults, getProducts, initDb, nowIso, readingsFor, updateListEntry } from '../../lib/db';
import { createSqlJsDriver } from '../../lib/sql/sqljs';
import { clearUndo, lastStep, undo } from '../../lib/undo';
import { offerUndo, productIdsHere } from './searchUndo';

// 0.9.5 (final review): adding from "Let the web page search the shops" gets an Undo. The server
// makes the item, products, prices and line; here they arrive by sync (made directly below, as a
// sync would), and Undo takes them away with ordinary writes. Products that were here stay.

beforeEach(async () => {
  await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
  await ensureDefaults();
  clearUndo();
});

/** What the server's add made, as this browser has it after the sync. */
async function serverMade(opts: { reuse?: string; line?: boolean }) {
  const ids = ['p-new', ...(opts.reuse ? [opts.reuse] : [])];
  await addProduct({ id: 'p-new', chain: 'coles', name: 'Bamboo Chopsticks 40 pack', createdAt: nowIso() });
  await addReading({ productId: 'p-new', date: nowIso(), price: 3.5, isSpecial: false, memberOnly: false, source: 'auto' });
  await addGroup({ id: 'i-new', name: 'Chopsticks', usualProductId: ids[0], sameProductIds: ids.slice(1), altProductIds: [], alertLevel: 'good', section: 'pantry', createdAt: nowIso() });
  if (opts.line) await addListEntry({ id: 'l-new', text: 'Chopsticks', groupId: 'i-new', qty: 1, section: 'pantry', checked: false, createdAt: nowIso() });
  return { item: { id: 'i-new', name: 'Chopsticks', section: 'pantry' as const }, products: ids, line: opts.line ? { id: 'l-new' } : null };
}

describe('web search adds: Undo', () => {
  it('Track and Add to list: one Undo takes the item, its new products, prices and line away', async () => {
    const had = await productIdsHere();
    const a = await serverMade({ line: true });
    const said = await offerUndo(a, had, async () => 'Chopsticks added to your pantry and shopping list');
    expect(said).toBe('Chopsticks added to your pantry and shopping list');
    expect(lastStep()?.label).toBe('Chopsticks added to your pantry and shopping list');
    await undo();
    expect((await allGroups()).some((g) => g.id === 'i-new')).toBe(false);
    expect(await allListEntries()).toEqual([]);
    expect(await getProducts(['p-new'])).toEqual([]);
    expect((await readingsFor(['p-new'])).get('p-new') ?? []).toEqual([]);
  });

  it('a product that was here before stays, with its prices', async () => {
    await addProduct({ id: 'p-old', chain: 'aldi', name: 'Chopsticks 50 pack', createdAt: nowIso() });
    await addReading({ productId: 'p-old', date: '2026-10-01T00:00:00.000Z', price: 2.99, isSpecial: false, memberOnly: false, source: 'auto' });
    const had = await productIdsHere();
    const a = await serverMade({ reuse: 'p-old' });
    await offerUndo(a, had, async () => 'Chopsticks added to your pantry');
    await undo();
    expect((await allGroups()).some((g) => g.id === 'i-new')).toBe(false);
    expect((await getProducts(['p-old'])).map((p) => p.id)).toEqual(['p-old']);
    expect((await readingsFor(['p-old'])).get('p-old')?.map((r) => r.price)).toEqual([2.99]);
    expect(await getProducts(['p-new'])).toEqual([]);
  });

  it('the Pick sheet: the line goes back to the words it was, and the new item goes', async () => {
    await addListEntry({ id: 'ha-1', text: 'chopsticks', qty: 1, section: 'pantry', checked: false, createdAt: nowIso() });
    const had = await productIdsHere();
    const a = await serverMade({});
    await offerUndo(a, had, async () => {
      await updateListEntry('ha-1', { groupId: 'i-new', text: 'Chopsticks' });
      return 'Chopsticks added to your pantry';
    });
    await undo();
    const [l] = await allListEntries();
    expect(l).toMatchObject({ id: 'ha-1', text: 'chopsticks' });
    expect(l.groupId).toBeUndefined();
    expect((await allGroups()).some((g) => g.id === 'i-new')).toBe(false);
  });
});
