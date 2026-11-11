import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { addGroup, addListEntry, allListEntries, ensureDefaults, initDb } from './db';
import { createSqlJsDriver } from './sql/sqljs';
import { migrate } from './sql/schema';
import { clearUndo, lastStep, undo } from './undo';
import { linkMoved, listOfLine, moveAll, moveFacts, moveLine, moveNote, moveTo, pickableFor, pickMoved, planMove, type MoveFacts } from './moveLine';
import { moveTo as moveToFromListActions } from './listActions';
import { saveAlias } from './listPicks';
import { dbStore } from './homeAssistant';
import { onHaList, syncRound } from './haSync';
import { WebSyncEngine, type Entry } from '../server-mode/engine';
import { syncDbOf } from '../server-mode/sqldb';
import { signedText, verifySig } from '../server-mode/crypto';
import { chainName, type Category, type Group, type ListEntry } from '../types';

// 0.9.6: "Move to" another list (moveLine.ts): what a move keeps and changes, Undo, how it syncs
// (no new record kind: a 0.9.5 phone or server takes it as ordinary list changes), and that Home
// Assistant's rounds never move it back.

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
const facts = (over: Partial<MoveFacts> = {}): MoveFacts => ({ groups: [], categories: [], aliases: {}, entries: [], ...over });
const rows = (sql: string) => {
  const r = raw.exec(sql)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};
const listTable = () => rows('SELECT id, text, item_id, chain, category_id, qty, price, section, product, checked, created_at FROM list_entries ORDER BY id');

describe('Move to: the rules', () => {
  const milk = group('g-milk', 'Milk', { categoryId: 'c-dairy' });
  const kice = group('k-ice', 'Ice', { section: 'keg', categoryId: 'c-kegx' });
  const kice2 = group('k-ice2', 'Ice bag', { section: 'keg' });
  const hband = group('h-band', 'Bandaids', { section: 'pharmacy' });
  const cats: Category[] = [
    { id: 'c-dairy', name: 'Dairy', order: 1, section: 'pantry' },
    { id: 'c-kegx', name: 'Mixers', order: 1, section: 'keg' },
  ];
  const f = facts({ groups: [milk, kice, kice2, hband], categories: cats });

  it('a line is on its item’s list, else its own', () => {
    expect(listOfLine(line('a', 'Milk', { groupId: 'g-milk', section: 'general' }), f.groups)).toBe('pantry');
    expect(listOfLine(line('a', 'Tape', { section: 'general' }), f.groups)).toBe('general');
    expect(listOfLine(line('a', 'Ice'), f.groups)).toBe('pantry');
  });

  it('on that list already: nothing to do', () => {
    expect(planMove(line('a', 'Ice', { section: 'keg' }), 'keg', f)).toBeUndefined();
  });

  it('a pantry item’s line to General keeps its words only (and says so), same id, amount and tick kept', () => {
    const e = line('a', 'Milk', { groupId: 'g-milk', categoryId: 'c-dairy', qty: 3, checked: true, chain: 'coles' });
    const p = planMove(e, 'general', f)!;
    expect(p.inPlace).toBe(true);
    expect(p.line).toEqual({ id: 'a', text: 'Milk', qty: 3, checked: true, createdAt: e.createdAt, section: 'general', chain: 'coles' });
    expect(p.unlinked?.id).toBe('g-milk');
    expect(moveNote(p, chainName)).toBe('General has no pantry: it keeps its words only, not linked to Milk.');
    expect(moveNote(p, chainName)).not.toMatch(/—/);
  });

  it('to a list where its words are one item: becomes it, with its category; a new id across tabs', () => {
    const e = line('a', 'ice', { section: 'general', qty: 2, categoryId: 'c-dairy' });
    const p = planMove(e, 'keg', f)!;
    expect(p.inPlace).toBe(false);
    expect(p.line.id).not.toBe('a');
    expect(p.line).toMatchObject({ text: 'Ice', groupId: 'k-ice', categoryId: 'c-kegx', qty: 2, section: 'keg', createdAt: e.createdAt });
    expect(p.canPick).toBe(false);
    expect(moveNote(p, chainName)).toBe('Becomes your Keg item Ice.');
  });

  it('"2 ice" as words becomes two of the item', () => {
    expect(planMove(line('a', '2 ice', { section: 'general' }), 'keg', f)!.line).toMatchObject({ groupId: 'k-ice', qty: 2 });
  });

  it('no clear item there: stays as its words and offers "Pick my …" from that list', () => {
    const p = planMove(line('a', 'Chopsticks', { section: 'general' }), 'pharmacy', f)!;
    expect(p.item).toBeUndefined();
    expect(p.canPick).toBe(true);
    expect(p.line).toMatchObject({ text: 'Chopsticks', section: 'pharmacy' });
    expect(p.line.groupId).toBeUndefined();
    expect(moveNote(p, chainName)).toBe('Then pick which Health item it is, or keep the words.');
    expect(pickableFor('pharmacy', f.groups).map((g) => g.id)).toEqual(['h-band']);
    expect(pickableFor('general', f.groups)).toEqual([]);
  });

  it('a saved "Always use this for …" counts', () => {
    const p = planMove(line('a', 'bag of ice', { section: 'general' }), 'keg', { ...f, aliases: { 'bag of ice': 'k-ice2' } })!;
    expect(p.item?.id).toBe('k-ice2');
  });

  it('its shop stays when it’s one of the new list’s (General takes any); otherwise Any shop, and what was found there goes', () => {
    const product = { chain: 'coles' as const, name: 'Coles Ice 5kg' };
    const e = line('a', 'Ice bag 5kg', { section: 'pantry', chain: 'coles', product, price: 4.5 });
    const toKeg = planMove(e, 'keg', f)!;
    expect(toKeg.shopDropped).toBe('coles');
    expect(toKeg.line.chain).toBeUndefined();
    expect(toKeg.line.product).toBeUndefined();
    expect(toKeg.line.price).toBeUndefined();
    expect(moveNote(toKeg, chainName)).toContain("Coles isn't one of its shops: Any shop.");
    const toGeneral = planMove(e, 'general', f)!;
    expect(toGeneral.line).toMatchObject({ chain: 'coles', product, price: 4.5 });
    expect(planMove(line('b', 'Ice', { section: 'general', chain: 'other' }), 'keg', f)!.line.chain).toBe('other');
    expect(planMove(line('c', 'Gin', { section: 'general', chain: 'danmurphys' }), 'keg', f)!.line.chain).toBe('danmurphys');
  });

  it('an aisle category stays only on its own list', () => {
    expect(planMove(line('a', 'Tonic', { section: 'pantry', categoryId: 'c-dairy' }), 'general', f)!.line.categoryId).toBeUndefined();
    expect(planMove(line('a', 'Tonic', { section: 'general', categoryId: 'c-kegx' }), 'keg', f)!.line.categoryId).toBe('c-kegx');
  });

  it('the item is on that list already, still to buy: one line with both amounts', () => {
    const there = line('k1', 'Ice', { groupId: 'k-ice', qty: 2, section: 'keg' });
    const p = planMove(line('a', 'ice', { section: 'general', qty: 3 }), 'keg', { ...f, entries: [there] })!;
    expect(p.joins?.id).toBe('k1');
    expect(moveNote(p, chainName)).toBe('Ice is on it already: one line, with both amounts.');
    // Ticked: a line of its own.
    expect(planMove(line('a', 'ice', { section: 'general', checked: true }), 'keg', { ...f, entries: [there] })!.joins).toBeUndefined();
  });
});

