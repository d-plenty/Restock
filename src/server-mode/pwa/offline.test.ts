/// <reference types="node" />
// 0.9.5: the Shopping list with no connection. Changes made offline wait in this browser's copy
// (the web's sync log) and go, in the order they were made, at the next round that reaches the
// server; a round that fails keeps them for the next; the phones' rules decide clashes. The copy
// is per session: another session never opens it, and it goes at sign-out or when the session ends.
import { randomBytes } from 'node:crypto';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSqlJsDriver } from '../../lib/sql/sqljs';
import { migrate } from '../../lib/sql/schema';
import { ApiError } from '../api';
import { b64u, openRsf1, sealRsf1, signedText, verifySig } from '../crypto';
import { WebSyncEngine, type Entry } from '../engine';
import { syncRound, type Remote } from '../round';
import type { Session } from '../session';
import { syncDbOf } from '../sqldb';
import { atSignIn, openOffline, signedOut } from './boot';
import { forgetKept, INFO_KEY, isOfflineError, keepInfo, keptInfo, offlineSession, pwaState, roundDone, clearState, staleCopy, WEBID_KEY, whenText } from './offline';
import { addScanned, scanBlocked, scanSaid } from './scan';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const OFFLINE = "Can't reach your Restock server. Check you're on the same network, or its away address.";

/** A server's files in memory, which can be cut off (like a phone out of signal). */
function house(key: Buffer) {
  const files = new Map<string, Uint8Array>();
  const writes: string[] = [];
  let n = 0;
  const ver = new Map<string, string>();
  const state = { offline: false, refuse: false };
  const gone = () => {
    if (state.offline) throw new ApiError(0, 'offline', OFFLINE);
  };
  const remote: Remote = {
    files: async () => (gone(), [...files.keys()].sort().map((name) => ({ name, size: files.get(name)!.length, version: ver.get(name) ?? b64u(files.get(name)!.subarray(4, 16)) }))),
    read: async (name) => (gone(), files.get(name) ?? null),
    write: async (name, bytes) => {
      gone();
      if (state.refuse) throw new ApiError(403, 'forbidden', "This browser isn't allowed to do that.");
      files.set(name, bytes);
      writes.push(name);
      ver.set(name, 'w' + ++n);
      return { version: ver.get(name) };
    },
  };
  const phone = (entries: Entry[]) =>
    files.set('restock-sync-a1.bin', sealRsf1(new Uint8Array(key), { format: 'restock-sync', v: 1, device: 'a1', name: 'Sarah’s phone', keyv: 1, at: 'x', top: 1, entries }));
  const web = (webId: string) => openRsf1<{ entries: Entry[] }>(new Uint8Array(key), files.get(`restock-sync-web-${webId}.bin`)!);
  return { files, writes, state, remote, phone, web };
}

async function copy(webId: string) {
  const d = await createSqlJsDriver({ load: async () => SQL });
  await migrate(d);
  const e = new WebSyncEngine(syncDbOf(d.raw), verifySig, signedText);
  e.setMeta('device', 'web-' + webId);
  return e;
}

const line = (id: string, text: string, checked = 0, more: Record<string, unknown> = {}) => ({ id, text, checked, qty: 1, created_at: 'x', section: 'pantry', ...more });
const ent = (pk: string, stamp: number, row: Record<string, unknown> | null): Entry => ({ tbl: 'list_entries', pk, stamp, device: 'a1', deleted: !row, created: stamp - 1000, ...(row ? { row } : {}) });
const lines = (m: { entries: Entry[] }) => m.entries.filter((x) => x.tbl === 'list_entries');

