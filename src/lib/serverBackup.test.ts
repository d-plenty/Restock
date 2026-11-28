// 0.18.4: this phone's backup on the Restock server (serverBackup.ts): sealed to the household's backup
// key so the server can't read it, once a day, and put back on a phone that replaces a lost one with
// the server's passphrase.
import initSqlJs from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { derivePassphrase, newBackupKey, openBackupKey, openPhoneBackup, random, b64u } from '../server-mode/crypto';
import { base64ToBytes } from './base64';

const PASS = 'kettle orbit lemon fence';
const server: { key?: { pub: string; sealed: string; salt: string }; files: Map<string, string>; calls: { method: string; path: string; body?: unknown }[]; restoreFrom?: string } = { files: new Map(), calls: [] };
let onServer = true;

vi.mock('./sql/native', () => ({
  RestockNative: {
    serverPhone: async (o: { method: string; path: string; body?: Record<string, unknown> }) => {
      server.calls.push(o);
      if (o.path === '/backupkey') return server.key ? { pub: server.key.pub } : {};
      if (o.path === '/restore' && o.method === 'GET')
        return server.restoreFrom ? { from: server.restoreFrom, label: "Declan's old iPhone", backup: server.files.has(server.restoreFrom) ? { at: '2026-11-27T10:00:00.000Z', size: 100 } : null, key: server.key } : {};
      if (o.path === '/restore') {
        server.restoreFrom = undefined;
        return { ok: true };
      }
      throw new Error('not here');
    },
    serverBackupPut: async (o: { data: string }) => {
      server.files.set('pOld', o.data);
      return { size: base64ToBytes(o.data).length };
    },
    serverBackupGet: async (o: { device: string }) => (server.files.has(o.device) ? { data: server.files.get(o.device) } : {}),
    syncNow: async () => ({}),
  },
}));
vi.mock('./sync', () => ({
  syncInfo: async () => (onServer ? { server: true, serverApi: 3, device: 'pOld', serverMemberLabel: "Declan's old iPhone" } : { paired: false }),
}));

const db = await import('./db');
const { createSqlJsDriver } = await import('./sql/sqljs');
const B = await import('./serverBackup');
let salt = '';

beforeAll(async () => {
  await db.initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
  await db.updateSettings({ onboarded: true }, { local: true });
  salt = b64u(random(16));
  const keys = await derivePassphrase(PASS, base64Url(salt));
  server.key = { ...newBackupKey(keys.vault), salt };
});
beforeEach(() => {
  server.calls = [];
  onServer = true;
});

function base64Url(s: string) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
}

describe('0.18.4: a backup on the server', () => {
  it("goes up sealed to the backup key, once a day, and only the passphrase opens it", async () => {
    await db.updateSettings({ theme: 'dark' });
    const st = await B.maybeServerBackup();
    expect(st.at).toBeTruthy();
    expect(st.size).toBeGreaterThan(100);
    const bytes = base64ToBytes(server.files.get('pOld')!);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RSB1');
    // Not readable without the passphrase…
    const wrong = await derivePassphrase('not the passphrase at all', base64Url(salt));
    expect(() => openBackupKey(wrong.vault, server.key!.sealed)).toThrow(/passphrase/);
    // …and with it, the same file Export data makes.
    const right = await derivePassphrase(PASS, base64Url(salt));
    const b = openPhoneBackup(openBackupKey(right.vault, server.key!.sealed), bytes);
    expect(b.device).toBe('pOld');
    expect(JSON.parse(b.json).app).toBe('restock');
    // Once a day: asked again straight away, nothing goes up.
    server.files.delete('pOld');
    await B.maybeServerBackup();
    expect(server.files.has('pOld')).toBe(false);
    // Back up now does.
    await B.maybeServerBackup(true);
    expect(server.files.has('pOld')).toBe(true);
  }, 60_000);

  it('turned off on this phone: nothing goes up; off the server: nothing either', async () => {
    await B.setServerBackupOn(false);
    server.files.clear();
    expect((await B.maybeServerBackup()).on).toBe(false);
    expect(server.files.size).toBe(0);
    await B.setServerBackupOn(true);
    onServer = false;
    await B.maybeServerBackup(true);
    expect(server.files.size).toBe(0);
  }, 60_000);

  it("while phone backups aren't on for the server, it says so and sends nothing", async () => {
    const k = server.key;
    server.key = undefined;
    const st = await B.maybeServerBackup(true);
    expect(st.problem).toBe('no-key');
    server.key = k;
  });

  it("a new phone puts it back with the server's passphrase, and the lost one is taken off", async () => {
    await db.updateSettings({ theme: 'dark' });
    await B.maybeServerBackup(true);
    // The new phone: its own settings, then the restore.
    await db.updateSettings({ theme: 'light' });
    server.restoreFrom = 'pOld';
    const offer = await B.restoreOffer();
    expect(offer?.from).toBe('pOld');
    await expect(B.restoreFromServer(offer!, 'not the passphrase at all')).rejects.toThrow(/passphrase/);
    expect(server.calls.some((c) => c.method === 'POST' && c.path === '/restore')).toBe(false);
    await B.restoreFromServer(offer!, PASS);
    expect((await db.getSettings()).theme).toBe('dark');
    expect(server.calls).toContainEqual({ method: 'POST', path: '/restore', body: {} });
    expect(await B.restoreOffer()).toBeUndefined();
  }, 60_000);

  it('not putting it back: the phone carries on as itself', async () => {
    server.restoreFrom = 'pOld';
    await B.skipRestore();
    expect(server.calls).toContainEqual({ method: 'POST', path: '/restore', body: { skip: true } });
  });
});
