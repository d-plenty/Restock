import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addCard,
  addCategory,
  addGroup,
  addListEntry,
  allCategories,
  allGroups,
  allListEntries,
  deleteCategory,
  deleteGroup,
  ensureDefaults,
  getGroup,
  getProduct,
  getSettings,
  addProduct,
  addReading,
  initDb,
  pruneHistory,
  readingsFor,
  restoreSnapshot,
  snapshot,
  uid,
  updateGroup,
  updateSettings,
} from './db';
import { loadDemo, removeDemo } from './demo';
import { onChange } from './live';
import { loadRecommendations } from './recs';
import { createSqlJsDriver } from './sql/sqljs';

let raw: Awaited<ReturnType<typeof createSqlJsDriver>>['raw'];

beforeEach(async () => {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  raw = driver.raw;
  await initDb(driver);
  await ensureDefaults();
});

const count = (table: string) => Number(raw.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]);

describe('schema', () => {
  it('migrates to the latest version and creates every table', () => {
    expect(raw.exec('PRAGMA user_version')[0].values[0][0]).toBe(14);
    const tables = raw.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")[0].values.flat();
    expect(tables).toEqual(
      expect.arrayContaining(['cards', 'categories', 'items', 'kv', 'list_entries', 'prices', 'products', 'sync_log', 'sync_meta', 'sync_peers']),
    );
  });
  it('seeds each tab its own categories, once', async () => {
    await ensureDefaults();
    await ensureDefaults();
    const cats = await allCategories();
    expect(cats.filter((c) => c.section === 'pantry').map((c) => c.name)).toEqual(['Pantry', 'Fridge & freezer', 'Cleaning', 'Bathroom']);
    expect(cats.filter((c) => c.section === 'keg').map((c) => c.name)).toEqual(['Beer', 'Wine', 'Spirits', 'Mixers & other']);
    expect(cats.filter((c) => c.section === 'pharmacy').map((c) => c.name)).toEqual(['Medicine', 'First aid', 'Vitamins', 'Personal care']);
  });
  it("doesn't bring back a tab's categories after they're all deleted", async () => {
    for (const c of (await allCategories()).filter((x) => x.section === 'keg')) await deleteCategory(c.id);
    await ensureDefaults();
    expect((await allCategories()).filter((c) => c.section === 'keg')).toHaveLength(0);
  });
  it('keeps items, list lines and categories on their tab', async () => {
    await addGroup({ id: 'g-keg', name: 'Lager', sameProductIds: [], altProductIds: [], alertLevel: 'good', section: 'keg', createdAt: '' });
    await addGroup({ id: 'g-old', name: 'Rice', sameProductIds: [], altProductIds: [], alertLevel: 'good', createdAt: '' });
    await addListEntry({ id: 'e-ph', text: 'Plasters', section: 'pharmacy', checked: false, createdAt: '' });
    await addCategory('Cider', 'keg');
    expect((await getGroup('g-keg'))?.section).toBe('keg');
    expect((await getGroup('g-old'))?.section).toBe('pantry');
    expect((await allListEntries()).find((e) => e.id === 'e-ph')?.section).toBe('pharmacy');
    expect((await allCategories()).find((c) => c.name === 'Cider')?.section).toBe('keg');
    await updateGroup('g-old', { section: 'pharmacy' });
    expect((await getGroup('g-old'))?.section).toBe('pharmacy');
  });
});

describe('settings', () => {
  it('defaults to Wednesday and merges partial updates', async () => {
    const s = await getSettings();
    expect(s.alerts.catalogueWeekday).toBe(3);
    expect(s.sync.weekday).toBe(3);
    expect(s.sync.backgroundActivity).toBe(true);
    await updateSettings({ household: { name: 'Plenty house' } });
    const s2 = await getSettings();
    expect(s2.household.name).toBe('Plenty house');
    expect(s2.alerts.catalogueDay).toBe(true);
  });
});