describe('changes made offline (the web copy and its round)', () => {
  it('wait while the server is out of reach, survive failed rounds, then go in the order they were made', async () => {
    const key = randomBytes(32);
    const h = house(key);
    const t0 = Date.now() - 60_000;
    h.phone([ent('milk', t0, line('milk', 'Milk')), ent('eggs', t0, line('eggs', 'Eggs')), ent('jam', t0, line('jam', 'Jam'))]);
    const e = await copy('W1');
    const keys = { webId: 'W1', webPriv: '', webPub: '', keys: { '1': b64u(key) } };
    await syncRound(e, h.remote, keys, undefined, { v3: true });
    expect(e.db.query('SELECT id FROM list_entries ORDER BY id').map((r) => r.id)).toEqual(['eggs', 'jam', 'milk']);
    const before = h.writes.length;

    // Out of signal: tick Milk, add Bread, remove Jam, tick then untick Eggs.
    h.state.offline = true;
    e.db.exec("UPDATE list_entries SET checked = 1, checked_at = ? WHERE id = 'milk'", [Date.now()]);
    e.db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at, section) VALUES ('bread', 'Bread', 0, 1, 'y', 'pantry')");
    e.db.exec("DELETE FROM list_entries WHERE id = 'jam'");
    e.db.exec("UPDATE list_entries SET checked = 1, checked_at = ? WHERE id = 'eggs'", [Date.now()]);
    e.db.exec("UPDATE list_entries SET checked = 0, checked_at = ? WHERE id = 'eggs'", [Date.now() + 1]);
    // Every round fails, and nothing is lost by trying.
    for (let i = 0; i < 3; i++) await expect(syncRound(e, h.remote, keys, undefined, { v3: true })).rejects.toMatchObject({ status: 0 });
    expect(h.writes.length).toBe(before);
    expect(isOfflineError(OFFLINE)).toBe(true);

    // In the order they were made (the log's own order, and each stamp after the one before).
    const log = e.db.query("SELECT pk, deleted, stamp FROM sync_log WHERE tbl = 'list_entries' AND device = 'web-W1' ORDER BY seq");
    expect(log.map((r) => r.pk)).toEqual(['milk', 'bread', 'jam', 'eggs']);
    const stamps = log.map((r) => Number(r.stamp));
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);

    // Back online: one round sends all of it.
    h.state.offline = false;
    const r = await syncRound(e, h.remote, keys, undefined, { v3: true });
    expect(r.wrote).toBe(true);
    const sent = new Map(lines(h.web('W1')).map((x) => [x.pk, x]));
    expect((sent.get('milk')?.row as { checked?: number })?.checked).toBe(1);
    expect((sent.get('bread')?.row as { text?: string })?.text).toBe('Bread');
    expect(sent.get('jam')?.deleted).toBeTruthy();
    // Ticked and unticked: the last one is what goes.
    expect((sent.get('eggs')?.row as { checked?: number })?.checked).toBe(0);
    // And nothing more to send.
    expect((await syncRound(e, h.remote, keys, undefined, { v3: true })).wrote).toBe(false);
  });

  it('clashes go by the phones’ rules: a newer change on a phone wins, an older one doesn’t undo the offline tick', async () => {
    const key = randomBytes(32);
    const h = house(key);
    const t0 = Date.now() - 600_000;
    h.phone([ent('milk', t0, line('milk', 'Milk')), ent('tea', t0, line('tea', 'Tea'))]);
    const e = await copy('W2');
    const keys = { webId: 'W2', webPriv: '', webPub: '', keys: { '1': b64u(key) } };
    await syncRound(e, h.remote, keys, undefined, { v3: true });
    h.state.offline = true;
    const tick = Date.now();
    e.db.exec("UPDATE list_entries SET checked = 1, checked_at = ? WHERE id IN ('milk', 'tea')", [tick]);
    // Meanwhile on Sarah's phone: Milk's tick undone after the web's tick; Tea changed long before it.
    h.state.offline = false;
    h.phone([
      ent('milk', tick + 60_000, line('milk', 'Milk', 0, { checked_at: tick + 60_000 })),
      ent('tea', t0 + 1000, line('tea', 'Tea', 0, { qty: 2, checked_at: t0 + 1000, qty_at: t0 + 1000 })),
    ]);
    await syncRound(e, h.remote, keys, undefined, { v3: true });
    const row = (id: string) => e.db.query('SELECT checked, qty FROM list_entries WHERE id = ?', [id])[0];
    expect(row('milk').checked).toBe(0);
    expect(row('tea').checked).toBe(1);
  });

  it('a change the server refuses stays, to go again, and the round says why', async () => {
    const key = randomBytes(32);
    const h = house(key);
    const e = await copy('W3');
    const keys = { webId: 'W3', webPriv: '', webPub: '', keys: { '1': b64u(key) } };
    e.db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at, section) VALUES ('rice', 'Rice', 0, 1, 'y', 'pantry')");
    h.state.refuse = true;
    await expect(syncRound(e, h.remote, keys, undefined, { v3: true })).rejects.toThrow("This browser isn't allowed to do that.");
    h.state.refuse = false;
    expect((await syncRound(e, h.remote, keys, undefined, { v3: true })).wrote).toBe(true);
    expect(lines(h.web('W3')).map((x) => x.pk)).toContain('rice');
  });
});

