// 0.13.1: inventory (lib/inventory.ts, ui/Inventory.tsx): the rules, held to the code and to the database.
import { readSource } from '../lib/readSource';
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { backupJson, importBackup } from '../lib/backup';
import { addGroup, addListEntry, allListEntries, deleteGroup, ensureDefaults, initDb, nowIso, queryRows, runOps, updateListEntry } from '../lib/db';
import { csvFiles } from '../lib/csvExport';
import {
  boughtAmount,
  checkHave,
  countTicks,
  encodeHave,
  haveAfterTick,
  haveLabel,
  haveState,
  haveText,
  INVENTORY_SECTIONS,
  inventoryFrom,
  loadInventory,
  NO_INVENTORY,
  ranLow,
  ranLowTitle,
  restoreInventory,
  roughParts,
  roughText,
  saveHave,
  saveInventorySettings,
  setInventoryTab,
  stepHave,
  type Have,
} from '../lib/inventory';
import { settingChangeOk, settingTab } from '../lib/sharedSettings';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import type { Group } from '../types';
import { inventorySummary, inventoryTabs } from './Inventory';

const read = (p: string) => readSource(new URL(p, import.meta.url));
const group = (id: string, name: string, section?: Group['section']): Group => ({ id, name, sameProductIds: [], altProductIds: [], alertLevel: 'good', section, createdAt: nowIso() });
const rows = () => queryRows<{ k: string; v: string }>("SELECT k, v FROM household_settings WHERE k LIKE 'inv:%' OR k LIKE 'have:%' ORDER BY k");

beforeEach(async () => {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  await initDb(driver);
  await ensureDefaults();
});

