import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addCard,
  addGroup,
  addListEntry,
  addProduct,
  addReading,
  allCards,
  allGroups,
  allListEntries,
  checkEntriesOp,
  deleteCard,
  deleteGroup,
  deleteListEntries,
  ensureDefaults,
  initDb,
  runOps,
  saveReceipt,
  deleteReceipts,
  allReceipts,
  snapshot,
  updateGroup,
  updateListEntry,
} from './db';
import { loadDemo } from './demo';
import { addGroupToList } from './listActions';
import { createSqlJsDriver } from './sql/sqljs';
import { migrate } from './sql/schema';
import { act, background, clearUndo, lastStep, onUndo, undo, undoable, type UndoEvent } from './undo';
import { WebSyncEngine, type Entry } from '../server-mode/engine';
import { syncDbOf } from '../server-mode/sqldb';
import { signedText, verifySig } from '../server-mode/crypto';
import type { Group, ListEntry } from '../types';

// 0.9.5 (undo): one Undo for phone and web (undo.ts). Each kind of action goes back exactly, with
// the same ids; a bulk add goes back in one press; a change made on another phone since is kept;
// and an undone delete comes back on the other phones too.

let SQL: SqlJsStatic;
let raw: Awaited<ReturnType<typeof createSqlJsDriver>>['raw'];
beforeAll(async () => {
  SQL = await initSqlJs();
});
beforeEach(async () => {
  const driver = await createSqlJsDriver({ load: async () => SQL });
  raw = driver.raw;
  await initDb(driver);
  await ensureDefaults();
  clearUndo();
});

const line = (id: string, text: string, more: Partial<ListEntry> = {}): ListEntry => ({ id, text, checked: false, qty: 1, createdAt: '2026-11-10T00:00:00.000Z', ...more });
const group = (id: string, name: string, more: Partial<Group> = {}): Group => ({
  id,
  name,
  sameProductIds: [],
  altProductIds: [],
  alertLevel: 'good',
  section: 'pantry',
  createdAt: '2026-11-10T00:00:00.000Z',
  ...more,
});
const rows = (sql: string) => {
  const r = raw.exec(sql)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};
/** Everything an undo should put back, minus the tick's clock (an undone tick is stamped now). */
const listState = async () => (await allListEntries()).map((e) => ({ ...e }));
const tables = () => ({
  items: rows('SELECT * FROM items ORDER BY id'),
  products: rows('SELECT * FROM products ORDER BY id'),
  prices: rows('SELECT * FROM prices ORDER BY id'),
  list: rows('SELECT id, text, item_id, chain, category_id, qty, price, section, product, checked, created_at FROM list_entries ORDER BY id'),
  cards: rows('SELECT * FROM cards ORDER BY id'),
  receipts: rows('SELECT * FROM receipts ORDER BY id'),
  categories: rows('SELECT * FROM categories ORDER BY id'),
});