describe('sample data end to end', () => {
  it('produces the expected verdict for each sample item', async () => {
    await loadDemo();
    const byName = Object.fromEntries((await loadRecommendations()).map((r) => [r.group.name, r]));
    expect(byName['A4 copy paper'].action).toBe('buy');
    expect(byName['A4 copy paper'].best?.verdict.kind).toBe('great');
    expect(byName['Toilet paper'].action).toBe('alt');
    expect(byName['Ground coffee 1kg'].action).toBe('wait');
    expect(byName['Dishwasher tablets'].action).toBe('skip');
    expect(byName['Laundry liquid 2L'].action).toBe('none');
    expect(byName['Milk 2L'].action).toBe('none');
    // The member price counts once the Everyday Rewards card is added.
    await addCard({ id: uid(), program: 'everyday', label: 'Everyday Rewards', number: '9355000000000', createdAt: '' });
    const after = Object.fromEntries((await loadRecommendations()).map((r) => [r.group.name, r]));
    expect(after['Laundry liquid 2L'].action).toBe('buy');
  });

  it('round-trips booleans and arrays through SQLite', async () => {
    await loadDemo();
    const g = await getGroup('demo-tp');
    expect(g?.altProductIds).toEqual(['demo-tp-coles', 'demo-tp-ww']);
    const readings = (await readingsFor(['demo-laundry-ww'])).get('demo-laundry-ww')!;
    const last = readings[readings.length - 1];
    expect(last).toMatchObject({ isSpecial: true, memberOnly: true, wasPrice: 16, price: 10 });
    expect(readings[0]).toMatchObject({ isSpecial: false, memberOnly: false, wasPrice: undefined });
  });

  it('removes all sample data cleanly', async () => {
    await loadDemo();
    await removeDemo();
    for (const t of ['products', 'items', 'prices', 'list_entries']) expect(count(t)).toBe(0);
  });

  it('deleting a pantry item removes its orphaned products and prices', async () => {
    await loadDemo();
    await deleteGroup('demo-tp');
    expect(await getProduct('demo-tp-coles')).toBeUndefined();
    expect(Number(raw.exec("SELECT COUNT(*) FROM prices WHERE product_id = 'demo-tp-coles'")[0].values[0][0])).toBe(0);
    expect(await getProduct('demo-paper-ww')).toBeDefined();
  });
});

describe('updates', () => {
  it('patches only the named fields and announces the change', async () => {
    await loadDemo();
    let fired = 0;
    const off = onChange(() => fired++);
    await updateGroup('demo-milk', { name: 'Milk', alertPct: 15 });
    await Promise.resolve();
    off();
    const g = await getGroup('demo-milk');
    expect(g).toMatchObject({ name: 'Milk', alertPct: 15, usualProductId: 'demo-milk-aldi' });
    expect(fired).toBe(1);
  });

  it('deleting a category un-files its items and list entries', async () => {
    await loadDemo();
    const cleaning = (await allCategories()).find((c) => c.name === 'Cleaning')!;
    await deleteCategory(cleaning.id);
    expect((await allGroups()).filter((g) => g.categoryId === cleaning.id)).toHaveLength(0);
    expect((await allListEntries()).filter((e) => e.categoryId === cleaning.id)).toHaveLength(0);
    expect((await allCategories()).some((c) => c.id === cleaning.id)).toBe(false);
  });
});

describe('backup', () => {
  it('snapshot → restore gives back identical data', async () => {
    await loadDemo();
    await addCard({ id: 'c1', program: 'flybuys', label: 'Flybuys', number: '6008940012345678', createdAt: '2026-11-05T00:00:00Z' });
    const before = await snapshot();
    await removeDemo();
    await restoreSnapshot(JSON.parse(JSON.stringify(before)));
    const after = await snapshot();
    expect(after.products).toEqual(before.products);
    expect(after.groups).toEqual(before.groups);
    expect(after.prices.length).toBe(before.prices.length);
    expect(after.cards).toEqual(before.cards);
    expect(after.kv).toEqual(before.kv);
  });
});

describe('backup', () => {
  it('restores a backup onto a fresh phone and finishes setup', async () => {
    const { snapshot, getSettings, updateSettings } = await import('./db');
    const { importBackup } = await import('./backup');
    await loadDemo();
    const tables = await snapshot();
    const file = JSON.stringify({ app: 'restock', version: 2, exportedAt: '', tables });
    await updateSettings({ onboarded: false });
    await importBackup(file);
    expect((await getSettings()).onboarded).toBe(true);
    expect((await getGroup('demo-milk'))?.name).toBeTruthy();
    await expect(importBackup('not json')).rejects.toThrow('isn’t a Restock backup');
  });
});

