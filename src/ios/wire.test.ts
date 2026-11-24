// 0.14.0: syncing with another phone over the Wi-Fi, iPhone to iPhone (ios/wire.ts), over real
// sockets on this computer. The same code against the Android app's own Java is
// tools/sync-test/wire-parity.sh.
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { initDb, updateSettings } from '../lib/db';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { signedText, signWithPkcs8, verifySig } from '../server-mode/crypto';
import { WebSyncEngine } from '../server-mode/engine';
import { syncDbOf } from '../server-mode/sqldb';
import { nodeLan } from './nodeLan';
import { dayTag, isWifiCode, pairingTag, parseCode, WifiHouse, type Found, type Photos } from './wire';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

async function iphone(device: string, air: Map<string, Found>) {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  await initDb(driver);
  await updateSettings({ onboarded: true }, { local: true });
  // eslint-disable-next-line prefer-const
  let e: WebSyncEngine;
  const sign = (text: string) => signWithPkcs8(e.meta('owner_priv') ?? '', text);
  e = new WebSyncEngine(syncDbOf(driver.raw), verifySig, signedText, () => Date.now(), { role: 'phone', sign });
  e.setMeta('device', device);
  e.setMeta('name', 'iPhone ' + device.slice(0, 2));
  const files = new Map<string, Uint8Array>();
  const photos: Photos = { size: async (p) => files.get(p)?.length ?? -1, read: async (p) => files.get(p) ?? null, write: async (p, b) => void files.set(p, b) };
  const lan = nodeLan(air);
  const house = new WifiHouse(e, () => lan, () => photos);
  const q = (sql: string) => (driver.raw.exec(sql)[0]?.values ?? []).map((r) => String(r[0]));
  return { e, house, raw: driver.raw, files, names: () => q('SELECT name FROM items ORDER BY name').join('|'), q };
}

describe('0.14.0: two iPhones syncing over the Wi-Fi', () => {
  it('reads the codes the Android app makes', () => {
    expect(parseCode(' restock:3:abcdefghijklmnopqrstuvwxyz:192.168.1.20:47461 ')).toEqual({ token: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', host: '192.168.1.20', port: 47461 });
    expect(parseCode('RESTOCK:3:ABC')).toEqual({ token: 'ABC', host: '', port: 0 });
    expect(() => parseCode('RESTOCK:2:ABC:1.2.3.4:5')).toThrow(/older or newer Restock/);
    expect(() => parseCode('https://example.com/x')).toThrow(/isn't a Restock sync code/);
    expect(isWifiCode('RESTOCK:3:ABC:1.2.3.4:5')).toBe(true);
    expect(isWifiCode('RESTOCK-SEND:1:ABC:1.2.3.4:5')).toBe(false);
    // The household's tag changes each day, and is nothing like the key.
    const key = new Uint8Array(32).fill(7);
    expect(dayTag(key, 0, 0)).not.toBe(dayTag(key, 1, 0));
    expect(dayTag(key, 0, 0)).toMatch(/^[0-9a-f]{16}$/);
    expect(pairingTag(new Uint8Array(16))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('one starts a household, the other joins with its code; they find each other, swap changes, cards and receipt photos, and part', async () => {
    const air = new Map<string, Found>();
    const a = await iphone('a1a1a1a1a1a1a1a1', air);
    const b = await iphone('b2b2b2b2b2b2b2b2', air);
    a.raw.run("INSERT INTO items (id, name, created_at, section) VALUES ('i-rice', 'Rice', 'x', 'pantry')");
    b.raw.run("INSERT INTO items (id, name, created_at, section) VALUES ('i-tea', 'Tea', 'x', 'pantry')");
    a.house.start('Our house');
    expect(a.house.info()).toMatchObject({ joined: true, owner: true, household: 'Our house' });
    const { code } = await a.house.invite();
    expect(isWifiCode(code)).toBe(true);
    expect(await b.house.peek(code)).toMatchObject({ household: 'Our house', ownerName: 'iPhone a1' });
    await b.house.join(code);
    expect(a.house.info().invite).toBeNull();
    expect((await b.house.syncAll()).reached).toBe(1);
    expect(a.names()).toBe('Rice|Tea');
    expect(b.names()).toBe('Rice|Tea');
    expect(b.house.members().map((m) => `${m.name}${m.owner ? '*' : ''}`)).toEqual(['iPhone a1*', 'iPhone b2']);

    // Later, with the code's address forgotten: they find each other by the household's tag.
    b.e.setMeta('invite', null);
    b.raw.run('UPDATE sync_peers SET host = NULL, port = NULL');
    await b.house.listen();
    a.raw.run("INSERT INTO items (id, name, created_at, section) VALUES ('i-salt', 'Salt', 'x', 'pantry')");
    expect((await b.house.syncAll()).reached).toBe(1);
    expect(b.names()).toBe('Rice|Salt|Tea');

    // Loyalty cards go only when the phone shares them; receipts and their photos when the household does.
    a.raw.run("INSERT INTO cards (id, program, label, number, created_at, expiry) VALUES ('c1', 'flybuys', 'Flybuys', '2793', 'x', '2027-03-01')");
    await b.house.syncAll();
    expect(b.q('SELECT COUNT(*) FROM cards')).toEqual(['0']);
    a.house.setCards(true);
    b.house.setCards(true);
    a.raw.run("UPDATE cards SET label = 'Flybuys card' WHERE id = 'c1'");
    await b.house.syncAll();
    expect(b.q('SELECT number, expiry FROM cards')).toEqual(['2793']);
    expect(b.q('SELECT expiry FROM cards')).toEqual(['2027-03-01']);
    a.house.setReceipts(true);
    b.house.setReceipts(true);
    a.files.set('receipts/r1.jpg', JPEG);
    a.raw.run("INSERT INTO receipts (id, scanned_at, shop, section, photo) VALUES ('r1', '2026-11-20T00:00:00Z', 'Coles', 'pantry', 'receipts/r1.jpg')");
    await b.house.syncAll();
    await b.house.syncAll();
    expect(b.q('SELECT shop FROM receipts')).toEqual(['Coles']);
    expect(b.files.get('receipts/r1.jpg')).toEqual(JPEG);

    // The phone that started it can't leave while another is in; the other can, and keeps everything.
    expect(await a.house.leave()).toBe(false);
    expect(await b.house.leave()).toBe(true);
    expect(b.house.joined()).toBe(false);
    expect(b.names()).toBe('Rice|Salt|Tea');
    expect(a.house.members().map((m) => m.device)).toEqual(['a1a1a1a1a1a1a1a1']);
    expect(await a.house.leave()).toBe(true);
    expect(a.names()).toBe('Rice|Salt|Tea');
    await a.house.stop();
    await b.house.stop();
  }, 60_000);
});