describe('0.13.1 inventory: amounts', () => {
  it('three ways to count, each said plainly', () => {
    expect(haveText({ mode: 'count', amount: 14 })).toBe('14');
    expect(haveText({ mode: 'measure', amount: 300, unit: 'g' })).toBe('300 g');
    expect(haveText({ mode: 'measure', amount: 750, unit: 'ml' })).toBe('750 mL');
    expect(haveText({ mode: 'measure', amount: 1.5, unit: 'kg' })).toBe('1.5 kg');
    expect([0.25, 0.5, 0.75, 1, 2.5, 0].map(roughText)).toEqual(['¼', '½', '¾', '1', '2½', '0']);
    expect(haveLabel({ mode: 'count', amount: 14 })).toBe('Have: 14');
    expect(haveLabel({ mode: 'rough', amount: 0.25, low: 0.25 })).toBe('Have: ¼ · running low');
    expect(haveLabel({ mode: 'count', amount: 0 })).toBe('Have: 0 · out');
    expect(haveLabel(undefined)).toBe('How many?');
  });
  it('low and out', () => {
    expect(haveState(undefined)).toBe('ok');
    expect(haveState({ mode: 'count', amount: 3, low: 2 })).toBe('ok');
    expect(haveState({ mode: 'count', amount: 2, low: 2 })).toBe('low');
    expect(haveState({ mode: 'count', amount: 1 })).toBe('ok'); // no level set: only "out"
    expect(haveState({ mode: 'measure', amount: 0, unit: 'g', low: 100 })).toBe('out');
    expect(ranLow({ mode: 'count', amount: 3, low: 2 }, { mode: 'count', amount: 2, low: 2 })).toBe('low');
    expect(ranLow({ mode: 'count', amount: 2, low: 2 }, { mode: 'count', amount: 1, low: 2 })).toBeUndefined(); // already low: not asked twice
    expect(ranLow({ mode: 'count', amount: 1, low: 2 }, { mode: 'count', amount: 0, low: 2 })).toBe('out');
    expect(ranLow(undefined, { mode: 'count', amount: 5 })).toBeUndefined();
    expect(ranLow({ mode: 'count', amount: 0 }, { mode: 'count', amount: 4 })).toBeUndefined(); // going up never asks
    expect(ranLowTitle('passata', 'out')).toBe("You're out of passata");
    expect(ranLowTitle('Passata', 'low')).toBe('Passata is running low');
  });
  it('minus and plus: one, a quarter of a pack, or 50 g / 50 mL / a quarter of a kilo or litre; never below nothing', () => {
    expect(stepHave({ mode: 'count', amount: 1 }, -1).amount).toBe(0);
    expect(stepHave({ mode: 'count', amount: 0 }, -1).amount).toBe(0);
    expect(stepHave({ mode: 'rough', amount: 2.5 }, 1).amount).toBe(2.75);
    expect(stepHave({ mode: 'measure', amount: 300, unit: 'g' }, -1).amount).toBe(250);
    expect(stepHave({ mode: 'measure', amount: 1, unit: 'l' }, 1).amount).toBe(1.25);
  });
  it('a rough amount is the open pack and the unopened ones', () => {
    expect(roughParts(2.5)).toEqual({ open: 0.5, unopened: 2 });
    expect(roughParts(3)).toEqual({ open: 1, unopened: 2 });
    expect(roughParts(0.25)).toEqual({ open: 0.25, unopened: 0 });
    expect(roughParts(0)).toEqual({ open: 0, unopened: 0 });
  });
  it('a row is written one way and read strictly', () => {
    const h: Have = { mode: 'measure', amount: 750, unit: 'ml', low: 200 };
    expect(encodeHave(h)).toBe('{"m":"w","a":750,"u":"ml","low":200}');
    expect(checkHave(JSON.parse(encodeHave(h)))).toEqual(h);
    expect(encodeHave({ mode: 'count', amount: 3.4 })).toBe('{"m":"c","a":3}');
    expect(encodeHave({ mode: 'rough', amount: 0.6 })).toBe('{"m":"r","a":0.5}');
    for (const bad of [null, 'x', [], {}, { m: 'x', a: 1 }, { m: 'c', a: -1 }, { m: 'c', a: 'lots' }, { m: 'w', a: 5 }, { m: 'w', a: 5, u: 'cups' }, { m: 'c', a: Infinity }]) expect(checkHave(bad)).toBeUndefined();
  });
  it('what a tick adds: that many, that many packs, or the packs by weight when the size is known', () => {
    expect(boughtAmount({ mode: 'count', amount: 0 }, 3)).toBe(3);
    expect(boughtAmount({ mode: 'rough', amount: 0.5 }, 2)).toBe(2);
    expect(boughtAmount({ mode: 'measure', amount: 100, unit: 'g' }, 2, { qty: 500, qtyUnit: 'g' })).toBe(1000);
    expect(boughtAmount({ mode: 'measure', amount: 0.1, unit: 'kg' }, 2, { qty: 500, qtyUnit: 'g' })).toBe(1);
    expect(boughtAmount({ mode: 'measure', amount: 100, unit: 'ml' }, 1, { qty: 500, qtyUnit: 'g' })).toBe(0); // grams bought, millilitres counted: can't know
    expect(boughtAmount({ mode: 'measure', amount: 100, unit: 'g' }, 1, undefined)).toBe(0);
  });
});