// ---------- the copy belongs to one session ----------

const session = (over: Partial<Session> = {}): Session => ({
  user: 'declan',
  webId: 'W1',
  webPriv: '',
  webPub: '',
  keys: { '1': 'k' },
  v: 3,
  sid: 's1',
  sessionKey: 'sk',
  expires: Date.now() + 86_400_000,
  keep: true,
  ...over,
});

describe('which session may open the copy offline', () => {
  it('only a house session with its keys, its own copy, not run out, not signed in with a phone', () => {
    expect(offlineSession(session(), 'W1')).toBeDefined();
    expect(offlineSession(session(), 'W9')).toBeUndefined(); // another session's copy
    expect(offlineSession(session(), null)).toBeUndefined();
    expect(offlineSession(undefined, 'W1')).toBeUndefined();
    expect(offlineSession(session({ expires: Date.now() - 1 }), 'W1')).toBeUndefined();
    expect(offlineSession(session({ expires: new Date(Date.now() - 1).toISOString() }), 'W1')).toBeUndefined();
    expect(offlineSession(session({ viaPhone: true }), 'W1')).toBeUndefined();
    expect(offlineSession(session({ v: undefined }), 'W1')).toBeUndefined();
    expect(offlineSession(session({ keys: {} }), 'W1')).toBeUndefined();
    expect(offlineSession(session({ sessionKey: undefined }), 'W1')).toBeUndefined();
  });

  it('at the sign-in page, a copy no session here can open is to go', () => {
    expect(staleCopy('W1', undefined)).toBe('W1');
    expect(staleCopy('W1', session({ webId: 'W2' }))).toBe('W1');
    expect(staleCopy('W1', session())).toBeUndefined();
    expect(staleCopy(null, undefined)).toBeUndefined();
  });

  it('keeps only what the server is (no household data), and not for a 0.9.3-style or released server', () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    keepInfo(st, { api: 3, mode: 'v3', version: '0.9.5', house: 'Declan and Sarah' });
    expect(JSON.parse(m.get(INFO_KEY)!)).toEqual({ api: 3, mode: 'v3', version: '0.9.5' });
    expect(keptInfo(st)).toEqual({ api: 3, mode: 'v3', version: '0.9.5' });
    keepInfo(st, { api: 2 });
    expect(keptInfo(st)).toBeUndefined();
    keepInfo(st, { api: 3, mode: 'released' });
    expect(keptInfo(st)).toBeUndefined();
    m.set(INFO_KEY, '{"api":3,"mode":"v3"}');
    m.set(WEBID_KEY, 'W1');
    forgetKept(st);
    expect(m.size).toBe(0);
  });
});

