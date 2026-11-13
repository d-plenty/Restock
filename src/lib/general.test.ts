import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { asListSection, LIST_NAMES, LIST_SECTIONS, listSectionsOn, listShareTab } from '../shops';
import { DEFAULT_SETTINGS, type ListEntry, type Settings } from '../types';
import { entrySection, listShops, listSums, searchTabOf, shopOf } from '../ui/screens/List';
import { widgetList } from './widgets';
import { fromBackupList, toBackupList } from './backup';
import { needsMatch } from './listPicks';
import { haListFor, onHaList } from './haSync';
import { createSqlJsDriver } from './sql/sqljs';
import { migrate } from './sql/schema';
import { WebSyncEngine, type Entry } from '../server-mode/engine';
import { syncDbOf } from '../server-mode/sqldb';
import { signedText, verifySig } from '../server-mode/crypto';

// 0.9.5: the General shopping list (list_entries.section 'general'): a list only, no pantry. What it's
// called and shown with, how its lines are grouped, what Home Assistant puts there, backups, and how
// sync shares it (with the groceries).

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  enabledChains: ['coles', 'woolworths', 'danmurphys'],
  sections: { keg: true, pharmacy: false },
  ...over,
});
const line = (id: string, text: string, more: Partial<ListEntry> = {}): ListEntry => ({ id, text, checked: false, createdAt: '2026-11-10T00:00:00.000Z', ...more });

describe('General: names and sections', () => {
  it('is the fourth list, after the tabs, with its own name', () => {
    expect(LIST_SECTIONS).toEqual(['pantry', 'keg', 'pharmacy', 'baby', 'pets', 'general']);
    expect(LIST_NAMES).toEqual({ pantry: 'Groceries', keg: 'Keg', pharmacy: 'Health', baby: 'Baby', pets: 'Pets', general: 'General' });
  });
  it('a stored section: general kept, anything unknown is the grocery list', () => {
    expect(['general', 'keg', 'pharmacy', 'pantry', null, undefined, 'tools'].map(asListSection)).toEqual(['general', 'keg', 'pharmacy', 'pantry', 'pantry', 'pantry', 'pantry']);
  });
  it('shares with the groceries (What this phone shares, household sync)', () => {
    expect(['general', 'pantry', 'keg', 'pharmacy', undefined].map((s) => listShareTab(s as never))).toEqual(['pantry', 'pantry', 'keg', 'pharmacy', 'pantry']);
  });
  it('always shows, after the tabs that are on', () => {
    expect(listSectionsOn(settings())).toEqual(['pantry', 'keg', 'general']);
    expect(listSectionsOn(settings({ sections: { keg: false, pharmacy: false } }))).toEqual(['pantry', 'general']);
  });
  it('a General line searched for (Find the cheapest) is searched at the supermarkets', () => {
    expect(searchTabOf('general')).toBe('pantry');
    expect(searchTabOf('keg')).toBe('keg');
  });
});

describe('General: the list', () => {
  const entries = [
    line('g1', 'Chopsticks', { section: 'general' }),
    line('g2', 'Batteries', { section: 'general', chain: 'danmurphys' }),
    line('p1', 'Bananas', { section: 'pantry' }),
    line('p2', 'chips'),
    line('k1', 'Ice', { section: 'keg' }),
  ];
  it('has only its own lines, and no pantry items', () => {
    const s = listSums(entries, [], settings(), 'general');
    expect(s.section).toBe('general');
    expect(s.entries.map((e) => e.id)).toEqual(['g1', 'g2']);
    expect(s.recs).toEqual([]);
    expect(s.c.title).toBe('General list');
  });
  it('By shop: under Any shop unless a shop is picked; any tab’s shops can be picked', () => {
    const s = listSums(entries, [], settings(), 'general');
    expect(shopOf(s.c, entries[0])).toBe('any');
    expect(shopOf(s.c, entries[1])).toBe('danmurphys');
    expect(s.c.order).toEqual(expect.arrayContaining(['coles', 'woolworths', 'danmurphys', 'other', 'any']));
    expect(s.c.order.slice(-2)).toEqual(['other', 'any']);
    expect(listShops(settings().enabledChains, 'general', listSectionsOn(settings()))).toEqual(['coles', 'woolworths', 'danmurphys']);
    expect(listShops(settings().enabledChains, 'keg', listSectionsOn(settings()))).toEqual(['danmurphys']);
  });
  it('typed lines on Groceries stay on Groceries (nothing moves to General by itself)', () => {
    const s = listSums(entries, [], settings(), 'pantry');
    expect(s.entries.map((e) => e.id)).toEqual(['p1', 'p2']);
    expect(entrySection(entries[3], new Map())).toBe('pantry');
  });
  it('a General line linked to a pantry item is on its item’s list', () => {
    expect(entrySection(line('x', 'Milk', { section: 'general', groupId: 'g-milk' }), new Map([['g-milk', 'pantry' as const]]))).toBe('pantry');
  });
  it('the widget and its count take General too, after the others', () => {
    const { open } = widgetList(entries, [], settings());
    expect(open.map((e) => e.id)).toEqual(['p1', 'p2', 'k1', 'g2', 'g1']);
  });
  it('"Pick my …" shows on a General line from Home Assistant too', () => {
    expect(needsMatch(line('ha-1', 'chopsticks', { section: 'general' }), new Set())).toBe(true);
    expect(needsMatch(line('ha-2', 'ice', { section: 'keg' }), new Set())).toBe(false);
  });
});

