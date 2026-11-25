// 0.13.2: iCloud sync (ios/folderHouse.ts) with a pretend folder: a household of iPhones made, joined
// through the folder, synced both ways, a device removed, and one that leaves.
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { initDb, updateSettings } from '../lib/db';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { signedText, signWithPkcs8, verifySig } from '../server-mode/crypto';
import { AsyncSyncEngine } from '../server-mode/engine';
import { asyncSyncDbOf, syncDbOf } from '../server-mode/sqldb';
import { FolderHouse, FolderProblem, INVITE_MS, inviteCode, isFolderCode, parseFolderCode, type FolderIo } from './folderHouse';

/** A folder every device sees the same (what iCloud Drive does, without the wait). */
function sharedFolder() {
  const files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  let clock = 1;
  const io: FolderIo = {
    list: async () => [...files].map(([name, f]) => ({ name, size: f.bytes.length, mtime: f.mtime })),
    read: async (name) => files.get(name)?.bytes ?? null,
    write: async (name, bytes) => void files.set(name, { bytes, mtime: clock++ }),
    remove: async (name) => void files.delete(name),
  };
  return { io, files };
}

async function device(name: string, id: string, io: FolderIo | undefined, now: () => number = () => Date.now()) {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  await initDb(driver);
  await updateSettings({ onboarded: true }, { local: true });
  const raw = driver.raw;
  raw.run('UPDATE sync_meta SET value = ? WHERE key = ?', [id, 'device']);
  const sign = (t: string, priv: string | null) => signWithPkcs8(priv ?? '', t);
  const e = new AsyncSyncEngine(asyncSyncDbOf(syncDbOf(raw)), verifySig, signedText, now, { role: 'phone', sign });
  await e.setMeta('name', name);
  const q = (sql: string) => raw.exec(sql)[0]?.values ?? [];
  return { e, raw, q, house: new FolderHouse(e, async () => io, now) };
}

const names = (d: { q: (s: string) => unknown[][] }) => d.q('SELECT name FROM items ORDER BY name').map((r) => r[0]);