describe('0.13.1 inventory: the household rows', () => {
  it('off everywhere to start with; on tab by tab; off keeps the amounts', async () => {
    expect((await loadInventory()).tabs.size).toBe(0);
    expect(NO_INVENTORY.tick).toBe(true);
    expect(NO_INVENTORY.auto).toBe(false);
    await setInventoryTab('pantry', true);
    await saveHave('g1', { mode: 'count', amount: 4 });
    let inv = await loadInventory();
    expect([...inv.tabs]).toEqual(['pantry']);
    expect(inv.have.get('g1')).toEqual({ mode: 'count', amount: 4 });
    await setInventoryTab('pantry', false);
    inv = await loadInventory();
    expect(inv.tabs.size).toBe(0);
    expect(inv.have.get('g1')?.amount).toBe(4);
    expect(INVENTORY_SECTIONS[0]).toBe('pantry');
    expect(INVENTORY_SECTIONS).toContain('keg');
    expect(INVENTORY_SECTIONS).toContain('c6');
  });
  it("Settings' Save writes the tabs and the two choices in one go", async () => {
    await saveInventorySettings({ tabs: ['pantry', 'baby'], auto: true, tick: false });
    const inv = await loadInventory();
    expect([...inv.tabs].sort()).toEqual(['baby', 'pantry']);
    expect(inv.auto).toBe(true);
    expect(inv.tick).toBe(false);
    await saveInventorySettings({ tabs: [], auto: false, tick: true });
    expect((await loadInventory()).tabs.size).toBe(0);
    expect(inventorySummary({ tabs: new Set() })).toMatch(/^Off/);
    expect(inventorySummary({ tabs: new Set(['pantry', 'baby'] as const) })).toBe('On for Pantry and Baby');
    expect(inventoryTabs({ sections: { keg: true, pets: false } })).toEqual(['pantry', 'keg']);
  });
  it('odd rows are passed over, and sample items never get a household row', async () => {
    const inv = inventoryFrom([
      { k: 'inv:tab:pantry', v: 'true' },
      { k: 'inv:tab:nowhere', v: 'true' },
      { k: 'inv:tab:baby', v: '"yes"' },
      { k: 'have:g1', v: '{"m":"c","a":2}' },
      { k: 'have:g2', v: 'not json' },
      { k: 'have:demo-milk', v: '{"m":"c","a":2}' },
      { k: 'have:bad id!', v: '{"m":"c","a":2}' },
    ]);
    expect([...inv.tabs]).toEqual(['pantry']);
    expect([...inv.have.keys()]).toEqual(['g1']);
    await saveHave('demo-milk', { mode: 'count', amount: 2 });
    expect(await rows()).toEqual([]);
    expect((await loadInventory()).have.get('demo-milk')?.amount).toBe(2);
  });
  it('older phones and servers carry the rows as they are (nothing about sync changes)', () => {
    const room = { has: () => false, count: () => 0, added: () => undefined };
    expect(settingChangeOk('have:g1', { k: 'have:g1', v: '{"m":"c","a":2}' }, false, room)).toBe(true);
    expect(settingChangeOk('inv:tab:pantry', { k: 'inv:tab:pantry', v: 'true' }, false, room)).toBe(true);
    expect(settingTab('have:g1', '{"m":"c","a":2}')).toBeNull(); // the whole household's
    const java = read('../../android/app/src/main/java/family/plenty/restock/SharedSettings.java');
    expect(java).toContain("k LIKE 'inv:%' OR k LIKE 'have:%'"); // a phone that leaves keeps its inventory
  });
  it('an item deleted takes its amount with it', async () => {
    await addGroup(group('g1', 'Milo'));
    await saveHave('g1', { mode: 'count', amount: 4 });
    await deleteGroup('g1');
    expect(await rows()).toEqual([]);
  });
});

