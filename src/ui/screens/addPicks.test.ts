import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StoreProduct } from '../../stores';

// 0.9.5: tapping a result on the Add tab only ticks it; the sheet opens from the bar's green arrow.
// And "Search the shops" from the Pick sheet: the ticked products become a pantry item, the list
// line becomes it, and "Always use this for chopsticks" is kept for the new item.

const { keyOf, sheetOpenAfter, tickMessage, togglePick } = await import('./addPicks');
const { addItemForLine, addItemForLineUndoable, addItemFromPicks, pickedWords } = await import('./addSave');
const { clearUndo, lastStep, undo, act } = await import('../../lib/undo');
const { scannedLine } = await import('../../lib/listActions');
const { addListEntry, allGroups, allListEntries, deleteListEntries, ensureDefaults, getProducts, initDb, nowIso, readingsFor } = await import('../../lib/db');
const { getAliases, linesToPick } = await import('../../lib/listPicks');
const { createSqlJsDriver } = await import('../../lib/sql/sqljs');

const fanta: StoreProduct = {
  chain: 'coles',
  storeProductId: '123',
  name: 'Fanta Orange Soft Drink Cans 24 x 375mL',
  brand: 'Fanta',
  size: '24 x 375mL',
  price: 22,
  isSpecial: false,
  memberOnly: false,
};
const fantaW: StoreProduct = { ...fanta, chain: 'woolworths', storeProductId: '987', price: 21.5 };
const sticks: StoreProduct = { chain: 'coles', storeProductId: 'c-1', name: 'Coles Bamboo Chopsticks 40 pack', price: 3.5, isSpecial: false, memberOnly: false };
const sticksA: StoreProduct = { chain: 'aldi', storeProductId: 'a-1', name: 'Bamboo Chopsticks 50 pack', price: 2.99, isSpecial: false, memberOnly: false };

describe('Add tab: a tap ticks, the arrow opens', () => {
  it('a tap ticks a result into the bar, and a second tap unticks it', () => {
    let picks = togglePick(new Map(), fanta);
    expect([...picks.keys()]).toEqual([keyOf(fanta)]);
    picks = togglePick(picks, fantaW);
    expect(picks.size).toBe(2);
    picks = togglePick(picks, fanta);
    expect([...picks.keys()]).toEqual([keyOf(fantaW)]);
  });

  it('ticking never opens the sheet; only the bar’s green arrow does', () => {
    let open = false;
    // Tapping results (and best matches ticked for you): still shut, every time.
    for (const size of [1, 2, 3, 2]) {
      open = sheetOpenAfter(open, { kind: 'picks', size });
      expect(open).toBe(false);
    }
    // The arrow opens it.
    open = sheetOpenAfter(open, { kind: 'arrow', size: 2 });
    expect(open).toBe(true);
    // Ticking "Picked for you at your other shops" inside it keeps it open.
    open = sheetOpenAfter(open, { kind: 'picks', size: 3 });
    expect(open).toBe(true);
    // Closed, it stays closed while ticking goes on.
    open = sheetOpenAfter(open, { kind: 'close' });
    open = sheetOpenAfter(open, { kind: 'picks', size: 4 });
    expect(open).toBe(false);
    // Nothing ticked: no sheet, and the arrow can't open an empty one.
    expect(sheetOpenAfter(true, { kind: 'picks', size: 0 })).toBe(false);
    expect(sheetOpenAfter(false, { kind: 'arrow', size: 0 })).toBe(false);
  });

  it('tells a screen reader what was ticked', () => {
    const none = new Map<string, StoreProduct>();
    const one = togglePick(none, fanta);
    expect(tickMessage(none, one)).toBe(`Ticked ${fanta.name} at Coles. 1 ticked. Tap the bar at the bottom to add.`);
    const two = togglePick(one, fantaW);
    expect(tickMessage(one, two)).toContain('at Woolworths. 2 ticked.');
    expect(tickMessage(two, togglePick(two, fanta))).toBe(`Unticked ${fanta.name} at Coles. 1 ticked. Tap the bar at the bottom to add.`);
    expect(tickMessage(one, none)).toBe(`Unticked ${fanta.name} at Coles. Nothing ticked.`);
    // Best matches ticked for you at several shops at once.
    const both = new Map([
      [keyOf(fanta), fanta],
      [keyOf(fantaW), fantaW],
    ]);
    expect(tickMessage(none, both)).toBe('2 more ticked for you. 2 ticked. Tap the bar at the bottom to add.');
    expect(tickMessage(both, new Map(both))).toBe('');
  });
});

