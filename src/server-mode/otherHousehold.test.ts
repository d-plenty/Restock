// 0.9.5: the security review's findings, the web's side: a copy of another household is never used
// (1), the one-time catch-up only brings General lines never had (2, the engine the server runs
// too), Step 1's exact numbers (7), Sign out with changes not sent yet (9), and a 429's `next` (4).
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { migrate } from '../lib/sql/schema';
import { WebSyncEngine, type Entry, type SyncFileMessage } from './engine';
import { syncDbOf } from './sqldb';
import { signedText, verifySig } from './crypto';
import { copyIsOtherHousehold, guardedRestore } from './live';
import { stepOne } from './ui/deleteSteps';
import type { DataSummary } from './ui/houseData';
import { ApiError } from './api';

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
const NAME = 'restock-sync-a1phone.bin';
const file = (entries: Entry[]): SyncFileMessage => ({ format: 'restock-sync', v: 1, device: 'a1phone', name: 'A', keyv: 1, at: new Date().toISOString(), top: entries.length, seen: {}, entries });
const ent = (tbl: string, pk: string, stamp: number, row: Record<string, unknown>): Entry => ({ tbl, pk, stamp, device: 'a1phone', created: stamp, deleted: false, row });
function goneLongAgo(e: WebSyncEngine, tbl: string, pk: string) {
  e.db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
  e.db.exec(`DELETE FROM ${tbl} WHERE id = ?`, [pk]);
  e.db.exec('DELETE FROM sync_log WHERE tbl = ? AND pk = ?', [tbl, pk]);
  e.db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
}
const has = (e: WebSyncEngine, tbl: string, id: string) => e.db.query(`SELECT 1 FROM ${tbl} WHERE id = ?`, [id]).length > 0;

describe('1. a copy of another household', () => {
  it('is one whose pinned owner key isn’t the session’s (none pinned yet, or no key known: not)', () => {
    expect(copyIsOtherHousehold('A', 'B')).toBe(true);
    expect(copyIsOtherHousehold('A', 'A')).toBe(false);
    expect(copyIsOtherHousehold(null, 'B')).toBe(false);
    expect(copyIsOtherHousehold('A', undefined)).toBe(false);
  });
  it('is deleted and not opened (the PWA’s offline copy is the same one)', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const drop = vi.fn(async () => undefined);
    expect(await guardedRestore(async () => bytes, () => 'old-owner', 'new-owner', drop)()).toBeUndefined();
    expect(drop).toHaveBeenCalledTimes(1);
    const keep = vi.fn(async () => undefined);
    expect(await guardedRestore(async () => bytes, () => 'same', 'same', keep)()).toBe(bytes);
    expect(await guardedRestore(async () => bytes, () => null, 'new-owner', keep)()).toBe(bytes);
    expect(await guardedRestore(async () => undefined, () => 'x', 'y', keep)()).toBeUndefined();
    expect(keep).not.toHaveBeenCalled();
  });
});

describe('2. the one-time catch-up (catchUpLists)', () => {
  it('an unchanged file brings only General lines never had: nothing deleted long ago comes back', async () => {
    const e = await engine();
    const old = Date.now() - 200 * 86_400_000;
    const f = file([
      ent('items', 'i-x', old, { id: 'i-x', name: 'Deleted long ago', created_at: 'x', section: 'pantry' }),
      ent('list_entries', 'l-x', old, { id: 'l-x', text: 'Old line', checked: 0, qty: 1, created_at: 'x', section: 'pantry' }),
      ent('list_entries', 'g1', old, { id: 'g1', text: 'Batteries', checked: 0, qty: 1, created_at: 'x', section: 'general' }),
    ]);
    expect(e.takeFile(NAME, 'sum1', f, new Date().toISOString())).toBe(3);
    for (const [t, pk] of [['items', 'i-x'], ['list_entries', 'l-x'], ['list_entries', 'g1']]) goneLongAgo(e, t, pk);
    expect(e.catchUpLists()).toBe(true);
    expect(e.seenSum(NAME)).toBeNull();
    expect(e.catchingUp(NAME, 'sum1')).toBe(true);
    expect(e.takeFile(NAME, 'sum1', f, new Date().toISOString())).toBe(1);
    expect(has(e, 'items', 'i-x')).toBe(false);
    expect(has(e, 'list_entries', 'l-x')).toBe(false);
    expect(e.db.query("SELECT section FROM list_entries WHERE id = 'g1'")).toEqual([{ section: 'general' }]);
    expect(e.catchingUp(NAME, 'sum1')).toBe(false);
    expect(e.seenSum(NAME)).toBe('sum1');
  });
  it('a file that changed since is read as always; a full read again (sharing more) drops the catch-up', async () => {
    const e = await engine();
    const now = Date.now();
    const f = file([ent('items', 'i-a', now, { id: 'i-a', name: 'Tea', created_at: 'x', section: 'pantry' })]);
    e.takeFile(NAME, 'sum1', f, new Date().toISOString());
    goneLongAgo(e, 'items', 'i-a');
    e.catchUpLists();
    expect(e.takeFile(NAME, 'sum2', f, new Date().toISOString())).toBe(1);
    expect(has(e, 'items', 'i-a')).toBe(true);
    // catchUpEntries alone: General, not deleted, not here, nothing else.
    const g = (pk: string, more: Partial<Entry> = {}, row: Record<string, unknown> = {}) => ({ ...ent('list_entries', pk, now, { id: pk, text: pk, checked: 0, qty: 1, created_at: 'x', section: 'general', ...row }), ...more });
    const picked = e.catchUpEntries([g('g-ok'), g('g-del', { deleted: true }), g('g-keg', {}, { section: 'keg' }), g('g-other', {}, { id: 'not-it' }), ent('items', 'i-b', now, { id: 'i-b', name: 'x', created_at: 'x' })]);
    expect(picked.map((x) => x.pk)).toEqual(['g-ok']);
  });
});

