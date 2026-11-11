import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { migrate } from '../lib/sql/schema';
import { WebSyncEngine, isCostcoLine, keepLocalCostcoLine, stripCostcoLine, type Entry } from '../server-mode/engine';
import { syncDbOf } from '../server-mode/sqldb';
import { signedText, verifySig } from '../server-mode/crypto';
import { COSTCO_LIST_NOTE, costcoOf, isCostcoListLine, listLineWithoutCostco, withCostcoKept } from '../lib/costcoLocal';
import { checkAtCostco, costcoCheckable } from '../lib/costcoCheck';
import { notAtChains } from '../lib/picks';
import { costcoNotHere, setCostcoState } from '../shops';
import { checkSettings } from '../lib/settingsCheck';
import type { StoreAdapter } from './types';
import type { Group, Product } from '../types';
import type { Snapshot } from '../lib/db';

// 0.9.6 review fixes H1, L1, L2, L5 (Costco).

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
const phone = async (id: string) => {
  const d = await createSqlJsDriver({ load: async () => SQL });
  await migrate(d);
  const e = new WebSyncEngine(syncDbOf(d.raw), verifySig, signedText);
  e.setMeta('device', id);
  return e;
};
type Phone = Awaited<ReturnType<typeof phone>>;
/** Everything `from` has that `to` hasn't had yet (as a sync round sends it), in. */
const send = (from: Phone, to: Phone, since = 0) => {
  const out = from.collect(since, null, 1000, new Set(['pantry']), '', true, 0);
  to.apply(out.entries);
  return out;
};
const lineOn = (p: Phone, id: string) => p.db.query('SELECT chain, price, product, checked, qty, text FROM list_entries WHERE id = ?', [id])[0];
const PRODUCT = JSON.stringify({ chain: 'costco', name: 'Milk 3 x 2L', storeProductId: '51210' });

describe('H1: a shopping list line at Costco is an ordinary shared line (sync)', () => {
  const setup = async () => {
    const a = await phone('a1phone');
    const b = await phone('b2phone');
    // A shared Coles line, then put at Costco on a (as an earlier 0.9.6 build let it).
    a.db.exec("INSERT INTO list_entries (id, text, chain, price, checked, qty, qty_at, created_at, section) VALUES ('l1', 'Milk', 'coles', 3.1, 0, 1, 1, 'x', 'pantry')");
    const first = send(a, b);
    a.db.exec("UPDATE list_entries SET chain = 'costco', price = 9.99, product = ? WHERE id = 'l1'", [PRODUCT]);
    return { a, b, top: first.top };
  };

  it('goes to the other phone as Any shop: no Costco shop, price or product leaves the phone', async () => {
    const { a, b, top } = await setup();
    const out = a.collect(top, null, 1000, new Set(['pantry']), '', true, 0);
    const sent = out.entries.find((x) => x.tbl === 'list_entries' && x.pk === 'l1')!;
    expect(sent).toBeDefined();
    expect(sent.row).toMatchObject({ chain: null, price: null, product: null, text: 'Milk' });
    expect(JSON.stringify(out.entries)).not.toMatch(/costco|9\.99|51210/i);
    b.apply(out.entries);
    expect(lineOn(b, 'l1')).toMatchObject({ chain: null, price: null, product: null, text: 'Milk' });
    // This phone keeps its own Costco line.
    expect(lineOn(a, 'l1')).toMatchObject({ chain: 'costco', price: 9.99 });
  });

  it('a tick on a line that came from Costco reaches the other phone', async () => {
    const { a, b, top } = await setup();
    a.db.exec('UPDATE list_entries SET checked = 1, checked_at = ? WHERE id = ?', [Date.now(), 'l1']);
    send(a, b, top);
    expect(lineOn(b, 'l1').checked).toBe(1);
  });

  it('a delete from another phone takes it off this phone', async () => {
    const { a, b, top } = await setup();
    send(a, b, top);
    const bTop = Number(b.db.query('SELECT COALESCE(MAX(seq), 0) AS n FROM sync_log')[0].n);
    b.db.exec("DELETE FROM list_entries WHERE id = 'l1'");
    send(b, a, bTop);
    expect(lineOn(a, 'l1')).toBeUndefined();
  });

  it('another phone’s change comes in (never ignored); the Costco details stay here only while they leave the shop as Any shop', async () => {
    const { a, b, top } = await setup();
    send(a, b, top);
    let bTop = Number(b.db.query('SELECT COALESCE(MAX(seq), 0) AS n FROM sync_log')[0].n);
    b.db.exec('UPDATE list_entries SET qty = 4, qty_at = ? WHERE id = ?', [Date.now() + 10, 'l1']);
    send(b, a, bTop);
    expect(lineOn(a, 'l1')).toMatchObject({ qty: 4, chain: 'costco', price: 9.99 });
    bTop = Number(b.db.query('SELECT COALESCE(MAX(seq), 0) AS n FROM sync_log')[0].n);
    b.db.exec("UPDATE list_entries SET chain = 'woolworths' WHERE id = 'l1'");
    send(b, a, bTop);
    expect(lineOn(a, 'l1')).toMatchObject({ chain: 'woolworths', product: null });
  });

  it('a line an earlier build kept back is sent again once (resendCostcoLines)', async () => {
    const a = await phone('a1phone');
    a.db.exec("INSERT INTO list_entries (id, text, chain, price, checked, qty, created_at) VALUES ('l9', 'Nuts', 'costco', 23.99, 1, 1, 'x')");
    const top = Number(a.db.query('SELECT MAX(seq) AS n FROM sync_log')[0].n);
    a.noteTabs();
    const again = a.collect(top, null, 1000, new Set(['pantry']), '', true, 0).entries.filter((x) => x.pk === 'l9');
    expect(again).toHaveLength(1);
    expect(again[0].row).toMatchObject({ chain: null, price: null, product: null, checked: 1 });
    // Only once.
    const top2 = Number(a.db.query('SELECT MAX(seq) AS n FROM sync_log')[0].n);
    a.noteTabs();
    expect(a.collect(top2, null, 1000, new Set(['pantry']), '', true, 0).entries).toHaveLength(0);
  });

  it('the line helpers: a Costco product behind a line counts too; other lines are left alone', () => {
    expect(isCostcoLine({ chain: null, product: PRODUCT })).toBe(true);
    expect(isCostcoLine({ chain: 'coles', product: null })).toBe(false);
    const row = { chain: 'coles', price: 2, product: null };
    stripCostcoLine(row);
    expect(row).toEqual({ chain: 'coles', price: 2, product: null });
    const merged: Record<string, unknown> = { chain: null, price: null, product: null, text: 'Bread' };
    keepLocalCostcoLine({ chain: 'costco', price: 1, product: PRODUCT, text: 'Milk' }, merged);
    expect(merged.chain).toBeNull(); // new words: theirs
  });
});