describe('undo: each kind of action goes back exactly', () => {
  it('add to list', async () => {
    const g = group('g1', 'Milk');
    await addGroup(g);
    const before = tables();
    await act('Milk added to your shopping list', () => addGroupToList(g));
    expect((await allListEntries()).length).toBe(1);
    expect(lastStep()?.label).toBe('Milk added to your shopping list');
    await undo();
    expect(tables()).toEqual(before);
    expect(lastStep()).toBeUndefined();
  });

  it('"Add all 32 to my list" goes back in one press', async () => {
    const gs = Array.from({ length: 32 }, (_, i) => group(`g${i}`, `Thing ${i}`));
    for (const g of gs) await addGroup(g);
    await addListEntry(line('keep', 'Bread'));
    const before = tables();
    const n = await act(
      (n: number) => `Added ${n} to your shopping list`,
      async () => {
        let n = 0;
        for (const g of gs) if (await addGroupToList(g)) n++;
        return n;
      },
    );
    expect(n).toBe(32);
    expect((await allListEntries()).length).toBe(33);
    expect(lastStep()?.label).toBe('Added 32 to your shopping list');
    const r = await undo();
    expect(r?.kept).toBe(0);
    expect(tables()).toEqual(before);
    expect((await allListEntries()).map((e) => e.id)).toEqual(['keep']);
  });

  it('nothing changed: no Undo offered', async () => {
    const g = group('g1', 'Milk');
    await addGroup(g);
    await addGroupToList(g);
    const added = await act(
      (ok: boolean) => (ok ? 'Added' : null),
      () => addGroupToList(g),
    );
    expect(added).toBe(false);
    expect(lastStep()).toBeUndefined();
  });

  it('tick and untick (the undo is stamped as the newer tick)', async () => {
    await addListEntry(line('l1', 'Milk'));
    const before = tables();
    await act('Ticked Milk', () => updateListEntry('l1', { checked: true }));
    const tickedAt = Number(rows("SELECT checked_at FROM list_entries WHERE id = 'l1'")[0].checked_at);
    expect((await allListEntries())[0].checked).toBe(true);
    await new Promise((r) => setTimeout(r, 3));
    await undo();
    expect(tables()).toEqual(before);
    expect(Number(rows("SELECT checked_at FROM list_entries WHERE id = 'l1'")[0].checked_at)).toBeGreaterThan(tickedAt);
    // Untick too.
    await updateListEntry('l1', { checked: true });
    await act('Unticked Milk', () => updateListEntry('l1', { checked: false }));
    await undo();
    expect((await allListEntries())[0].checked).toBe(true);
  });

  it('ticking several at once', async () => {
    for (const id of ['a', 'b', 'c']) await addListEntry(line(id, id));
    const before = tables();
    await act('3 marked as got', () => runOps([checkEntriesOp(['a', 'b', 'c'])]));
    expect((await allListEntries()).every((e) => e.checked)).toBe(true);
    await undo();
    expect(tables()).toEqual(before);
  });

  it('remove from list, and clear ticked: the same lines, same ids', async () => {
    await addListEntry(line('l1', 'Milk', { qty: 3, chain: 'coles', price: 2.5 }));
    await addListEntry(line('l2', 'Eggs', { checked: true }));
    await addListEntry(line('l3', 'Jam', { checked: true }));
    const before = tables();
    await act('Removed from your shopping list', () => deleteListEntries(['l1']));
    await act('Cleared 2 ticked items', () => deleteListEntries(['l2', 'l3']));
    expect(await allListEntries()).toEqual([]);
    await undo();
    expect((await allListEntries()).map((e) => e.id)).toEqual(['l2', 'l3']);
    await undo();
    expect(tables()).toEqual(before);
  });

  it('change quantity: three presses are one Undo', async () => {
    await addListEntry(line('l1', 'Milk', { qty: 1 }));
    const before = tables();
    for (const q of [2, 3, 4]) await act(`Milk: ${q}`, () => updateListEntry('l1', { qty: q }), { merge: 'qty:l1' });
    expect((await allListEntries())[0].qty).toBe(4);
    expect(lastStep()?.label).toBe('Milk: 4');
    await undo();
    expect(tables()).toEqual(before);
    expect(lastStep()).toBeUndefined();
  });

  it('move to another list', async () => {
    await addListEntry(line('l1', 'Ice', { section: 'pantry' }));
    const before = tables();
    await act('Moved to Keg', () => updateListEntry('l1', { section: 'keg' }));
    await undo();
    expect(tables()).toEqual(before);
  });

  it('edit an item: name, category, alerts, picks', async () => {
    await loadDemo();
    const [g] = await allGroups();
    const before = tables();
    await act('Saved', () =>
      updateGroup(g.id, { name: 'Renamed', categoryId: undefined, alertLevel: 'any', targetPrice: 1.5, sameProductIds: [], altProductIds: [], anySize: true, notAt: ['aldi'] }),
    );
    expect((await allGroups()).find((x) => x.id === g.id)?.name).toBe('Renamed');
    await undo();
    expect(tables()).toEqual(before);
  });

  it('delete a pantry item: the item, its products, prices and list lines come back with the same ids', async () => {
    await loadDemo();
    const [g] = await allGroups();
    await addListEntry(line('l1', g.name, { groupId: g.id, qty: 3 }));
    const before = tables();
    const snap = await snapshot();
    await act(`${g.name} deleted`, () => deleteGroup(g.id));
    expect((await allGroups()).find((x) => x.id === g.id)).toBeUndefined();
    await undo();
    expect(tables()).toEqual(before);
    expect((await snapshot()).groups).toEqual(snap.groups);
  });

  it('deleting several pantry items is one Undo', async () => {
    await loadDemo();
    const ids = (await allGroups()).slice(0, 4).map((g) => g.id);
    const before = tables();
    await act('4 items deleted', async () => {
      for (const id of ids) await deleteGroup(id);
    });
    await undo();
    expect(tables()).toEqual(before);
  });

  it('add to the pantry (with its product and price) goes away completely', async () => {
    const before = tables();
    await act('Added Coffee', async () => {
      await addProduct({ id: 'p1', chain: 'coles', name: 'Coffee 200g', createdAt: '2026-11-10T00:00:00.000Z' } as never);
      await addReading({ productId: 'p1', date: '2026-11-10', price: 12, isSpecial: false, memberOnly: false, source: 'search' } as never);
      await addGroup(group('g1', 'Coffee', { usualProductId: 'p1' }));
      await addListEntry(line('l1', 'Coffee', { groupId: 'g1' }));
    });
    expect(rows('SELECT COUNT(*) AS n FROM prices')[0].n).toBe(1);
    await undo();
    expect(tables()).toEqual(before);
  });

  it('remove a loyalty card, and a receipt', async () => {
    await addCard({ id: 'c1', program: 'flybuys', label: 'Flybuys', number: '1234', createdAt: '2026-11-10' } as never);
    await saveReceipt({ id: 'r1', scannedAt: '2026-11-10T00:00:00Z', section: 'pantry', total: 12.5, pinned: false } as never);
    const before = tables();
    await act('Card removed', () => deleteCard('c1'));
    let photoBack = false;
    await act('Receipt deleted', async (ctx) => {
      ctx.onUndo(async () => {
        photoBack = true;
      });
      await deleteReceipts(['r1']);
    });
    expect(await allCards()).toEqual([]);
    expect(await allReceipts()).toEqual([]);
    await undo();
    expect(photoBack).toBe(true);
    await undo();
    expect(tables()).toEqual(before);
  });

  it('an action inside an action (ctx.act) is part of it (one Undo)', async () => {
    const g = group('g1', 'Milk');
    await addGroup(g);
    await act('Both', async (ctx) => {
      await ctx.act(() => addGroupToList(g));
      await addListEntry(line('l2', 'Eggs'));
    });
    expect(lastStep()?.label).toBe('Both');
    await undo();
    expect(await allListEntries()).toEqual([]);
  });

  // 0.9.5 (final review): a second action started while the first is still running used to be
  // taken as part of the first (one Undo for both).
  it('two actions started together are two Undo steps', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = act('Milk added', async () => {
      await addListEntry(line('l1', 'Milk'));
      await gate;
    });
    await new Promise((r) => setTimeout(r, 5)); // the first is running now
    const second = act('Eggs added', () => addListEntry(line('l2', 'Eggs')));
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([first, second]);
    expect(lastStep()?.label).toBe('Eggs added');
    await undo();
    expect((await allListEntries()).map((e) => e.id)).toEqual(['l1']);
    expect(lastStep()?.label).toBe('Milk added');
    await undo();
    expect(await allListEntries()).toEqual([]);
  });

  it('a background write while an action runs is never undone', async () => {
    await addListEntry(line('l1', 'Milk'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const action = act('Ticked Milk', async () => {
      await updateListEntry('l1', { checked: true });
      await gate;
    });
    await new Promise((r) => setTimeout(r, 5)); // the action is running now
    // A Home Assistant round (say) adds a line and changes Milk's amount meanwhile.
    const bg = background(async () => {
      await addListEntry(line('ha-1', 'Bread'));
      await updateListEntry('l1', { qty: 3 });
    });
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([action, bg]);
    await undo();
    const now = await allListEntries();
    expect(now.map((e) => [e.id, e.checked, e.qty]).sort()).toEqual([
      ['ha-1', false, 1],
      ['l1', false, 3],
    ]);
  });

  it('an action waits for a background write that is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const bg = background(async () => {
      await addListEntry(line('ha-1', 'Bread'));
      await gate;
      await addListEntry(line('ha-2', 'Jam'));
    });
    await new Promise((r) => setTimeout(r, 5));
    const action = act('Milk added', () => addListEntry(line('l1', 'Milk')));
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([bg, action]);
    await undo();
    expect((await allListEntries()).map((e) => e.id).sort()).toEqual(['ha-1', 'ha-2']);
  });

  it('tells the screens: added, then undone', async () => {
    const seen: UndoEvent['kind'][] = [];
    const off = onUndo((e) => seen.push(e.kind));
    await act('Added', () => addListEntry(line('l1', 'Milk')));
    await undo();
    off();
    expect(seen).toEqual(['added', 'undone']);
  });

  it('older callers (undoable) still work, without offering an Undo', async () => {
    await addListEntry(line('l1', 'Milk'));
    const put = await undoable(() => deleteListEntries(['l1']));
    expect(lastStep()).toBeUndefined();
    await put();
    expect((await allListEntries()).map((e) => e.id)).toEqual(['l1']);
  });
});