describe('Move to: on the list, with Undo', () => {
  beforeEach(async () => {
    await addGroup(group('g-milk', 'Milk'));
    await addGroup(group('k-ice', 'Ice', { section: 'keg' }));
  });

  it('Groceries ↔ General: the same line, and Undo puts it back exactly', async () => {
    await addListEntry(line('l1', 'Milk', { groupId: 'g-milk', qty: 2, checked: true }));
    const before = listTable();
    const m = await moveTo('l1', 'general', 'Milk');
    expect(m?.id).toBe('l1');
    expect(lastStep()?.label).toBe('Milk moved to General');
    expect(listTable()).toEqual([{ ...before[0], item_id: null, section: 'general' }]);
    await undo();
    expect(listTable()).toEqual(before);
  });

  it('across tabs: a new line on the new list, the old one off, in one Undo that brings back the same id', async () => {
    await addListEntry(line('l1', 'ice', { section: 'general', qty: 3 }));
    const before = listTable();
    const m = await moveToFromListActions('l1', 'keg', 'ice');
    expect(lastStep()?.label).toBe('ice moved to Keg as Ice');
    const now = await allListEntries();
    expect(now.map((e) => e.id)).toEqual([m!.id]);
    expect(now[0]).toMatchObject({ text: 'Ice', groupId: 'k-ice', section: 'keg', qty: 3, checked: false, createdAt: '2026-11-10T00:00:00.000Z' });
    await undo();
    expect(listTable()).toEqual(before);
  });

  it('joining a line already there adds the amounts; Undo splits them again', async () => {
    await addListEntry(line('k1', 'Ice', { groupId: 'k-ice', qty: 2, section: 'keg' }));
    await addListEntry(line('l1', 'ice', { section: 'general', qty: 3 }));
    const before = listTable();
    await moveTo('l1', 'keg', 'ice');
    expect(lastStep()?.label).toBe('ice moved to Keg, added to the Ice already there');
    expect((await allListEntries()).map((e) => [e.id, e.qty])).toEqual([['k1', 5]]);
    await undo();
    expect(listTable()).toEqual(before);
  });

  it('a line gone meanwhile (another phone): nothing happens, no Undo', async () => {
    expect(await moveTo('nope', 'keg', 'Ice')).toBeUndefined();
    expect(lastStep()).toBeUndefined();
  });

  it('Pick my … after a move links it to that list’s item, with its own Undo', async () => {
    await addListEntry(line('l1', 'Chopsticks', { section: 'general', chain: 'coles' }));
    const m = (await moveTo('l1', 'keg', 'Chopsticks'))!;
    expect(m.plan.canPick).toBe(true);
    const afterMove = listTable();
    await pickMoved(m.id, group('k-ice', 'Ice', { section: 'keg' }));
    expect(lastStep()?.label).toBe('Ice it is');
    expect((await allListEntries())[0]).toMatchObject({ groupId: 'k-ice', text: 'Ice', section: 'keg' });
    await undo();
    expect(listTable()).toEqual(afterMove);
    expect(await linkMoved('gone', group('k-ice', 'Ice', { section: 'keg' }))).toBe(false);
  });

  it('several at once: one Undo', async () => {
    await addListEntry(line('a', 'Tape', { section: 'pantry' }));
    await addListEntry(line('b', 'Pegs', { section: 'pantry', qty: 4 }));
    const before = listTable();
    expect(await moveAll(['a', 'b'], 'general')).toBe(2);
    expect(lastStep()?.label).toBe('2 moved to General');
    expect((await allListEntries()).map((e) => e.section)).toEqual(['general', 'general']);
    await undo();
    expect(listTable()).toEqual(before);
  });

  it('works on the facts read now (moveFacts)', async () => {
    await addListEntry(line('a', 'Tape', { section: 'pantry' }));
    const f = await moveFacts();
    expect((await moveLine('a', 'pharmacy', f))?.plan.to).toBe('pharmacy');
  });
});