describe('H1: a list line is never saved at Costco (the screens and db.ts)', () => {
  it('listLineWithoutCostco keeps the words and drops the shop, price and product', () => {
    const e = { id: 'x', text: 'Nuts', chain: 'costco' as const, price: 23.99, product: { chain: 'costco' as const, name: 'Nuts' }, checked: false, createdAt: 'x' };
    expect(isCostcoListLine(e)).toBe(true);
    const out = listLineWithoutCostco(e);
    expect(out).toMatchObject({ id: 'x', text: 'Nuts', chain: undefined, price: undefined, product: undefined });
    const coles = { ...e, chain: 'coles' as const, product: undefined };
    expect(listLineWithoutCostco(coles)).toBe(coles);
    // A change that only ticks is left as it is.
    expect(listLineWithoutCostco({ checked: true })).toEqual({ checked: true });
    expect(COSTCO_LIST_NOTE).toBe('Costco prices stay on this phone, so the line is added as Any shop.');
  });

  describe('through the database', () => {
    beforeEach(async () => {
      const { initDb, ensureDefaults } = await import('../lib/db');
      await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
      await ensureDefaults();
    });
    it('adding or changing a line to Costco saves it as Any shop', async () => {
      const db = await import('../lib/db');
      await db.addListEntry({ id: 'n1', text: 'Nuts', chain: 'costco', price: 23.99, product: { chain: 'costco', name: 'Nuts' }, checked: false, createdAt: 'x' });
      await db.addListEntry({ id: 'n2', text: 'Bread', chain: 'coles', price: 3, checked: false, createdAt: 'x' });
      await db.updateListEntry('n2', { chain: 'costco', price: 5 });
      const rows = await db.allListEntries();
      expect(rows.find((r) => r.id === 'n1')).toMatchObject({ text: 'Nuts', chain: undefined, price: undefined, product: undefined });
      expect(rows.find((r) => r.id === 'n2')).toMatchObject({ text: 'Bread', chain: undefined, price: undefined });
    });
  });

  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  it('the screens: no Costco in a line’s shop chooser; Add, the hand-add sheet and shared links say so plainly', () => {
    expect(src('ui/screens/List.tsx')).toMatch(/shops\.filter\(\(x\) => !isLocalOnlyShop\(x\)\)\.map/);
    const add = src('ui/screens/Add.tsx');
    expect(add.match(/COSTCO_LIST_NOTE/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src('lib/shared.ts')).toMatch(/costcoLink \? undefined : found/);
  });
});

describe('L1: Costco is asked only when the person presses Search', () => {
  const root = join(__dirname, '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
    });
  const all = files(root).map((p) => ({ p: p.slice(root.length + 1), text: readFileSync(p, 'utf8') }));

  it('every adapterFor( call outside the Search press leaves Costco out (guard)', () => {
    const calls = all.flatMap((f) => [...f.text.matchAll(/adapterFor\(/g)].map(() => f.p)).filter((p) => p !== 'stores/index.ts');
    const counts: Record<string, number> = {};
    for (const p of calls) counts[p] = (counts[p] ?? 0) + 1;
    // Each with why it never asks Costco unless Search was pressed. A new caller fails this test.
    expect(counts).toEqual({
      'ui/screens/Add.tsx': 2, // searchChain (the Search press, or "Search Costco") and followAdapter (refuses Costco)
      'ui/screens/Diagnostics.tsx': 1, // its shops filter isLocalOnlyShop out
      'ui/screens/Stores.tsx': 1, // a shop the person added (custom-…), never Costco
      'lib/health.ts': 1, // filters isLocalOnlyShop out
      'lib/lookup.ts': 1, // Woolworths and Coles only
      'lib/check.ts': 1, // "Check now": filters isLocalOnlyShop out
      'lib/searchTest.ts': 1, // testShops filters isLocalOnlyShop out
    });
    expect(all.find((f) => f.p === 'lib/check.ts')!.text).toMatch(/!isLocalOnlyShop\(p\.chain\) && isPageless/);
    expect(all.find((f) => f.p === 'lib/health.ts')!.text).toMatch(/filter\(\(c\) => !isLocalOnlyShop\(c\)\)/);
    expect(all.find((f) => f.p === 'lib/searchTest.ts')!.text).toMatch(/filter\(\(c\) => !isLocalOnlyShop\(c\)\)/);
    expect(all.find((f) => f.p === 'ui/screens/Diagnostics.tsx')!.text).toMatch(/filter\(\(c\) => !isLocalOnlyShop\(c\)\)/);
  });

  it('the Costco reader itself is used in one place only: "Check at Costco" on an item', () => {
    const users = all.filter((f) => /from '(\.\.\/)+stores\/costco'|from '\.\/costco'/.test(f.text)).map((f) => f.p).sort();
    expect(users).toEqual(['lib/costcoCheck.ts', 'stores/index.ts']);
    const item = all.find((f) => f.p === 'ui/screens/Item.tsx')!.text;
    expect(item).toMatch(/onClick=\{\(\) => void checkCostco\(p\)\}/);
    expect(item).toContain("'Check at Costco'");
  });

  it('Add.tsx: only the Search press asks Costco; a scan, opening from an item, the tab chip and quick picks leave it out', () => {
    const add = all.find((f) => f.p === 'ui/screens/Add.tsx')!.text;
    expect(add).toMatch(/chainsToSearch\(s\.enabledChains, sec\)\.filter\(\(c\) => pressed \|\| !isLocalOnlyShop\(c\)\)/);
    // The search calls that say pressed: the search box (text or a typed code) and "What is it?".
    expect([...add.matchAll(/runText\(t, true\)|handleBarcode\(code, false, true\)|scanned\.barcode \}, section, true\)/g)]).toHaveLength(3);
    // Everything else: no `true` for pressed.
    for (const m of add.matchAll(/void search\(([^;]*)\);/g)) if (!m[1].includes('section, true')) expect(m[1]).not.toMatch(/, true\)?$/);
    expect(add).toMatch(/if \(barcode\) void handleBarcode\(barcode\);/); // a scan from elsewhere
    expect(add).toMatch(/if \(query && ready && settings\) void search\(query, \{ text: query \}\);/); // "Find at another store"
    expect(add).toMatch(/if \(lastText\) void search\(lastText, rankQ, sec\);/); // the tab chip
    expect(add).toContain('Search Costco');
  });

  it('the background and "Check now" for everything never ask Costco (PriceChecker.java)', () => {
    const java = readFileSync(join(root, '..', 'android/app/src/main/java/family/plenty/restock/PriceChecker.java'), 'utf8');
    expect(java).toMatch(/if \("costco"\.equals\(chain\)\) continue;/);
  });

  it('"Check at Costco": one search for the item number, a price saved; nothing for other shops', async () => {
    const { initDb, ensureDefaults, addProduct, readingsFor } = await import('../lib/db');
    await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
    await ensureDefaults();
    const p: Product = { id: 'c1', chain: 'costco', name: 'Nuts 1.13kg', storeProductId: '277790', createdAt: 'x' };
    await addProduct(p);
    const asked: string[] = [];
    const reader: StoreAdapter = {
      chain: 'costco',
      search: async (t: string) => {
        asked.push(t);
        return [{ chain: 'costco', storeProductId: '277790', name: 'Nuts 1.13kg', price: 23.99 } as never];
      },
    };
    const r = await checkAtCostco(p, reader);
    expect(asked).toEqual(['277790']);
    expect(r).toMatchObject({ ok: true });
    expect(r.text).toContain('Online price, includes delivery');
    expect(((await readingsFor(['c1'])).get('c1') ?? []).map((x) => x.price)).toEqual([23.99]);
    const w: Product = { ...p, id: 'w1', chain: 'woolworths' };
    expect((await checkAtCostco(w, reader)).ok).toBe(false);
    expect(asked).toHaveLength(1);
    expect(costcoCheckable([p, w]).map((x) => x.id)).toEqual(['c1']);
  });

  describe('"Not at Costco" stays on this phone', () => {
    afterEach(() => setCostcoState(undefined));
    it('is kept in this phone’s own Costco setting, not the shared item, and still counts', () => {
      setCostcoState({ on: true, notAt: ['g1'] });
      expect(costcoNotHere('g1')).toBe(true);
      const g: Pick<Group, 'id' | 'notAt' | 'usualProductId' | 'sameProductIds'> = { id: 'g1', notAt: ['aldi'], sameProductIds: [] };
      expect(notAtChains(g, () => undefined)).toEqual(['aldi', 'costco']);
      expect(notAtChains({ ...g, id: 'g2' }, () => undefined)).toEqual(['aldi']);
      const item = readFileSync(join(root, 'ui/screens/Item.tsx'), 'utf8');
      expect(item).toMatch(/if \(isLocalOnlyShop\(c\)\) return setCostcoNotAt\(true\);/);
    });
    it('the setting is checked like the rest (strings only, capped)', () => {
      const s = checkSettings({ costco: { on: true, acceptedAt: '2026-11-11T01:00:00.000Z', notAt: ['g1', 7, 'g1', 'x'.repeat(200)] } });
      expect(s.costco?.notAt).toEqual(['g1']);
    });
    it('is not one of the household’s shared settings', async () => {
      const shared = readFileSync(join(root, 'lib/sharedSettings.ts'), 'utf8');
      expect(shared).not.toMatch(/['"]costco['"]\s*[,\]]/);
    });
  });
});