describe('picking what to restore', () => {
  it('restores just the pantry, tidies names, and leaves everything else alone', async () => {
    const { snapshot, getSettings, updateSettings, allGroups, allListEntries, allCards, addCard, addListEntry, updateGroup } = await import('./db');
    const { readBackup, restoreBackup } = await import('./backup');
    await loadDemo();
    // A pantry item still named after its product, like the honey from before.
    const { allProducts } = await import('./db');
    const { genericName } = await import('./naming');
    const [g] = await allGroups();
    const product = (await allProducts()).find((p) => p.id === g.usualProductId)!;
    await updateGroup(g.id, { name: `${product.name} 2 pack` });
    const tables = await snapshot();
    const file = JSON.stringify({ app: 'restock', version: 2, exportedAt: '2026-11-01T00:00:00Z', tables });

    // This phone has its own list, card and theme.
    await removeDemo();
    await addListEntry({ id: 'mine', text: 'Bread', qty: 1, checked: false, createdAt: '' });
    await addCard({ id: 'c1', program: 'flybuys', label: 'Flybuys', number: '123', createdAt: '' });
    await updateSettings({ theme: 'dark' });

    const summary = readBackup(file);
    expect(summary.counts.items).toBe(tables.groups.length);
    const honey = summary.renames.find((r) => r.groupId === g.id);
    expect(honey?.to).toBe(genericName(product.name, product.brand));
    await restoreBackup(summary, { pantry: true, list: false, cards: false, settings: false }, { renames: new Map([[g.id, honey!.to]]) });

    const groups = await allGroups();
    expect(groups.length).toBe(tables.groups.length);
    expect(groups.find((x) => x.id === g.id)?.name).toBe(honey!.to);
    expect((await allListEntries()).map((e) => e.text)).toEqual(['Bread']);
    expect((await allCards()).length).toBe(1);
    expect((await getSettings()).theme).toBe('dark');
  });

  it('turns list lines into plain lines when their pantry item is not restored', async () => {
    const { snapshot, allListEntries, addListEntry, allGroups } = await import('./db');
    const { readBackup, restoreBackup } = await import('./backup');
    await loadDemo();
    const [g] = await allGroups();
    await addListEntry({ id: 'linked', text: g.name, groupId: g.id, qty: 2, checked: false, createdAt: '' });
    const file = JSON.stringify({ app: 'restock', version: 2, exportedAt: '', tables: await snapshot() });
    await removeDemo();
    await restoreBackup(readBackup(file), { pantry: false, list: true, cards: false, settings: false });
    const linked = (await allListEntries()).find((e) => e.id === 'linked');
    expect(linked?.groupId).toBeUndefined();
    expect(linked?.text).toBe(g.name);
    expect(linked?.qty).toBe(2);
  });

  it('exports just the picked tabs, and restoring them leaves the other tabs alone', async () => {
    const { snapshot, pickSnapshot, allGroups, allProducts, addGroup, addProduct, addReading, readingsFor } = await import('./db');
    const { readBackup, restoreBackup } = await import('./backup');
    await loadDemo();
    const pantryBefore = (await allGroups()).length;
    await addProduct({ id: 'beer', chain: 'bws', name: 'Great Northern Super Crisp 30 Pack', storeProductId: '915769', createdAt: '' });
    await addReading({ productId: 'beer', date: '2026-11-01T00:00:00Z', price: 54, isSpecial: true, memberOnly: false, source: 'auto' });
    await addGroup({
      id: 'keg-1',
      name: 'Lager',
      usualProductId: 'beer',
      sameProductIds: [],
      altProductIds: [],
      alertLevel: 'good',
      section: 'keg',
      createdAt: '',
    });

    // Keg only, without price history.
    const parts = { pantry: true, sections: ['keg' as const], list: false, cards: false, settings: false };
    const tables = pickSnapshot(await snapshot(), parts, { prices: false });
    expect(tables.groups.map((g) => g.id)).toEqual(['keg-1']);
    expect(tables.products.map((p) => p.id)).toEqual(['beer']);
    expect(tables.prices).toEqual([]);
    expect(tables.kv).toEqual([]);
    const summary = readBackup(JSON.stringify({ app: 'restock', version: 2, exportedAt: '', parts: { ...parts, prices: false }, tables }));
    expect(summary.sections).toEqual(['keg']);
    expect(summary.counts.bySection).toEqual({ pantry: 0, keg: 1, pharmacy: 0 });
    expect(summary.counts.hasSettings).toBe(false);

    // On the phone, the lager gets renamed; restoring the Keg part puts it back and keeps the pantry.
    const { updateGroup } = await import('./db');
    await updateGroup('keg-1', { name: 'Something else' });
    await restoreBackup(summary, { pantry: true, sections: ['keg'], list: false, cards: false, settings: false });
    const groups = await allGroups();
    expect(groups.filter((g) => (g.section ?? 'pantry') === 'pantry')).toHaveLength(pantryBefore);
    expect(groups.find((g) => g.id === 'keg-1')?.name).toBe('Lager');
    expect((await allProducts()).some((p) => p.id === 'beer')).toBe(true);
    expect((await readingsFor(['beer'])).get('beer') ?? []).toHaveLength(0);
  });

  it("doesn't rename names the person chose", async () => {
    const { suggestRenames } = await import('./backup');
    const groups = [
      { id: 'a', name: 'Choc Wafers', usualProductId: 'p1', sameProductIds: [], altProductIds: [], alertLevel: 'good' as const, createdAt: '' },
      {
        id: 'b',
        name: 'Spaghetti in Tomato Sauce 420g',
        usualProductId: 'p2',
        sameProductIds: [],
        altProductIds: [],
        alertLevel: 'good' as const,
        createdAt: '',
      },
      {
        id: 'c',
        name: "Leggo's Bolognese Pasta Sauce",
        usualProductId: 'p3',
        sameProductIds: [],
        altProductIds: [],
        alertLevel: 'good' as const,
        createdAt: '',
      },
    ];
    const products = [
      { id: 'p1', chain: 'aldi' as const, name: 'Wafer Rolls Choc 350g', createdAt: '' },
      { id: 'p2', chain: 'coles' as const, name: 'Spaghetti in Tomato Sauce 420g', createdAt: '' },
      { id: 'p3', chain: 'woolworths' as const, name: "Leggo's Bolognese Pasta Sauce 500g", brand: "Leggo's", createdAt: '' },
    ];
    expect(suggestRenames(groups, products)).toEqual([
      { groupId: 'b', from: 'Spaghetti in Tomato Sauce 420g', to: 'Spaghetti' },
      { groupId: 'c', from: "Leggo's Bolognese Pasta Sauce", to: 'Pasta sauce' },
    ]);
  });
});

