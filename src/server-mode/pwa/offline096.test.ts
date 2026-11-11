/// <reference types="node" />
// 0.9.6 (iPhone offline): beyond the Shopping list. With no signal, edits to all four lists, Move to,
// Undo and the Pantry wait in this browser's copy and go with the next round (the v3 round, no new
// endpoints); an item's older prices from the server are kept for offline; the notice's words; and a
// new release is always a new app shell.
import { randomBytes } from 'node:crypto';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSqlJsDriver } from '../../lib/sql/sqljs';
import { migrate } from '../../lib/sql/schema';
import type { PriceReading } from '../../types';
import { ApiError } from '../api';
import { b64u, openRsf1, sealRsf1, signedText, verifySig } from '../crypto';
import { WebSyncEngine, type Entry } from '../engine';
import { syncRound, type Remote } from '../round';
import { syncDbOf } from '../sqldb';
import { buildId, cacheName, staleCaches } from './swCore';
import { HISTORY_CAP, historyKey, keptHistory, NEEDS_SIGNAL, offlineText, waitingText, type KeptHistory, type KeyStore } from './offlineData';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const OFFLINE = "Can't reach your Restock server. Check you're on the same network, or its away address.";

function house(key: Buffer) {
  const files = new Map<string, Uint8Array>();
  let n = 0;
  const ver = new Map<string, string>();
  const state = { offline: false };
  const gone = () => {
    if (state.offline) throw new ApiError(0, 'offline', OFFLINE);
  };
  const remote: Remote = {
    files: async () => (gone(), [...files.keys()].sort().map((name) => ({ name, size: files.get(name)!.length, version: ver.get(name) ?? 'v0' }))),
    read: async (name) => (gone(), files.get(name) ?? null),
    write: async (name, bytes) => {
      gone();
      files.set(name, bytes);
      ver.set(name, 'w' + ++n);
      return { version: ver.get(name) };
    },
  };
  const phone = (entries: Entry[]) =>
    files.set('restock-sync-a1.bin', sealRsf1(new Uint8Array(key), { format: 'restock-sync', v: 1, device: 'a1', name: 'Phone one', keyv: 1, at: 'x', top: 1, entries }));
  const web = (webId: string) => openRsf1<{ entries: Entry[] }>(new Uint8Array(key), files.get(`restock-sync-web-${webId}.bin`)!);
  return { state, remote, phone, web };
}

async function copy(webId: string) {
  const d = await createSqlJsDriver({ load: async () => SQL });
  await migrate(d);
  const e = new WebSyncEngine(syncDbOf(d.raw), verifySig, signedText);
  e.setMeta('device', 'web-' + webId);
  return e;
}

const t0 = Date.now() - 600_000;
const ent = (tbl: string, pk: string, row: Record<string, unknown>): Entry => ({ tbl, pk, stamp: t0, device: 'a1', deleted: false, created: t0 - 1000, row });
const line = (id: string, text: string, section: string) => ent('list_entries', id, { id, text, checked: 0, qty: 1, created_at: 'x', section });

describe('offline on the iPhone: every list, Move to, Undo and the Pantry queue, then sync', () => {
  it('ticks, adds and edits in Groceries, Keg, Health and General, a move and an undone add all go in one round', async () => {
    const key = randomBytes(32);
    const h = house(key);
    h.phone([
      ent('items', 'i-milk', { id: 'i-milk', name: 'Full cream milk', section: 'pantry', created_at: 'x' }),
      line('milk', 'Milk', 'pantry'),
      line('lager', 'Lager', 'keg'),
      line('plasters', 'Plasters', 'pharmacy'),
      line('batteries', 'Batteries', 'general'),
    ]);
    const e = await copy('W96');
    const keys = { webId: 'W96', webPriv: '', webPub: '', keys: { '1': b64u(key) } };
    await syncRound(e, h.remote, keys, undefined, { v3: true });
    expect(e.db.query('SELECT id FROM list_entries ORDER BY id').map((r) => r.id)).toEqual(['batteries', 'lager', 'milk', 'plasters']);

    // No signal.
    h.state.offline = true;
    const now = Date.now();
    e.db.exec("UPDATE list_entries SET checked = 1, checked_at = ? WHERE id = 'milk'", [now]); // tick (Groceries)
    e.db.exec("UPDATE list_entries SET qty = 2, qty_at = ? WHERE id = 'lager'", [now]); // edit (Keg)
    e.db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at, section) VALUES ('sun', 'Sunscreen', 0, 1, 'y', 'pharmacy')"); // add (Health)
    e.db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at, section) VALUES ('bulbs', 'Light bulbs', 0, 1, 'y', 'pantry')");
    e.db.exec("UPDATE list_entries SET section = 'general' WHERE id = 'bulbs'"); // Move to General
    e.db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at, section) VALUES ('oops', 'Oops', 0, 1, 'y', 'general')");
    e.db.exec("DELETE FROM list_entries WHERE id = 'oops'"); // Undo of that add
    e.db.exec("UPDATE items SET name = 'Milk, full cream' WHERE id = 'i-milk'"); // the Pantry
    await expect(syncRound(e, h.remote, keys, undefined, { v3: true })).rejects.toMatchObject({ status: 0 });
    expect(e.unsent()).toBeGreaterThanOrEqual(6);

    // Back online: one round sends it all.
    h.state.offline = false;
    const r = await syncRound(e, h.remote, keys, undefined, { v3: true });
    expect(r.wrote).toBe(true);
    const sent = new Map(h.web('W96').entries.map((x) => [`${x.tbl}:${x.pk}`, x]));
    const row = (k: string) => sent.get(k)?.row as Record<string, unknown> | undefined;
    expect(row('list_entries:milk')?.checked).toBe(1);
    expect(row('list_entries:lager')?.qty).toBe(2);
    expect(row('list_entries:sun')?.section).toBe('pharmacy');
    expect(row('list_entries:bulbs')?.section).toBe('general');
    expect(row('items:i-milk')?.name).toBe('Milk, full cream');
    // The undone add never shows up as a line anywhere (gone, or sent as deleted).
    const oops = sent.get('list_entries:oops');
    expect(!oops || oops.deleted).toBe(true);
    expect(e.unsent()).toBe(0);
  });
});