describe('L2: taking out Costco picks leaves other phones’ own picks', () => {
  const setup = async () => {
    const a = await phone('a1phone');
    a.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('w1', 'woolworths', 'Pasta', 'x')");
    a.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('c1', 'costco', 'Pasta 10 x 500g', 'x')");
    return a;
  };
  it('a usual pick at Costco is left out of what is sent; the other phone keeps its own usual pick', async () => {
    const a = await setup();
    const b = await phone('b2phone');
    a.db.exec("INSERT INTO items (id, name, usual_product_id, same_product_ids, alert_level, created_at) VALUES ('g1', 'Pasta', 'w1', '[]', 'good', 'x')");
    send(a, b);
    b.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('k1', 'coles', 'Pasta 1kg', 'x')");
    b.db.exec("UPDATE items SET usual_product_id = 'k1' WHERE id = 'g1'");
    const top = Number(a.db.query('SELECT MAX(seq) AS n FROM sync_log')[0].n);
    await new Promise((r) => setTimeout(r, 5)); // a's change after b's
    a.db.exec("UPDATE items SET usual_product_id = 'c1', name = 'Pasta shapes' WHERE id = 'g1'");
    const out = send(a, b, top);
    expect(JSON.stringify(out.entries)).not.toContain('c1');
    expect(b.db.query("SELECT name, usual_product_id FROM items WHERE id = 'g1'")[0]).toEqual({ name: 'Pasta shapes', usual_product_id: 'k1' });
  });
  it('lists without a Costco product go exactly as they are (not rewritten)', async () => {
    const a = await setup();
    a.db.exec("INSERT INTO items (id, name, usual_product_id, same_product_ids, alt_product_ids, alert_level, created_at) VALUES ('g2', 'Rice', 'w1', '[\"w1\", \"w2\"]', '[ ]', 'good', 'x')");
    const sent = a.collect(0, null, 1000, new Set(['pantry']), '', true, 0).entries.find((x: Entry) => x.pk === 'g2')!;
    expect(sent.row).toMatchObject({ usual_product_id: 'w1', same_product_ids: '["w1", "w2"]', alt_product_ids: '[ ]' });
  });
});