describe('price history setting', () => {
  it('drops old prices but keeps the latest one and the samples', async () => {
    const now = Date.parse('2026-11-06T00:00:00Z');
    const day = 86_400_000;
    await addProduct({ id: 'p1', chain: 'coles', name: 'Old thing', createdAt: new Date(now - 200 * day).toISOString() });
    await addProduct({ id: 'p2', chain: 'aldi', name: 'Stale thing', createdAt: new Date(now - 200 * day).toISOString() });
    const add = (productId: string, daysAgo: number, price: number, source: 'auto' | 'demo' = 'auto') =>
      addReading({ productId, date: new Date(now - daysAgo * day).toISOString(), price, isSpecial: false, memberOnly: false, source });
    await add('p1', 120, 5);
    await add('p1', 90, 4);
    await add('p1', 30, 5);
    await add('p1', 2, 3);
    await add('p2', 150, 2); // only reading: kept even though it's old
    await add('p1', 100, 9, 'demo');
    const removed = await pruneHistory(8, now);
    expect(removed).toBe(2);
    const left = await readingsFor(['p1', 'p2']);
    expect(
      left
        .get('p1')!
        .map((r) => r.price)
        .sort(),
    ).toEqual([3, 5, 9]);
    expect(left.get('p2')!.length).toBe(1);
    expect(await pruneHistory(8, now)).toBe(0);
  });
  it('defaults to 8 weeks', async () => {
    expect((await getSettings()).historyWeeks).toBe(8);
  });
});