describe('Move to: sync (ordinary list changes, as a 0.9.5 phone or server takes them)', () => {
  const here = () => new WebSyncEngine(syncDbOf(raw), verifySig, signedText);
  const other = async (tabs: string) => {
    const d = await createSqlJsDriver({ load: async () => SQL });
    await migrate(d);
    const e = new WebSyncEngine(syncDbOf(d.raw), verifySig, signedText);
    e.setMeta('device', 'b2phone');
    // A household sharing every tab; this phone shares `tabs`.
    e.db.exec("INSERT OR REPLACE INTO household (k, v) VALUES ('tabs', 'pantry,keg,pharmacy')");
    e.setMeta('tabs', tabs);
    return e;
  };
  // One file for every phone, as a folder or the server writes it: everything this device has.
  const send = (from: WebSyncEngine, to: WebSyncEngine) => to.apply(from.collect(0, null, 10_000, new Set(['pantry', 'keg', 'pharmacy']), '', true, 0).entries as Entry[]);
  const lines = (e: WebSyncEngine) => e.db.query('SELECT id, text, section, qty, checked FROM list_entries ORDER BY id');

  it('across tabs: a phone sharing only groceries sees the line go (no stale copy), one sharing Keg gets it; Undo brings the same line back', async () => {
    const a = here();
    const groc = await other('pantry');
    const keg = await other('pantry,keg');
    await addListEntry(line('l1', 'Ice', { qty: 3 }));
    send(a, groc);
    send(a, keg);
    expect(lines(groc)).toEqual([{ id: 'l1', text: 'Ice', section: null, qty: 3, checked: 0 }]);
    const m = (await moveTo('l1', 'keg', 'Ice'))!;
    send(a, groc);
    send(a, keg);
    expect(lines(groc)).toEqual([]);
    expect(lines(keg)).toEqual([{ id: m.id, text: 'Ice', section: 'keg', qty: 3, checked: 0 }]);
    // The groceries phone's file never takes it off the Keg phone.
    expect(keg.apply(groc.collect(0, null, 10_000, null, '', true, 0).entries as Entry[])).toBeGreaterThanOrEqual(0);
    expect(lines(keg)).toEqual([{ id: m.id, text: 'Ice', section: 'keg', qty: 3, checked: 0 }]);
    await new Promise((r) => setTimeout(r, 3));
    await undo();
    send(a, groc);
    send(a, keg);
    expect(lines(groc)).toEqual([{ id: 'l1', text: 'Ice', section: null, qty: 3, checked: 0 }]);
    expect(lines(keg)).toEqual([{ id: 'l1', text: 'Ice', section: null, qty: 3, checked: 0 }]);
  });

  it('Groceries ↔ General: the same line changes on every phone sharing groceries', async () => {
    const a = here();
    const groc = await other('pantry');
    await addListEntry(line('l1', 'Tape', { qty: 2 }));
    send(a, groc);
    await moveTo('l1', 'general', 'Tape');
    send(a, groc);
    expect(lines(groc)).toEqual([{ id: 'l1', text: 'Tape', section: 'general', qty: 2, checked: 0 }]);
  });
});

