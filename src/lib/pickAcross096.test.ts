import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addGroup, addListEntry, allListEntries, ensureDefaults, initDb } from './db';
import { createSqlJsDriver } from './sql/sqljs';
import { pickItemFor } from './listPicks';
import { clearUndo } from './undo';
import type { Group, ListEntry } from '../types';

// 0.9.6: picking a Keg or Health item for a General line makes the line again on that list (a new
// line, the old one taken off), as Move to does, so a phone sharing only Groceries sees it go.

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

const group = (id: string, name: string, section: Group['section']): Group => ({
  id,
  name,
  sameProductIds: [],
  altProductIds: [],
  alertLevel: 'good',
  section,
  createdAt: '2026-11-10T00:00:00.000Z',
});
const line = (id: string, text: string, more: Partial<ListEntry> = {}): ListEntry => ({ id, text, checked: false, qty: 2, createdAt: '2026-11-10T00:00:00.000Z', section: 'general', ...more });

describe('pickItemFor across tabs (0.9.6)', () => {
  it('a General line picked as a Keg item is a new line on Keg and the old one is gone', async () => {
    await addGroup(group('beer', 'Lager', 'keg'));
    await addListEntry(line('g1', 'beer'));
    expect(await pickItemFor((await allListEntries())[0], { id: 'beer', name: 'Lager' }, false)).toBe(true);
    const all = await allListEntries();
    expect(all).toHaveLength(1);
    expect(all[0].id).not.toBe('g1');
    expect(all[0]).toMatchObject({ groupId: 'beer', text: 'Lager', section: 'keg', qty: 2, checked: false });
  });

  it('a General line picked as a Groceries item changes in place (they sync as one)', async () => {
    await addGroup(group('milk', 'Milk', 'pantry'));
    await addListEntry(line('g2', 'milk'));
    expect(await pickItemFor((await allListEntries())[0], { id: 'milk', name: 'Milk' }, false)).toBe(true);
    const all = await allListEntries();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 'g2', groupId: 'milk', text: 'Milk' });
  });
});