describe('L5: a restore keeps this phone’s own Costco data (backups never have it)', () => {
  const p = (id: string, chain: string): Product => ({ id, chain: chain as never, name: id, storeProductId: id, createdAt: 'x' });
  const g = (over: Partial<Group>): Group => ({ id: 'g1', name: 'Pasta', sameProductIds: [], altProductIds: [], alertLevel: 'normal' as never, createdAt: 'x', ...over });
  const base = (): Snapshot => ({ products: [], groups: [], prices: [], list: [], cards: [], categories: [], kv: [] });

  it('withCostcoKept puts the picks, products, prices and setting back; a copy with its own Costco data is as it is', () => {
    const here = costcoOf({
      products: [p('w1', 'woolworths'), p('c1', 'costco'), p('c2', 'costco')],
      prices: [{ productId: 'c1', date: 'd', price: 23.99, isSpecial: false, memberOnly: false, source: 'auto' }],
      groups: [g({ usualProductId: 'c1', sameProductIds: ['w1'] }), g({ id: 'gone', usualProductId: 'c2' })],
      kv: [{ key: 'settings', value: { costco: { on: true, acceptedAt: 'x', notAt: ['g7'] } } }],
    });
    const backup: Snapshot = {
      ...base(),
      products: [p('w1', 'woolworths')],
      groups: [g({ sameProductIds: ['w1'] })],
      kv: [{ key: 'settings', value: { theme: 'dark' } }],
    };
    const out = withCostcoKept(backup, here);
    expect(out.groups[0]).toMatchObject({ usualProductId: 'c1', sameProductIds: ['w1'] });
    expect(out.products.map((x) => x.id).sort()).toEqual(['c1', 'w1']); // c2's item isn't in the backup
    expect(out.prices.map((x) => x.price)).toEqual([23.99]);
    expect(out.kv[0].value).toEqual({ theme: 'dark', costco: { on: true, acceptedAt: 'x', notAt: ['g7'] } });
    const copy = { ...backup, products: [...backup.products, p('c9', 'costco')] };
    expect(withCostcoKept(copy, here)).toBe(copy);
  });

  it('a full restore from a backup file on the same phone keeps its Costco products, prices, picks and setting', async () => {
    const db = await import('../lib/db');
    const { backupJson, EVERYTHING, importBackup, readBackup, restoreBackup } = await import('../lib/backup');
    await db.initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
    await db.ensureDefaults();
    await db.addProduct(p('w1', 'woolworths'));
    await db.addProduct(p('c1', 'costco'));
    await db.addReading({ productId: 'c1', date: '2026-11-10T02:00:00.000Z', price: 23.99, isSpecial: false, memberOnly: false, source: 'auto' });
    await db.addGroup(g({ usualProductId: 'w1', sameProductIds: ['c1'] }));
    await db.updateSettings({ costco: { on: true, acceptedAt: '2026-11-11T01:00:00.000Z', notAt: ['g1'] } });
    const file = await backupJson(EVERYTHING);
    expect(file).not.toMatch(/costco/i);
    const check = async () => {
      expect((await db.allProducts()).map((x) => x.id).sort()).toEqual(['c1', 'w1']);
      expect((await db.allGroups())[0].sameProductIds).toContain('c1');
      expect(((await db.readingsFor(['c1'])).get('c1') ?? []).map((x) => x.price)).toEqual([23.99]);
      expect((await db.getSettings()).costco).toMatchObject({ on: true, notAt: ['g1'] });
    };
    await importBackup(file);
    await check();
    await restoreBackup(readBackup(file), { pantry: true, list: true, cards: true, settings: true, prices: true, receipts: true } as never);
    await check();
    // "Erase everything" still removes it.
    await db.eraseEverything();
    expect(await db.allProducts()).toEqual([]);
  });
});