describe('0.13.1 inventory: ticking off while shopping', () => {
  beforeEach(async () => {
    await addGroup(group('g1', 'Milo'));
    await addGroup(group('k1', 'Lager', 'keg'));
    await setInventoryTab('pantry', true);
    await addListEntry({ id: 'e1', text: 'Milo', groupId: 'g1', qty: 3, checked: false, createdAt: nowIso() });
    await addListEntry({ id: 'e2', text: 'Lager', groupId: 'k1', qty: 2, checked: false, createdAt: nowIso() });
    await addListEntry({ id: 'e3', text: 'Sponges', qty: 1, checked: false, createdAt: nowIso() });
  });
  it('adds what was bought, starting a count when there was none; unticking takes it back', async () => {
    await updateListEntry('e1', { checked: true });
    await countTicks(['e1'], true);
    expect((await loadInventory()).have.get('g1')).toEqual({ mode: 'count', amount: 3 });
    await countTicks(['e1'], true);
    expect((await loadInventory()).have.get('g1')?.amount).toBe(6);
    await countTicks(['e1'], false);
    expect((await loadInventory()).have.get('g1')?.amount).toBe(3);
  });
  it('only on tabs with inventory on, only for items, and not when the choice is off', async () => {
    await countTicks(['e2', 'e3'], true);
    expect(await rows()).toEqual([{ k: 'inv:tab:pantry', v: 'true' }]);
    await saveInventorySettings({ tabs: ['pantry'], auto: false, tick: false });
    await countTicks(['e1'], true);
    expect((await loadInventory()).have.has('g1')).toBe(false);
    expect((await allListEntries()).length).toBe(3);
  });
  it('unticking something never counted does nothing, and nothing goes below zero', () => {
    const inv = { tabs: new Set(['pantry'] as const), auto: false, tick: true, have: new Map<string, Have>() };
    expect(haveAfterTick(inv, { id: 'g1' }, 2, false)).toBeUndefined();
    inv.have.set('g1', { mode: 'count', amount: 1 });
    expect(haveAfterTick(inv, { id: 'g1' }, 5, false)).toEqual({ mode: 'count', amount: 0 });
    expect(haveAfterTick(inv, { id: 'g1', section: 'keg' }, 5, true)).toBeUndefined();
  });
  it('every way of ticking counts it, inside the same action as the tick (one Undo for both)', () => {
    const list = read('./screens/List.tsx');
    expect(list).toMatch(/await updateListEntry\(e\.id, \{ checked \}\);\s*await countTicks\(\[e\.id\], checked\)/);
    expect(list).toMatch(/await runOps\(\[checkEntriesOp\(ids\)\]\);\s*await countTicks\(fresh, true\)/);
    expect(list).toMatch(/await updateListEntry\(match\.id, \{ checked: true \}\);\s*await countTicks\(\[match\.id\], true\)/);
  });
});

describe('0.13.1 inventory: backups and spreadsheets', () => {
  it('a backup carries it, and a restore puts back the amounts of items that are there', async () => {
    await addGroup(group('g1', 'Milo'));
    await setInventoryTab('pantry', true);
    await saveHave('g1', { mode: 'rough', amount: 2.5, low: 0.25 });
    await saveHave('gone', { mode: 'count', amount: 9 });
    await saveHave('demo-milk', { mode: 'count', amount: 1 });
    const file = await backupJson();
    const kv = (JSON.parse(file) as { tables: { kv: { key: string; value: Record<string, string> }[] } }).tables.kv.find((k) => k.key === 'inventory');
    expect(Object.keys(kv!.value).sort()).toEqual(['have:g1', 'have:gone', 'inv:tab:pantry']);
    await runOps([{ sql: "DELETE FROM household_settings WHERE k LIKE 'inv:%' OR k LIKE 'have:%'" }]);
    await importBackup(file);
    const inv = await loadInventory();
    expect([...inv.tabs]).toEqual(['pantry']);
    expect(inv.have.get('g1')).toEqual({ mode: 'rough', amount: 2.5, low: 0.25 });
    expect(inv.have.has('gone')).toBe(false); // its item isn't there
    expect(await queryRows("SELECT 1 FROM kv WHERE key = 'inventory'")).toEqual([]);
  });
  it('a restore leaves out anything odd, and only brings the tabs asked for', async () => {
    await addGroup(group('g1', 'Milo'));
    await addGroup(group('k1', 'Lager', 'keg'));
    const raw = { 'inv:tab:pantry': 'true', 'inv:tab:keg': 'true', 'inv:auto': 'true', 'have:g1': '{"m":"c","a":2}', 'have:k1': '{"m":"c","a":6}', 'have:x': '{"m":"zzz"}', 'shop:evil': '{"on":true}', 'have:g1 ': 'x' };
    expect(await restoreInventory({ raw, sections: ['pantry'], settings: false })).toBe(2);
    expect((await rows()).map((r) => r.k)).toEqual(['have:g1', 'inv:tab:pantry']);
    expect(await queryRows("SELECT 1 FROM household_settings WHERE k = 'shop:evil'")).toEqual([]);
  });
  it('the spreadsheet export gets an inventory file only when something is counted', async () => {
    const snap = { products: [], groups: [group('g1', 'Milo')], prices: [], list: [], cards: [], categories: [], kv: [], receipts: [], giftCards: [] };
    expect(csvFiles(snap).map((f) => f.name)).toEqual(['restock-pantry.csv', 'restock-shopping-list.csv', 'restock-price-history.csv']);
    const files = csvFiles(snap, new Map([['g1', { mode: 'measure' as const, amount: 300, unit: 'g', low: 100 }]]));
    expect(files.map((f) => f.name)).toContain('restock-inventory.csv');
    expect(files[3].text).toContain('Pantry,Milo,,Weight or volume,300,g,100');
  });
});