describe('9. Sign out with changes not sent yet', () => {
  it('counts this browser’s own changes since the last file it wrote', async () => {
    const e = await engine();
    expect(e.unsent()).toBe(0);
    e.db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at, section) VALUES ('l1', 'Milk', 0, 1, 'x', 'pantry')");
    expect(e.unsent()).toBe(1);
    const own = e.ownFile(1, new Date().toISOString(), false);
    expect(own).not.toBeNull();
    e.wroteOwn(own!.mark);
    expect(e.unsent()).toBe(0);
    // Another device's change taken in isn't this browser's to lose.
    e.takeFile(NAME, 's', file([ent('items', 'i-z', Date.now(), { id: 'i-z', name: 'x', created_at: 'x', section: 'pantry' })]), new Date().toISOString());
    expect(e.unsent()).toBe(0);
    e.db.exec("UPDATE list_entries SET checked = 1 WHERE id = 'l1'");
    expect(e.unsent()).toBe(1);
  });
});

describe('7. Step 1 with the server’s exact numbers', () => {
  const summary = {
    kinds: {
      prices: { count: 1000, products: 50, archives: 2, oldest: '2024-01-01T00:00:00.000Z', bytes: 100 },
      receipts: { count: 20, pinned: 2, photos: 5, oldest: '2024-01-01T00:00:00.000Z', bytes: 100 },
      stats: { count: 300, oldest: '2024-01-01T00:00:00.000Z', bytes: 100 },
      logs: { count: 40, activity: 10, oldest: '2024-01-01T00:00:00.000Z', bytes: 100 },
      backups: { count: 0, folders: 0, oldest: null, bytes: 0, nightly: false, keptDays: 30 },
    },
  } as unknown as DataSummary;
  it('says exactly how many go, for a date too, and which kinds lose nothing', () => {
    const before = '2025-11-10T00:00:00.000Z';
    const one = stepOne(summary, ['prices', 'receipts', 'stats', 'logs'], before, { prices: 812, receipts: 3, photos: 2, stats: 0, logs: 7, archives: 1 });
    expect(one.goes[0]).toMatch(/^812 older prices from before /);
    expect(one.goes[1]).toMatch(/^3 receipts from before .* and 2 photos\. Pinned receipts \(2\) stay\.$/);
    expect(one.goes[2]).toMatch(/^7 activity and log entries from before /);
    expect(one.goes[3]).toBe('1 month file of older prices and receipts the phones moved to the server.');
    expect(one.none).toEqual(['Nothing ticked off is that old.']);
    expect(one.bytes).toBeUndefined();
    // Without the numbers yet: what the summary says, as before.
    expect(stepOne(summary, ['prices'], before).goes[0]).toMatch(/^Prices from before .*there are 1,000 now/);
  });
});

describe('4. a refusal’s answer', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('a 429 carries retryAfter and next to the page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'rate', message: 'Phones were asked less than a day ago.', retryAfter: 600, next: '2026-11-11T09:00:00.000Z' }), { status: 429, headers: { 'Content-Type': 'application/json' } })),
    );
    const { data } = await import('./ui/houseData');
    const err = await data.resend().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).extra).toEqual({ retryAfter: 600, next: '2026-11-11T09:00:00.000Z' });
  });
});