describe('Pick sheet: search the shops for a line that matches nothing', () => {
  beforeEach(async () => {
    const d = await createSqlJsDriver({ load: () => initSqlJs() });
    await initDb(d);
    await ensureDefaults();
  });

  it('makes the pantry item from what was ticked, links the line, and keeps "Always use this"', async () => {
    await addListEntry({ id: 'ha-1', text: 'chopsticks', qty: 1, section: 'pantry', checked: false, createdAt: nowIso() });
    // Something in the pantry, so the line shows "Pick my chopsticks".
    await addItemFromPicks([fanta], { name: 'Fanta', section: 'pantry' });
    const [line] = (await allListEntries()).filter((e) => e.id === 'ha-1');
    expect([...(await linesToPick())]).toEqual(['ha-1']);

    const { group, linked } = await addItemForLine(line, [sticks, sticksA], { name: 'Chopsticks', section: 'pantry' }, true);
    expect(linked).toBe(true);
    // The item: its picks are what was ticked, the first one the usual, each with today's price.
    const item = (await allGroups()).find((g) => g.id === group.id)!;
    expect(item).toMatchObject({ name: 'Chopsticks', section: 'pantry', alertLevel: 'good' });
    const ids = [item.usualProductId!, ...item.sameProductIds];
    const byId = new Map((await getProducts(ids)).map((p) => [p.id, p]));
    expect(ids.map((id) => `${byId.get(id)?.chain}:${byId.get(id)?.storeProductId}`)).toEqual(['coles:c-1', 'aldi:a-1']);
    const prices = await readingsFor(ids);
    expect(ids.map((id) => prices.get(id)?.at(-1)?.price)).toEqual([3.5, 2.99]);
    // The line is the item now, and doesn't ask any more.
    expect((await allListEntries()).find((e) => e.id === 'ha-1')).toMatchObject({ groupId: group.id, text: 'Chopsticks' });
    expect((await linesToPick()).size).toBe(0);
    // "Always use this for chopsticks": the household's alias names the new item.
    expect(await getAliases()).toEqual({ chopstick: group.id }); // kept as its matchKey (singular), as for any alias
  });

  it('without "Always", no alias; a product already kept is reused, not copied', async () => {
    await addItemFromPicks([sticks], { name: 'Old chopsticks', section: 'pantry' });
    await addListEntry({ id: 'ha-2', text: '2 chopsticks', qty: 1, section: 'pantry', checked: false, createdAt: nowIso() });
    const [line] = (await allListEntries()).filter((e) => e.id === 'ha-2');
    const { group } = await addItemForLine(line, [sticks], { name: 'Chopsticks', section: 'pantry' }, false);
    expect(await getAliases()).toEqual({});
    const groups = await allGroups();
    expect(groups.find((g) => g.id === group.id)!.usualProductId).toBe(groups.find((g) => g.name === 'Old chopsticks')!.usualProductId);
  });

  it('a line deleted meanwhile: the item is still made, and nothing else on the list changes', async () => {
    await addListEntry({ id: 'ha-3', text: 'chopsticks', qty: 1, section: 'pantry', checked: false, createdAt: nowIso() });
    const [line] = await allListEntries();
    await deleteListEntries(['ha-3']);
    const { group, linked } = await addItemForLine(line, [sticksA], { name: 'Chopsticks', section: 'pantry' }, true);
    expect(linked).toBe(false);
    expect((await allGroups()).some((g) => g.id === group.id)).toBe(true);
    expect(await allListEntries()).toEqual([]);
    expect(await getAliases()).toEqual({ chopstick: group.id }); // kept as its matchKey (singular), as for any alias
  });

  // 0.9.5 (final review): the Pick sheet's shop search had no Undo.
  it('with an Undo: one press takes the new item, its products and prices, the alias and the line back', async () => {
    clearUndo();
    await addListEntry({ id: 'ha-9', text: 'chopsticks', qty: 1, section: 'pantry', checked: false, createdAt: nowIso() });
    const [line] = await allListEntries();
    const before = { groups: await allGroups(), list: await allListEntries(), aliases: await getAliases() };
    const said = (r: { group: { name: string }; linked: boolean }) => pickedWords(r.group.name, { made: true, linked: r.linked, always: true, word: 'chopsticks', place: 'your pantry' });
    const { group } = await addItemForLineUndoable(line, [sticks, sticksA], { name: 'Chopsticks', section: 'pantry' }, true, said);
    expect(lastStep()?.label).toBe('Chopsticks added to your pantry. "chopsticks" is Chopsticks from now on');
    expect((await allListEntries())[0].groupId).toBe(group.id);
    const ids = [group.usualProductId!, ...group.sameProductIds];
    await undo();
    expect(await allGroups()).toEqual(before.groups);
    expect(await allListEntries()).toEqual(before.list);
    expect(await getAliases()).toEqual(before.aliases);
    expect(await getProducts(ids)).toEqual([]);
    expect((await readingsFor(ids)).size === 0 || [...(await readingsFor(ids)).values()].every((r) => r.length === 0)).toBe(true);
  });

  it('the Pick sheet\'s words', () => {
    expect(pickedWords('Chopsticks', { made: false, linked: true, always: false, word: 'chopsticks' })).toBe('Chopsticks it is');
    expect(pickedWords('Chopsticks', { made: true, linked: false, always: true, word: 'chopsticks' })).toBe("Chopsticks added to your pantry. That line isn't on the list any more");
  });
});

describe('scanning a barcode nothing knows (final review)', () => {
  beforeEach(async () => {
    const d = await createSqlJsDriver({ load: () => initSqlJs() });
    await initDb(d);
    await ensureDefaults();
    clearUndo();
  });

  it('one toast, with the Undo: "Added. Tap it to rename · Undo"', async () => {
    expect(scannedLine(undefined, '9300000000001')).toEqual({ text: 'Item 9300000000001', said: 'Added. Tap it to rename' });
    expect(scannedLine('  ', '93')).toEqual({ text: 'Item 93', said: 'Added. Tap it to rename' });
    expect(scannedLine('Tim Tams', '93')).toEqual({ text: 'Tim Tams' });
    const l = scannedLine(undefined, '93');
    await act(l.said!, () => addListEntry({ id: 's1', text: l.text, qty: 1, section: 'pantry', checked: false, createdAt: nowIso() }));
    expect(lastStep()?.label).toBe('Added. Tap it to rename');
    await undo();
    expect(await allListEntries()).toEqual([]);
  });
});