describe('0.13.1 inventory: on the screen', () => {
  const ui = read('./Inventory.tsx');
  const pantry = read('./screens/Pantry.tsx');
  it('the Inventory button is beside Edit on every tab, on or off; off opens what it is, with one big Turn on', () => {
    expect(pantry).toMatch(/\{!editing && INVENTORY_SECTIONS\.includes\(section\) && <InventoryButton section=\{section\}/);
    expect(pantry.indexOf('<InventoryButton')).toBeLessThan(pantry.indexOf('aria-label={`Edit this tab'));
    expect(ui).toMatch(/Keep an inventory for \{name\}\?/);
    expect(ui).toMatch(/className="btn primary block inv-turn-on"[\s\S]{0,200}>\s*Turn on\s*<\/button>/);
    expect(ui).toContain('Can be turned off here or in Settings.');
    expect(ui).toMatch(/Turn off inventory for \{name\}/);
  });
  it("a row shows its Have box only when the tab's inventory is on, and the box opens the amount", () => {
    expect(pantry).toMatch(/extra=\{invOn && !editing \? <HaveChip name=\{r\.group\.name\} have=\{inv\.have\.get\(r\.group\.id\)\} onEdit=\{\(\) => setHaveFor\(r\)\} \/> : undefined\}/);
    expect(read('./simple.tsx')).toMatch(/\{note && <span className=\{`irow-note \$\{note\.tone\}`\}>\{note\.text\}<\/span>\}\s*<\/span>\s*\{extra\}/);
  });
  it('the three ways to count, quarters of the open pack, and a level for running low', () => {
    for (const w of ["label: 'Number'", "label: 'Weight or volume'", "label: 'Rough amount'", "'Empty'", "'¼'", "'½'", "'¾'", "'Full'", 'Unopened packs', "Tell me it's running low at"]) expect(ui).toContain(w);
  });
  it('running out: on the list by itself when that is on, otherwise Restock asks; never when it is already listed', () => {
    expect(ui).toMatch(/if \(!how \|\| \(await openEntryForGroup\(group\.id\)\)\) return;/);
    expect(ui).toMatch(/if \(inv\.auto\) return void \(await add\(/);
    expect(ui).toMatch(/confirmAction\(ranLowTitle\(group\.name, how\), \{ detail: 'Put it on your shopping list\?', action: 'Add to list' \}\)/);
  });
  it('Settings: a switch for Pantry and each tab you made, the two choices, and nothing changes until Save settings', () => {
    expect(ui).toContain('Keep an inventory for');
    expect(ui).toContain('Add to my shopping list automatically');
    expect(ui).toContain('Count what I tick off while shopping');
    expect(ui).toMatch(/await act\('Inventory settings saved', \(\) => saveInventorySettings\(d\)\)/);
    expect(read('./screens/Settings.tsx')).toMatch(/row\('Inventory', inventorySummary\(inv\), \(\) => nav\.push\(\{ name: 'inventorySettings' \}\)\)/);
  });
  it('the web page has the same Settings row (0.15.0: and the phone screens themselves)', () => {
    expect(read('../server-mode/ui/DeskSettings.tsx')).toContain('<InventoryLine />');
  });
  it("the welcome's Restore is a file box you tap, not a hidden one pressed from code", () => {
    const setup = read('./screens/Setup.tsx');
    expect(setup).toMatch(/<label className="welcome-restore welcome-file">\s*Restore from a backup\s*<input\s+type="file"/);
    expect(setup).not.toContain('fileRef');
  });
});