describe('Move to: Home Assistant never moves it back', () => {
  const fakeHa = () => {
    const list: { uid: string; summary: string; status: 'needs_action' | 'completed' }[] = [];
    let n = 0;
    return {
      list,
      api: {
        items: async () => list.map((i) => ({ ...i })),
        add: async (summary: string) => void list.push({ uid: `u${++n}`, summary, status: 'needs_action' as const }),
        update: async (u: string, p: { rename?: string; status?: 'needs_action' | 'completed' }) => {
          const i = list.find((x) => x.uid === u)!;
          if (p.rename) i.summary = p.rename;
          if (p.status) i.status = p.status;
        },
        remove: async (uids: string[]) => {
          for (const u of uids) list.splice(list.findIndex((x) => x.uid === u), 1);
        },
      },
      say: (summary: string) => list.push({ uid: `u${++n}`, summary, status: 'needs_action' as const }),
    };
  };

  it('Groceries ↔ General stays on Home Assistant’s list, paired (no remove, no add, no rename)', async () => {
    await addGroup(group('g-milk', 'Milk'));
    await addListEntry(line('l1', 'Milk', { groupId: 'g-milk', qty: 2 }));
    const h = fakeHa();
    await syncRound(h.api, dbStore());
    expect(h.list.map((i) => i.summary)).toEqual(['2 × Milk']);
    await moveTo('l1', 'general', 'Milk');
    await syncRound(h.api, dbStore());
    await syncRound(h.api, dbStore());
    expect(h.list.map((i) => [i.uid, i.summary])).toEqual([['u1', '2 × Milk']]);
    expect((await allListEntries()).map((e) => [e.id, e.section, e.qty])).toEqual([['l1', 'general', 2]]);
  });

  it('moved to Keg: off Home Assistant’s list; a later "ice" from Home Assistant is a new Groceries line, the Keg line stays on Keg', async () => {
    await addListEntry(line('l1', 'Ice', { qty: 3 }));
    const h = fakeHa();
    await syncRound(h.api, dbStore());
    expect(h.list.map((i) => i.summary)).toEqual(['3 × Ice']);
    const m = (await moveTo('l1', 'keg', 'Ice'))!;
    expect(onHaList(m.id, 'keg')).toBe(false);
    await syncRound(h.api, dbStore());
    expect(h.list).toEqual([]);
    h.say('ice');
    await syncRound(h.api, dbStore());
    await syncRound(h.api, dbStore());
    const now = await allListEntries();
    expect(now.find((e) => e.id === m.id)).toMatchObject({ section: 'keg', qty: 3 });
    expect(now.filter((e) => e.id !== m.id).map((e) => [e.text, e.section])).toEqual([['ice', 'general']]);
  });

  it('a saved alias and keep rows are untouched by a move', async () => {
    await addGroup(group('k-ice', 'Ice', { section: 'keg' }));
    await saveAlias('bag of ice', 'k-ice');
    await addListEntry(line('ha-1', 'bag of ice', { section: 'general' }));
    const m = (await moveTo('ha-1', 'keg', 'bag of ice'))!;
    expect(m.plan.item?.id).toBe('k-ice');
    expect(rows("SELECT k FROM household_settings WHERE k LIKE 'alias:%'")).toEqual([{ k: 'alias:bag of ice' }]);
  });
});

describe('Move to: words', () => {
  it('no em dashes in what the sheet and toasts say', () => {
    const src = readFileSync(new URL('./moveLine.ts', import.meta.url), 'utf8') + readFileSync(new URL('../ui/screens/MoveTo.tsx', import.meta.url), 'utf8');
    const shown = src.match(/`[^`]*`|'[^']*'|"[^"]*"|>[^<>{}]+</g) ?? [];
    expect(shown.filter((s) => s.includes('—'))).toEqual([]);
  });
});