describe('General: Home Assistant', () => {
  it('a line is on Home Assistant’s list when it’s on Groceries or General, or came from Home Assistant', () => {
    expect(onHaList('r1', 'pantry')).toBe(true);
    expect(onHaList('r1', 'general')).toBe(true);
    expect(onHaList('r1', 'keg')).toBe(false);
    expect(onHaList('ha-abc', 'keg')).toBe(true);
  });
  it('matches go on the first tab with any (pantry, Keg, Health); none: General', () => {
    const milk = { id: 'g', name: 'Milk' };
    const kmilk = { id: 'k', name: 'Milk', section: 'keg' };
    const hband = { id: 'h', name: 'Bandaids', section: 'pharmacy' };
    expect(haListFor([kmilk, milk])).toEqual({ found: [milk], section: 'pantry' });
    expect(haListFor([hband])).toEqual({ found: [hband], section: 'pharmacy' });
    expect(haListFor([])).toEqual({ found: [], section: 'general' });
  });
});

describe('General: backups', () => {
  it('General lines go without a section (an older Restock puts them on Groceries) and come back on General', () => {
    const list = [line('g1', 'Chopsticks', { section: 'general' }), line('p1', 'Milk', { section: 'pantry' })];
    const out = toBackupList(list);
    const json = JSON.parse(JSON.stringify(out));
    expect(json[0].section).toBeUndefined();
    expect(json[0].list).toBe('general');
    expect(fromBackupList(json)).toEqual(list);
    // An old backup's lines are as they were.
    expect(fromBackupList([line('o', 'Bread')])).toEqual([line('o', 'Bread')]);
  });
});

describe('General: sync shares it with the groceries', () => {
  let SQL: SqlJsStatic;
  beforeAll(async () => {
    SQL = await initSqlJs();
  });
  const engine = async () => {
    const d = await createSqlJsDriver({ load: async () => SQL });
    await migrate(d);
    const e = new WebSyncEngine(syncDbOf(d.raw), verifySig, signedText);
    e.setMeta('device', 'web-test');
    return e;
  };
  const ent = (pk: string, row: Record<string, unknown>): Entry => ({ tbl: 'list_entries', pk, stamp: Date.now(), device: 'a1phone', created: Date.now(), deleted: false, row });

  it('a General line is the groceries’ tab: taken in, and sent only where the groceries go', async () => {
    const e = await engine();
    const row = { id: 'g1', text: 'Chopsticks', checked: 0, qty: 1, created_at: 'x', section: 'general' };
    expect(e.tabOf('list_entries', row)).toBe('pantry');
    expect(e.apply([ent('g1', row)])).toBe(1);
    expect(e.db.query("SELECT section FROM list_entries WHERE id = 'g1'")).toEqual([{ section: 'general' }]);
    expect(e.collect(0, null, 100, new Set(['pantry']), '', true, 0).entries.find((x) => x.pk === 'g1')?.row?.section).toBe('general');
    const kegOnly = e.collect(0, null, 100, new Set(['keg']), '', true, 0).entries.find((x) => x.pk === 'g1');
    expect(kegOnly?.row).toBeUndefined();
  });

  it('the first sync on this version reads every file again, once', async () => {
    const e = await engine();
    e.setMeta('folder_seen:restock-sync-a1phone.bin', 'abc');
    expect(e.catchUpLists()).toBe(true);
    expect(e.meta('folder_seen:restock-sync-a1phone.bin')).toBeNull();
    expect(e.meta('lists_v')).toBe('95');
    e.setMeta('folder_seen:restock-sync-a1phone.bin', 'abc');
    expect(e.catchUpLists()).toBe(false);
    expect(e.meta('folder_seen:restock-sync-a1phone.bin')).toBe('abc');
  });
});