describe('shared price history table', () => {
  it('attaches a summary to the matching store product', async () => {
    const { getProducts } = await import('./db');
    await addProduct({ id: 'n1', chain: 'woolworths', name: 'Nutella 1kg', storeProductId: '123456', createdAt: '2026-11-01T00:00:00Z' });
    await addProduct({ id: 'n2', chain: 'coles', name: 'Nutella 1kg', storeProductId: '123456', createdAt: '2026-11-01T00:00:00Z' });
    raw.run(
      "INSERT INTO market (chain, store_product_id, normal, sale, sale_share, low, cycle_weeks, days, source, updated_at) VALUES ('woolworths', '123456', 9.5, 6.5, 0.15, 6.5, 12, 182, 'hotprices.org', '2026-11-05T00:00:00Z')",
    );
    const [a, b] = await getProducts(['n1', 'n2']);
    const byId = new Map([a, b].map((p) => [p.id, p]));
    expect(byId.get('n1')!.market).toMatchObject({ normal: 9.5, sale: 6.5, cycleWeeks: 12, days: 182 });
    expect(byId.get('n2')!.market).toBeUndefined();
  });
});

describe('targeted undo', () => {
  it('puts a deleted item, its products, prices and list line back', async () => {
    const { allGroups, allListEntries, addListEntry, deleteGroup, snapshot, deleteListEntries } = await import('./db');
    const { undoable, groupRows, entryRows } = await import('./undo');
    await loadDemo();
    const [g] = await allGroups();
    await addListEntry({ id: 'l1', text: g.name, groupId: g.id, qty: 3, checked: false, createdAt: '' });
    const before = await snapshot();
    const undo = await undoable(() => deleteGroup(g.id), groupRows([g.id]));
    expect((await allGroups()).find((x) => x.id === g.id)).toBeUndefined();
    await undo();
    const after = await snapshot();
    expect(after.groups).toEqual(before.groups);
    expect(after.products.length).toBe(before.products.length);
    expect(after.prices.length).toBe(before.prices.length);
    expect((await allListEntries()).find((e) => e.id === 'l1')?.groupId).toBe(g.id);

    const undo2 = await undoable(() => deleteListEntries(['l1']), entryRows(['l1']));
    expect((await allListEntries()).find((e) => e.id === 'l1')).toBeUndefined();
    await undo2();
    expect((await allListEntries()).find((e) => e.id === 'l1')?.qty).toBe(3);
  });
});

describe('backup reminder', () => {
  it('nudges monthly once there are a few items', async () => {
    const { needsBackupNudge } = await import('./backup');
    const now = Date.parse('2026-12-01T00:00:00Z');
    const old = '2026-11-01T00:00:00Z';
    expect(needsBackupNudge({}, 2, old, now)).toBe(false);
    expect(needsBackupNudge({}, 5, '2026-11-28T00:00:00Z', now)).toBe(false);
    expect(needsBackupNudge({}, 5, old, now)).toBe(true);
    expect(needsBackupNudge({ lastBackupAt: '2026-11-20T00:00:00Z' }, 5, old, now)).toBe(false);
    expect(needsBackupNudge({ lastBackupAt: '2026-10-01T00:00:00Z' }, 5, old, now)).toBe(true);
    expect(needsBackupNudge({ backupNudgeAt: '2026-11-25T00:00:00Z' }, 5, old, now)).toBe(false);
  });
});