describe('0.13.2: an iCloud sync code', () => {
  it('goes there and back, and anything else is turned down in words', () => {
    const k = 'A'.repeat(43);
    const code = inviteCode({ hid: 'hid123456789', k, name: 'Declan & Sarah' });
    expect(isFolderCode(code)).toBe(true);
    expect(isFolderCode('restock-server:3?h=x')).toBe(false);
    expect(parseFolderCode(code)).toEqual({ hid: 'hid123456789', k, name: 'Declan & Sarah' });
    expect(() => parseFolderCode('restock-server:3?h=x&i=y')).toThrow(/isn't an iCloud sync code/);
    expect(() => parseFolderCode('restock-icloud:1?h=hid123456789&k=short')).toThrow(/damaged/);
    expect(() => parseFolderCode(`restock-icloud:1?k=${k}`)).toThrow(/damaged/);
  });
});

describe('0.13.2: a household of iPhones in one iCloud folder', () => {
  it('is made on the first device, joined through the folder, and then shares both ways', async () => {
    const { io, files } = sharedFolder();
    const a = await device("Declan's iPhone", 'aaaa000000000001', io);
    const b = await device("Sarah's iPhone", 'bbbb000000000002', io);
    a.raw.run("INSERT INTO items (id, name, created_at, section) VALUES ('i-milk', 'Milk', '2026-11-01T00:00:00.000Z', 'pantry')");
    a.raw.run("INSERT INTO household_settings (k, v) VALUES ('have:i-milk', '{\"m\":\"c\",\"a\":2}'), ('inv:tab:pantry', 'true')");
    b.raw.run("INSERT INTO items (id, name, created_at, section) VALUES ('i-bread', 'Bread', '2026-11-01T00:00:00.000Z', 'pantry')");
    b.raw.run("INSERT INTO household_settings (k, v) VALUES ('have:i-bread', '{\"m\":\"c\",\"a\":1}')");

    // The first device makes the household. Its inventory amounts are still there.
    expect((await a.house.joined())).toBe(false);
    (await a.house.start('Declan and Sarah'));
    expect((await a.house.info())).toMatchObject({ joined: true, owner: true, household: 'Declan and Sarah', invite: null });
    expect(a.q("SELECT v FROM household_settings WHERE k = 'have:i-milk'")[0][0]).toBe('{"m":"c","a":2}');
    // The household's rows are signed by its owner key, and that key is pinned.
    expect(a.q("SELECT COUNT(*) FROM sync_log WHERE tbl = 'household' AND sig IS NOT NULL")[0][0]).toBeGreaterThanOrEqual(6);
    expect((await a.e.meta('owner_pin'))).toBe((await a.e.householdValue('owner_pub')));
    const r0 = await a.house.sync();
    expect(r0.wrote).toBe(true);
    expect([...files.keys()]).toEqual(['restock-sync-aaaa000000000001.bin']);
    // The first device gave the household its settings (the shops it uses, and the rest).
    expect(Number(a.q("SELECT COUNT(*) FROM household_settings WHERE k LIKE 'shop:%'")[0][0])).toBeGreaterThan(0);

    // A second device can't add anyone, and can't join without a code from the first.
    await expect(b.house.invite()).rejects.toThrow(/Only the household's first device/);
    const { code, until } = (await a.house.invite());
    expect(until - Date.now()).toBeGreaterThan(INVITE_MS - 5000);
    expect((await a.house.info()).invite?.code).toBe(code);

    // The second device asks, with the folder's code. Nothing changes on it yet.
    await b.house.askToJoin(code);
    expect((await b.house.info())).toMatchObject({ joined: false, joining: true });
    expect([...files.keys()].sort()).toEqual(['restock-join-bbbb000000000002.bin', 'restock-sync-aaaa000000000001.bin']);
    expect((await b.house.sync()).justJoined).toBe(false); // the first device hasn't answered yet
    // What it wrote can't be read without the code.
    expect(new TextDecoder().decode(files.get('restock-join-bbbb000000000002.bin')!.bytes)).not.toContain('Sarah');

    // The first device, next time it looks, lets it in and leaves a welcome. The code is used up.
    const r1 = await a.house.sync();
    expect(r1.letIn).toEqual(["Sarah's iPhone"]);
    expect((await a.house.info()).invite).toBeNull();
    expect(files.has('restock-join-bbbb000000000002.bin')).toBe(false);
    expect(files.has('restock-welcome-bbbb000000000002.bin')).toBe(true);
    expect(new TextDecoder().decode(files.get('restock-welcome-bbbb000000000002.bin')!.bytes)).not.toContain((await a.e.meta('key'))!);

    // The second device opens the welcome, joins and syncs: it has both devices' things, and its own inventory amount.
    const r2 = await b.house.sync();
    expect(r2.justJoined).toBe(true);
    expect((await b.house.info())).toMatchObject({ joined: true, owner: false, household: 'Declan and Sarah', joining: false });
    expect(files.has('restock-welcome-bbbb000000000002.bin')).toBe(false);
    expect(names(b)).toEqual(['Bread', 'Milk']);
    expect(b.q("SELECT v FROM household_settings WHERE k = 'have:i-bread'")[0][0]).toBe('{"m":"c","a":1}');
    expect(b.q("SELECT v FROM household_settings WHERE k = 'have:i-milk'")[0][0]).toBe('{"m":"c","a":2}');
    expect((await b.e.meta('key'))).toBe((await a.e.meta('key')));
    expect((await b.e.meta('owner_priv'))).toBeNull(); // only the first device holds the owner key
    // …and the first device gets the second one's.
    await a.house.sync();
    expect(names(a)).toEqual(['Bread', 'Milk']);
    expect((await a.house.others())).toEqual([{ device: 'bbbb000000000002', name: "Sarah's iPhone" }]);
    expect((await b.house.others()).map((o) => o.name)).toEqual(["Declan's iPhone"]);

    // Only the first device renames the household, and the name reaches the other.
    await expect(b.house.rename('Ours')).rejects.toThrow(/Only the household's first device/);
    (await a.house.rename('The Plenty house'));
    await a.house.sync();
    await b.house.sync();
    expect((await b.house.info()).household).toBe('The Plenty house');

    // Changes go both ways after that, with neither open at the same time; a delete is remembered.
    a.raw.run("UPDATE items SET name = 'Full cream milk' WHERE id = 'i-milk'");
    b.raw.run("INSERT INTO list_entries (id, text, checked, qty, created_at, section) VALUES ('l-eggs', 'Eggs', 0, 1, '2026-11-02T00:00:00.000Z', 'pantry')");
    b.raw.run("DELETE FROM items WHERE id = 'i-bread'");
    await a.house.sync();
    await b.house.sync();
    await a.house.sync();
    expect(names(a)).toEqual(['Full cream milk']);
    expect(names(b)).toEqual(['Full cream milk']);
    expect(a.q('SELECT text FROM list_entries').map((r) => r[0])).toEqual(['Eggs']);
    // A quiet round writes nothing.
    expect((await a.house.sync()).wrote).toBe(false);
    expect((await b.house.sync()).wrote).toBe(false);
  }, 30_000);

  it("a code is for one device, for 30 minutes, and a join made without it gets nowhere", async () => {
    const { io, files } = sharedFolder();
    let t = Date.parse('2026-11-24T10:00:00Z');
    const now = () => t;
    const a = await device('First', 'aaaa000000000001', io, now);
    const b = await device('Second', 'bbbb000000000002', io, now);
    const c = await device('Third', 'cccc000000000003', io, now);
    (await a.house.start('House'));
    await a.house.sync();
    const { code } = (await a.house.invite());
    // Someone with the folder but a made-up code: the first device doesn't answer it.
    const fake = inviteCode({ hid: (await a.e.householdValue('hid'))!, k: 'B'.repeat(43), name: null });
    await c.house.askToJoin(fake);
    expect((await a.house.sync()).letIn).toEqual([]);
    expect(files.has('restock-welcome-cccc000000000003.bin')).toBe(false);
    expect((await a.house.others())).toEqual([]);
    // The real code, used by one device…
    await b.house.askToJoin(code);
    expect((await a.house.sync()).letIn).toEqual(['Second']);
    // …doesn't work for another.
    (await c.house.cancelJoin());
    await c.house.askToJoin(code);
    expect((await a.house.sync()).letIn).toEqual([]);
    expect((await c.house.sync()).justJoined).toBe(false);
    // A code nobody used runs out, and so does a wait for an answer that never comes.
    (await a.house.invite());
    t += INVITE_MS + 1000;
    expect((await a.house.info()).invite).toBeNull();
    await expect(c.house.sync()).rejects.toThrow(/didn't answer in time/);
    expect((await c.house.info()).joining).toBe(false);
    expect((await c.house.joined())).toBe(false);
  }, 30_000);

  it('the first device can take another out; that device stops and keeps everything; then it can leave', async () => {
    const { io, files } = sharedFolder();
    const a = await device('First', 'aaaa000000000001', io);
    const b = await device('Second', 'bbbb000000000002', io);
    (await a.house.start('House'));
    await a.house.sync();
    await b.house.askToJoin((await a.house.invite()).code);
    await a.house.sync();
    await b.house.sync();
    b.raw.run("INSERT INTO items (id, name, created_at, section) VALUES ('i-tea', 'Tea', '2026-11-01T00:00:00.000Z', 'pantry')");
    b.raw.run("INSERT INTO household_settings (k, v) VALUES ('have:i-tea', '{\"m\":\"c\",\"a\":3}')");
    await b.house.sync();
    await a.house.sync();
    expect(names(a)).toEqual(['Tea']);

    // The first device can't walk away and leave the other stranded.
    await expect(a.house.leave()).rejects.toThrow(/others are still in it/);
    await expect(b.house.removeDevice('aaaa000000000001')).rejects.toThrow(/Only the household's first device/);
    (await a.house.removeDevice('bbbb000000000002'));
    await a.house.sync();
    expect((await a.house.others())).toEqual([]);
    // What the removed device writes from now on is passed over.
    b.raw.run("UPDATE items SET name = 'Green tea' WHERE id = 'i-tea'");
    await expect(b.house.sync()).rejects.toThrow(/taken out of the household/);
    expect((await b.house.joined())).toBe(false);
    expect((await b.e.meta('notice'))).toBe('removed');
    expect(names(b)).toEqual(['Green tea']);
    expect(b.q("SELECT v FROM household_settings WHERE k = 'have:i-tea'")[0][0]).toBe('{"m":"c","a":3}');
    await a.house.sync();
    expect(names(a)).toEqual(['Tea']);

    // Alone now, the first device can leave: its file comes out of the folder and it keeps its things.
    await a.house.leave();
    expect((await a.house.joined())).toBe(false);
    expect(files.has('restock-sync-aaaa000000000001.bin')).toBe(false);
    expect(names(a)).toEqual(['Tea']);
    expect((await a.e.meta('key'))).toBeNull();
    expect((await a.e.meta('owner_priv'))).toBeNull();
  }, 30_000);

  it('says so when no folder is picked, and a device already in a household is told to leave it first', async () => {
    const lone = await device('Lone', 'dddd000000000004', undefined);
    await expect(lone.house.askToJoin(inviteCode({ hid: 'hid123456789', k: 'A'.repeat(43), name: null }))).rejects.toBeInstanceOf(FolderProblem);
    (await lone.house.start('Mine'));
    await expect(lone.house.sync()).rejects.toThrow(/Pick the iCloud Drive folder/);
    expect((await lone.house.info()).error).toMatch(/Pick the iCloud Drive folder/);
    await expect(lone.house.start('Again')).rejects.toThrow(/already in a household/);
    await expect(lone.house.askToJoin(inviteCode({ hid: 'hid123456789', k: 'A'.repeat(43), name: null }))).rejects.toThrow(/Leave your household first/);
  });
});