describe('signing out takes it all away', () => {
  const ls = new Map<string, string>();
  const ss = new Map<string, string>();
  const deleted: string[] = [];
  const fake = (m: Map<string, string>) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
  beforeEach(() => {
    ls.clear();
    ss.clear();
    deleted.length = 0;
    Object.assign(globalThis, {
      localStorage: fake(ls),
      sessionStorage: fake(ss),
      indexedDB: {
        deleteDatabase(name: string) {
          deleted.push(name);
          const r: { onsuccess?: () => void } = {};
          setTimeout(() => r.onsuccess?.(), 0);
          return r;
        },
      },
    });
  });
  afterEach(() => {
    for (const k of ['localStorage', 'sessionStorage', 'indexedDB']) delete (globalThis as Record<string, unknown>)[k];
  });

  it('the sign-in page deletes a signed-out (or run out) session’s copy, and what was kept for offline', async () => {
    ls.set(WEBID_KEY, 'W1');
    ls.set(INFO_KEY, '{"api":3,"mode":"v3"}');
    await atSignIn();
    expect(deleted).toEqual(['restock-server-W1']);
    expect(ls.has(WEBID_KEY)).toBe(false);
    expect(ls.has(INFO_KEY)).toBe(false);
  });

  it('a session that ran out is not opened offline, and its copy goes', async () => {
    ls.set(WEBID_KEY, 'W1');
    ls.set(INFO_KEY, '{"api":3,"mode":"v3"}');
    ls.set('restock-server-session', JSON.stringify(session({ expires: Date.now() - 1000 })));
    expect(await openOffline(new ApiError(0, 'offline', OFFLINE))).toBeUndefined();
    await atSignIn();
    expect(deleted).toEqual(['restock-server-W1']);
  });

  it('only a failure to reach the server opens offline (a refusal never does)', async () => {
    ls.set(WEBID_KEY, 'W1');
    ls.set(INFO_KEY, '{"api":3,"mode":"v3"}');
    ls.set('restock-server-session', JSON.stringify(session()));
    expect(await openOffline(new ApiError(401, 'signed-out', 'Signed out. Sign in again.'))).toBeUndefined();
    expect(await openOffline(new Error('x'))).toBeUndefined();
  });

  it('signing out forgets the time the list was updated and the kept server details', () => {
    ls.set(INFO_KEY, '{"api":3,"mode":"v3"}');
    ls.set(WEBID_KEY, 'W1');
    roundDone('2026-11-10T05:00:00.000Z');
    expect(pwaState().last).toBe('2026-11-10T05:00:00.000Z');
    signedOut();
    expect(pwaState().last).toBeUndefined();
    expect(ls.size).toBe(0);
    clearState();
  });
});

describe('words', () => {
  it('when the list was last updated', () => {
    const now = new Date(2026, 10, 10, 18, 0);
    expect(whenText(new Date(2026, 10, 10, 15, 41).toISOString(), now)).toBe('today at 3:41 pm');
    expect(whenText(new Date(2026, 10, 9, 9, 5).toISOString(), now)).toBe('yesterday at 9:05 am');
    expect(whenText(new Date(2026, 10, 7, 12, 0).toISOString(), now)).toBe('Saturday at 12:00 pm');
    expect(whenText(new Date(2026, 9, 1, 8, 0).toISOString(), now)).toBe('1 Oct at 8:00 am');
    expect(whenText(undefined, now)).toBeUndefined();
  });

  it('scanning needs https, and says so in plain words', () => {
    expect(scanBlocked({ secure: false, camera: true })).toBe("Scanning needs the server's https address (for example your Cloudflare tunnel).");
    expect(scanBlocked({ secure: true, camera: false })).toMatch(/can't use the camera/);
    expect(scanBlocked({ secure: true, camera: true })).toBeUndefined();
    expect(scanSaid({ kind: 'added', name: 'Milk', more: false })).toBe('Milk added to your Shopping list');
    expect(scanSaid({ kind: 'none', code: '9300633603205' })).toMatch(/9300633603205/);
  });

  it('a code that is not a product barcode is not added', async () => {
    expect(await addScanned('https://example.com', 'pantry')).toEqual({ kind: 'bad' });
  });
});

describe('scanning onto the Shopping list (in this browser’s copy, so offline too)', () => {
  it('finds the household’s product by barcode and adds its item; again adds one more; unknown says so', async () => {
    const { initDb, addProduct, addGroup, allListEntries } = await import('../../lib/db');
    await initDb(await createSqlJsDriver({ load: async () => SQL, restore: async () => undefined, persist: async () => undefined }));
    await addProduct({ id: 'p-milk', chain: 'coles', name: 'Coles Full Cream Milk 2L', storeProductId: '123', barcode: '9300633603205', createdAt: '' });
    await addGroup({ id: 'g-milk', name: 'Milk', usualProductId: 'p-milk', sameProductIds: [], altProductIds: [], alertLevel: 'good', createdAt: '' });
    expect(await addScanned('9300633603205', 'pantry')).toEqual({ kind: 'added', name: 'Milk', more: false });
    // A GS1 Digital Link QR code on the pack is the same product.
    expect(await addScanned('https://id.gs1.org/01/09300633603205', 'pantry')).toEqual({ kind: 'added', name: 'Milk', more: true });
    const list = await allListEntries();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ groupId: 'g-milk', qty: 2, checked: false });
    expect(await addScanned('9310000000007', 'pantry')).toEqual({ kind: 'none', code: '9310000000007' });
  });
});