// ---------- with sync ----------

/** This phone: db.ts's database, and the sync engine on the same database. */
const here = () => {
  const e = new WebSyncEngine(syncDbOf(raw), verifySig, signedText);
  return e;
};
const other = async () => {
  const d = await createSqlJsDriver({ load: async () => SQL });
  await migrate(d);
  const e = new WebSyncEngine(syncDbOf(d.raw), verifySig, signedText);
  e.setMeta('device', 'b2phone');
  return e;
};
const send = (from: WebSyncEngine, to: WebSyncEngine) => to.apply(from.collect(0, null, 10_000, null, '', true, 0).entries as Entry[]);
const listOn = (e: WebSyncEngine) => e.db.query('SELECT id, text, qty, checked FROM list_entries ORDER BY id');

describe('undo and sync', () => {
  it('an undone delete comes back on the other phone, as the same record', async () => {
    const a = here();
    const b = await other();
    await addListEntry(line('l1', 'Milk', { qty: 2 }));
    send(a, b);
    expect(listOn(b)).toEqual([{ id: 'l1', text: 'Milk', qty: 2, checked: 0 }]);
    await act('Removed', () => deleteListEntries(['l1']));
    send(a, b);
    expect(listOn(b)).toEqual([]);
    await new Promise((r) => setTimeout(r, 3));
    await undo();
    send(a, b);
    expect(listOn(b)).toEqual([{ id: 'l1', text: 'Milk', qty: 2, checked: 0 }]);
    expect(b.db.query("SELECT deleted FROM sync_log WHERE tbl = 'list_entries' AND pk = 'l1'")).toEqual([{ deleted: 0 }]);
    // And back from the other phone it stays (no second copy, no delete).
    send(b, a);
    expect((await allListEntries()).map((e) => e.id)).toEqual(['l1']);
  });

  it('an undone pantry delete comes back on the other phone', async () => {
    const a = here();
    const b = await other();
    await addProduct({ id: 'p1', chain: 'coles', name: 'Coffee 200g', createdAt: '2026-11-10T00:00:00.000Z' } as never);
    await addGroup(group('g1', 'Coffee', { usualProductId: 'p1' }));
    send(a, b);
    await act('Coffee deleted', () => deleteGroup('g1'));
    send(a, b);
    expect(b.db.query('SELECT id FROM items')).toEqual([]);
    await new Promise((r) => setTimeout(r, 3));
    await undo();
    send(a, b);
    expect(b.db.query('SELECT id, name, usual_product_id FROM items')).toEqual([{ id: 'g1', name: 'Coffee', usual_product_id: 'p1' }]);
    expect(b.db.query('SELECT id FROM products')).toEqual([{ id: 'p1' }]);
  });

  it('an undone tick goes to the other phone too', async () => {
    const a = here();
    const b = await other();
    await addListEntry(line('l1', 'Milk'));
    send(a, b);
    await act('Ticked', () => updateListEntry('l1', { checked: true }));
    send(a, b);
    expect(listOn(b)[0].checked).toBe(1);
    await new Promise((r) => setTimeout(r, 3));
    await undo();
    send(a, b);
    expect(listOn(b)[0].checked).toBe(0);
  });

  it('after a sync conflict: what the other phone changed since is kept', async () => {
    const a = here();
    const b = await other();
    const gs = ['g1', 'g2', 'g3'].map((id) => group(id, id));
    for (const g of gs) await addGroup(g);
    await act('Added 3', async () => {
      for (const g of gs) await addGroupToList(g);
    });
    send(a, b);
    // On the other phone, someone ticks one of them (they bought it) and changes another's amount.
    const [x, y] = b.db.query('SELECT id FROM list_entries ORDER BY item_id').map((r) => String(r.id));
    await new Promise((r) => setTimeout(r, 3));
    b.db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('clock', '0')");
    b.db.exec('UPDATE list_entries SET checked = 1, checked_at = ? WHERE id = ?', [Date.now(), x]);
    b.db.exec('UPDATE list_entries SET qty = 5, qty_at = ? WHERE id = ?', [Date.now(), y]);
    send(b, a);
    const r = await undo();
    expect(r?.kept).toBe(2);
    expect((await allListEntries()).map((e) => e.id).sort()).toEqual([x, y].sort());
    send(a, b);
    expect(listOn(b).map((e) => e.id).sort()).toEqual([x, y].sort());
  });

  it('a line the other phone deleted since is not brought back by undoing an edit', async () => {
    const a = here();
    const b = await other();
    await addListEntry(line('l1', 'Milk'));
    send(a, b);
    await act('Milk: 3', () => updateListEntry('l1', { qty: 3 }));
    send(a, b);
    await new Promise((r) => setTimeout(r, 3));
    b.db.exec('DELETE FROM list_entries WHERE id = ?', ['l1']);
    send(b, a);
    expect(await allListEntries()).toEqual([]);
    const r = await undo();
    expect(r?.kept).toBe(1);
    expect(await allListEntries()).toEqual([]);
  });

  it('a change taken in from another phone is never part of an action here', async () => {
    const a = here();
    const b = await other();
    await addListEntry(line('l1', 'Milk'));
    send(a, b);
    b.db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at) VALUES ('b1', 'Eggs', 0, 1, 'x')");
    await act('Ticked Milk', async () => {
      await updateListEntry('l1', { checked: true });
      send(b, a);
    });
    await undo();
    expect((await allListEntries()).map((e) => [e.id, e.checked])).toEqual([
      ['l1', false],
      ['b1', false],
    ]);
  });
});

void listState;

describe('undo after erasing or restoring', () => {
  it('Erase everything leaves nothing to undo', async () => {
    const { eraseEverything } = await import('./db');
    await act('Added', () => addListEntry(line('l1', 'Milk')));
    expect(lastStep()).toBeDefined();
    await eraseEverything();
    expect(lastStep()).toBeUndefined();
    expect(await undo()).toBeUndefined();
  });
});