// ---------- an item's older prices, kept for offline ----------

function memStore(): KeyStore & { m: Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return { m, get: async <T>(k: string) => m.get(k) as T | undefined, put: async (k, v) => void m.set(k, v) };
}
const reading = (date: string, price: number): PriceReading => ({ productId: 'p1', date, price, isSpecial: false, memberOnly: false, source: 'auto' });

describe('older prices kept for offline', () => {
  it('keeps what the server gave (merged, newest first, capped) and shows it offline from the date asked', async () => {
    const kv = memStore();
    let offline = false;
    let answer = [reading('2026-01-01', 3), reading('2026-06-01', 4)];
    const get = keptHistory(async () => answer, () => kv, () => offline, () => '2026-11-11T00:00:00.000Z');
    expect(await get('p1', '2025-01-01')).toHaveLength(2);
    answer = [reading('2026-06-01', 4.2), reading('2026-09-01', 5)];
    await get('p1', '2026-05-01');
    const kept = kv.m.get(historyKey('p1')) as KeptHistory;
    expect(kept.at).toBe('2026-11-11T00:00:00.000Z');
    expect(kept.rows.map((r) => r.date)).toEqual(['2026-09-01', '2026-06-01', '2026-01-01']);
    expect(kept.rows[1].price).toBe(4.2);
    // Offline: the server isn't asked; what was kept, from the date asked.
    offline = true;
    answer = [];
    const fetched: string[] = [];
    const get2 = keptHistory(async (id) => (fetched.push(id), []), () => kv, () => offline);
    expect((await get2('p1', '2026-05-01')).map((r) => r.date)).toEqual(['2026-09-01', '2026-06-01']);
    expect(fetched).toEqual([]);
  });

  it('online with nothing from the server shows nothing (not old kept prices); no store (a tab signed in with a phone) keeps nothing', async () => {
    const kv = memStore();
    kv.m.set(historyKey('p1'), { at: 'x', rows: [reading('2026-01-01', 3)] });
    expect(await keptHistory(async () => [], () => kv, () => false)('p1', '2020-01-01')).toEqual([]);
    expect(await keptHistory(async () => [reading('2026-01-01', 3)], () => undefined, () => false)('p1', '2020-01-01')).toHaveLength(1);
    expect(await keptHistory(async () => [], () => undefined, () => true)('p1', '2020-01-01')).toEqual([]);
    // A failing fetch is the same as nothing.
    expect(await keptHistory(async () => Promise.reject(new Error('x')), () => kv, () => false)('p1', '2020-01-01')).toEqual([]);
  });

  it('caps what one product keeps', async () => {
    const kv = memStore();
    const many = Array.from({ length: HISTORY_CAP + 50 }, (_, i) => reading(new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString(), 1));
    await keptHistory(async () => many, () => kv, () => false)('p1', '2000-01-01');
    expect((kv.m.get(historyKey('p1')) as KeptHistory).rows).toHaveLength(HISTORY_CAP);
  });
});

describe('the offline notice and Needs signal', () => {
  it('says what shows and that changes wait, in plain words', () => {
    expect(offlineText('today at 3:41 pm', 'phone')).toBe('Offline: showing what this phone last saved today at 3:41 pm.');
    expect(offlineText(undefined, 'browser')).toBe('Offline: showing what this browser last saved.');
    expect(waitingText(0)).toBe("Changes you make here sync when you're back online.");
    expect(waitingText(1)).toBe("1 change waiting to sync when you're back online.");
    expect(waitingText(7)).toBe("7 changes waiting to sync when you're back online.");
    for (const t of [offlineText('x', 'phone'), waitingText(2), ...Object.values(NEEDS_SIGNAL)]) expect(t).not.toMatch(/—/);
    expect(NEEDS_SIGNAL.data).toMatch(/Import/);
  });
});

describe('0.9.6 replaces the 0.9.5 app shell cleanly', () => {
  it('a new version is a new shell id even with the same file names, and the old shell goes', () => {
    const files = ['assets/index-abc.js', 'index.html'];
    const a = buildId(files, '0.9.5\nsw');
    const b = buildId(files, '0.9.6\nsw');
    expect(a).not.toBe(b);
    expect(staleCaches([cacheName(a), cacheName(b), 'other-cache'], b)).toEqual([cacheName(a)]);
  });
});