describe('restoring settings', () => {
  it('restoring only pantry items leaves shops, tabs and setup alone (0.6.0 bug)', async () => {
    const { getSettings, updateSettings, snapshot } = await import('./db');
    const { readBackup, restoreBackup } = await import('./backup');
    // An old backup: Keg off, no shops picked, no setup progress.
    await loadDemo();
    await updateSettings({ sections: { keg: false, pharmacy: false }, stores: {} });
    const old = await snapshot();
    old.kv = old.kv.map((k) => (k.key === 'settings' ? { ...k, value: { ...(k.value as object), setup: undefined, look: undefined } } : k));
    const file = JSON.stringify({ app: 'restock', version: 2, exportedAt: '2026-10-01T00:00:00Z', tables: old });
    // This phone: set up with Keg and Pharmacy on and a store picked.
    await removeDemo();
    await updateSettings({
      sections: { keg: true, pharmacy: true },
      stores: { woolworths: { storeId: '1234', primary: 'Woolworths Kirwan' } },
      setup: { done: ['pantry', 'keg'], skipped: [] },
      theme: 'dark',
    });
    await restoreBackup(readBackup(file), { pantry: true, sections: ['pantry'], list: false, cards: false, settings: false, shops: false });
    const s = await getSettings();
    expect(s.sections).toEqual({ keg: true, pharmacy: true });
    expect(s.stores.woolworths?.primary).toBe('Woolworths Kirwan');
    expect(s.setup.done).toEqual(['pantry', 'keg']);
    expect(s.theme).toBe('dark');
  });

  it('restoring one tab’s shops leaves the other tabs’ shops alone', async () => {
    const { getSettings, updateSettings, mergeRestoredSettings } = await import('./db');
    await updateSettings({
      enabledChains: ['woolworths', 'coles', 'bws', 'chemistwarehouse'],
      sections: { keg: true, pharmacy: true },
      stores: {
        woolworths: { primary: 'Woolworths Kirwan' },
        bws: { primary: 'BWS Upper Ross Drive' },
        chemistwarehouse: { primary: 'CW Townsville' },
      },
    });
    const cur = await getSettings();
    // An older backup: groceries only, Keg and Pharmacy off, and no branch for Woolworths.
    const incoming = {
      enabledChains: ['woolworths', 'aldi'],
      sections: { keg: false, pharmacy: false },
      stores: { woolworths: {}, aldi: { primary: 'Aldi Kirwan' } },
    };
    const s = mergeRestoredSettings(cur, incoming as never, { shops: true, shopSections: ['pantry'] });
    expect(s.sections).toEqual({ keg: true, pharmacy: true });
    expect([...s.enabledChains].sort()).toEqual(['aldi', 'bws', 'chemistwarehouse', 'woolworths']);
    expect(s.stores.bws?.primary).toBe('BWS Upper Ross Drive');
    expect(s.stores.chemistwarehouse?.primary).toBe('CW Townsville');
    expect(s.stores.woolworths?.primary).toBe('Woolworths Kirwan');
    expect(s.stores.aldi?.primary).toBe('Aldi Kirwan');
    expect(s.stores.coles).toBeUndefined();
  });

  it('shops and other settings restore separately, and this phone’s own settings stay', async () => {
    const { getSettings, updateSettings, mergeRestoredSettings } = await import('./db');
    await updateSettings({
      onboarded: true,
      theme: 'dark',
      sections: { keg: true, pharmacy: false },
      receipts: { enabled: true, installed: true, keepMonths: 3 },
      look: { style: 'australia', icon: 'navy' },
      setup: { done: ['permissions'], skipped: ['look'] },
    });
    const cur = await getSettings();
    const incoming = {
      theme: 'light' as const,
      sections: { keg: false, pharmacy: true },
      onboarded: false,
      receipts: { enabled: false, installed: false, keepMonths: 6 },
      look: { style: 'plain' as const, icon: 'red' },
    };
    const shopsOnly = mergeRestoredSettings(cur, incoming, { shops: true });
    expect(shopsOnly.sections).toEqual({ keg: false, pharmacy: true });
    expect(shopsOnly.theme).toBe('dark');
    expect(shopsOnly.setup.done).toEqual(expect.arrayContaining(['permissions', 'pantry', 'keg', 'pharmacy']));
    const otherOnly = mergeRestoredSettings(cur, incoming, { other: true });
    expect(otherOnly.sections).toEqual({ keg: true, pharmacy: false });
    expect(otherOnly.theme).toBe('light');
    expect(otherOnly.onboarded).toBe(true);
    expect(otherOnly.receipts).toEqual({ enabled: false, installed: true, keepMonths: 6 });
    expect(otherOnly.look).toEqual({ style: 'plain', icon: 'navy' });
    expect(otherOnly.setup.skipped).toEqual([]);
  });
});
