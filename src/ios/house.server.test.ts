// 0.13.2: the iPhone's side of a house (ios/house.ts) against the real Restock server, beside a phone
// that talks the way an Android one does (the server's own test client). It needs the server's code
// next door, so it only runs when told where that is:
//   RESTOCK_SERVER_REPO=/path/to/restock-server npx vitest run src/ios/house.server.test.ts
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { initDb, updateSettings } from '../lib/db';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { AsyncSyncEngine } from '../server-mode/engine';
import { asyncSyncDbOf, syncDbOf } from '../server-mode/sqldb';
import { b64u, newEcdhKey, signedText, signWithPkcs8, verifySig } from '../server-mode/crypto';
import { House, HouseProblem, type Http } from './house';
import { nodeLan } from './nodeLan';
import { WifiHouse, type Found } from './wire';

const SERVER = process.env.RESTOCK_SERVER_REPO ?? '';
const http: Http = async (o) => {
  const r = await fetch(o.url, { method: o.method, headers: o.headers, body: o.body as unknown as BodyInit | undefined });
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: r.status, headers, bytes: new Uint8Array(await r.arrayBuffer()) };
};

async function phoneDb() {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  await initDb(driver);
  await updateSettings({ onboarded: true }, { local: true });
  const sign = (text: string, priv: string | null) => signWithPkcs8(priv ?? '', text);
  const e = new AsyncSyncEngine(asyncSyncDbOf(syncDbOf(driver.raw)), verifySig, signedText, () => Date.now(), { role: 'phone', sign });
  return { driver, e, raw: driver.raw };
}

describe.skipIf(!SERVER)('an iPhone in a Restock server house (real server)', () => {
  it('joins, sends its own things up, takes the house in, shares with an Android-style phone, and leaves', async () => {
    const H = await import(/* @vite-ignore */ `${SERVER}/test/helpers.mjs`);
    const t = await H.house();
    // An Android-style phone already in the house, with milk.
    const android = await H.addPhone(t, 'Declan');
    const now = Date.now();
    const put = await android.putOwn(android.file([H.ent('items', 'i-milk', now - 5000, android.device, H.item('i-milk', 'pantry', 'Milk'))], { shares: H.SHARE_PANTRY }));
    expect(put.status).toBe(200);
    await t.settle();

    // The iPhone: it has bread already.
    const { e, raw } = await phoneDb();
    const q = (sql: string) => raw.exec(sql)[0]?.values ?? [];
    raw.run("INSERT INTO items (id, name, created_at, section) VALUES ('i-bread', 'Bread', '2026-11-01T00:00:00.000Z', 'pantry')");
    expect(q("SELECT stamp > 0 FROM sync_log WHERE tbl = 'items' AND pk = 'i-bread'")[0][0]).toBe(1);
    const house = new House(e, http);
    expect((await house.joined())).toBe(false);

    const code = (await t.web.post('/api/v3/phones', { label: "Sarah's iPhone" })).body.code as string;
    const chk = await house.check(code);
    expect(chk).toMatchObject({ v: 3, inHousehold: false, mode: 'v3' });
    await house.join(code);
    expect((await house.joined())).toBe(true);
    expect((await house.info())).toMatchObject({ joined: true, label: 'Home', memberLabel: "Sarah's iPhone" });
    // Its own things give way.
    expect(q("SELECT stamp FROM sync_log WHERE tbl = 'items' AND pk = 'i-bread'")[0][0]).toBe(-1);
    // A used code can't be used again.
    const { e: e2 } = await phoneDb();
    await expect(new House(e2, http).join(code)).rejects.toBeInstanceOf(HouseProblem);

    const r1 = await house.sync();
    expect(r1.wrote).toBe(true);
    expect(r1.received).toBeGreaterThan(0);
    expect(q("SELECT name FROM items ORDER BY id").map((r) => r[0])).toEqual(['Bread', 'Milk']);
    expect((await e.householdValue('name'))).toBe('Declan and Sarah');
    expect((await e.householdValue('member:' + (await e.device())))).toContain("Sarah's iPhone");
    await t.settle();
    // The server took the iPhone's bread (its file opened, shares read).
    expect(H.rows(t, 'SELECT id, name FROM items ORDER BY id').map((r: { name: string }) => r.name)).toEqual(['Bread', 'Milk']);
    // …and the Android-style phone can read the iPhone's file with the house's key.
    const mine = await android.getFile(`restock-sync-${(await e.device())}.bin`);
    expect(mine.status).toBe(200);
    const opened = H.core.openWithAny(android.serverKeys, mine.body).msg;
    expect(opened.device).toBe((await e.device()));
    expect(opened.shares).toEqual({ tabs: ['pantry'], receipts: false, cards: false });
    expect(opened.entries.some((x: { tbl: string; pk: string }) => x.tbl === 'items' && x.pk === 'i-bread')).toBe(true);
    expect(opened.entries.some((x: { tbl: string }) => x.tbl === 'cards')).toBe(false);

    // A change on the iPhone goes up; a change from the Android phone comes down.
    raw.run("UPDATE items SET name = 'Sourdough' WHERE id = 'i-bread'");
    raw.run("INSERT INTO list_entries (id, text, checked, qty, created_at, section) VALUES ('l-eggs', 'Eggs', 0, 1, '2026-11-02T00:00:00.000Z', 'pantry')");
    await android.putOwn(android.file([H.ent('items', 'i-milk', Date.now(), android.device, H.item('i-milk', 'pantry', 'Full cream milk'))], { shares: H.SHARE_PANTRY }));
    await t.settle();
    expect(await house.anythingNew()).toBe(true);
    const r2 = await house.sync();
    expect(r2.wrote).toBe(true);
    await t.settle();
    expect(q("SELECT name FROM items ORDER BY id").map((r) => r[0])).toEqual(['Sourdough', 'Full cream milk']);
    expect(H.rows(t, 'SELECT name FROM items ORDER BY id').map((r: { name: string }) => r.name)).toEqual(['Sourdough', 'Full cream milk']);
    expect(H.rows(t, "SELECT text FROM list_entries").map((r: { text: string }) => r.text)).toEqual(['Eggs']);
    // Nothing new: a quiet round writes nothing.
    await t.settle();
    const r3 = await house.sync();
    expect(r3.wrote).toBe(false);

    // Your data: the server's figures, and this phone's spending going up, sealed with the household's key.
    const sum = await house.sealed('GET', '/data/summary');
    expect(sum).toBeTypeOf('object');
    expect(sum.reqN).toBeUndefined();
    const sent = await house.sealed('POST', '/data/spend', { rows: [] });
    expect(Number(sent.added) || 0).toBe(0);

    // A wrong clock is put right with the server's time.
    const late = new House(e, http, () => Date.now() + 3 * 3600_000);
    expect((await late.sync()).unread).toBe(0);

    // Removed on the server: the phone forgets the household and keeps everything.
    const del = await t.web.removePhone((await e.device()));
    expect([200, 204]).toContain(del.status);
    await expect(house.sync()).rejects.toMatchObject({ removed: true });
    expect((await house.joined())).toBe(false);
    expect((await e.meta('notice'))).toBe('server-removed');
    expect(q("SELECT name FROM items ORDER BY id").map((r) => r[0])).toEqual(['Sourdough', 'Full cream milk']);

    // Joining again with a new code works, and leaving takes it off the server's list.
    const code2 = (await t.web.post('/api/v3/phones', { label: 'Back again' })).body.code as string;
    await house.join(code2);
    await house.sync();
    await house.leave();
    expect((await house.joined())).toBe(false);
    const list = (await t.web.get('/api/v3/phones')).body;
    expect(JSON.stringify(list)).not.toContain(`"${(await e.device())}","status":"active"`);
  }, 60_000);
  // 0.14.0: Sign in on a computer, from an iPhone: the phone says yes to the browser whose code it scanned.
  it('signs a browser in by scanning its code, and refuses a code from somewhere else', async () => {
    const H = await import(/* @vite-ignore */ `${SERVER}/test/helpers.mjs`);
    const t = await H.house();
    const { e } = await phoneDb();
    const house = new House(e, http);
    await house.join((await t.web.post('/api/v3/phones', { label: 'Web iPhone' })).body.code as string);
    const browser = newEcdhKey();
    const pub = b64u(browser.pub);
    const start = (await (await fetch(t.base + '/api/v3/qrlogin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epub: pub }) })).json()) as { id: string };
    const code = `restock-login:3?u=${encodeURIComponent(t.base)}&s=${start.id}&k=${pub}`;
    expect((await house.webCode(code))).toMatchObject({ kind: 'login', host: '127.0.0.1' });
    await expect(house.webCode(code.replace(encodeURIComponent(t.base), encodeURIComponent('https://evil.example')))).rejects.toThrow(/not your Restock server/);
    await expect(house.webCode('restock-login:2?u=x&s=y&k=z')).rejects.toThrow(/older Restock web page/);
    await house.approveWeb(code);
    const done = (await (await fetch(t.base + '/api/v3/qrlogin/' + start.id)).json()) as { pending: boolean; session?: string };
    expect(done.pending).toBe(false);
    expect(typeof done.session).toBe('string');
    // Once.
    await expect(house.approveWeb(code)).rejects.toBeInstanceOf(HouseProblem);
  });

  // 0.14.0: a server reached through a tunnel that sends http:// on to https:// (a Cloudflare Tunnel
  // with the server not told about it gives its own address as http://). A followed redirect turns the
  // join's POST into a GET, which the server answers "not found": the iPhone asks again over https.
  it('joins through an address that only redirects http to https, and keeps the https address', async () => {
    const H = await import(/* @vite-ignore */ `${SERVER}/test/helpers.mjs`);
    const t = await H.house();
    const code = (await t.web.post('/api/v3/phones', { label: 'Tunnel iPhone' })).body.code as string;
    const real = new URLSearchParams(code.slice(code.indexOf('?') + 1)).get('h') as string;
    const seen: string[] = [];
    const tunnel: Http = async (o) => {
      seen.push(`${o.method} ${o.url.replace(/\?.*$/, '')}`);
      if (o.url.startsWith('http://tunnel.test')) return { status: 301, headers: { location: o.url.replace('http://', 'https://') }, bytes: new Uint8Array(0) };
      if (o.url.startsWith('https://tunnel.test')) return http({ ...o, url: real + o.url.slice('https://tunnel.test'.length) });
      throw new Error('unreachable');
    };
    const p = new URLSearchParams(code.slice(code.indexOf('?') + 1));
    p.set('h', 'http://tunnel.test');
    p.delete('a');
    const { e } = await phoneDb();
    const house = new House(e, tunnel);
    await house.join('restock-server:3?' + p.toString());
    expect((await house.joined())).toBe(true);
    expect(seen.slice(0, 2)).toEqual(['POST http://tunnel.test/api/v3/join', 'POST https://tunnel.test/api/v3/join']);
    (await e.setMeta('server_home', 'http://tunnel.test'));
    (await e.setMeta('server_reached', null));
    seen.length = 0;
    await house.sync();
    expect((await e.meta('server_home'))).toBe('https://tunnel.test');
    expect((await e.meta('server_reached'))).toBe('https://tunnel.test');
    seen.length = 0;
    await house.sync();
    expect(seen.every((x) => x.includes('https://tunnel.test'))).toBe(true);

    // Something else at the address (it answers "not found"): said plainly, with the address.
    const { e: e2 } = await phoneDb();
    const other: Http = async () => ({ status: 404, headers: {}, bytes: new Uint8Array(0) });
    await expect(new House(e2, other).join('restock-server:3?' + p.toString())).rejects.toThrow(/tunnel\.test answered 404/);
    await t.close?.();
  });

  it('0.15.0: the owner of an iPhone household on the Wi-Fi brings it onto a new server, which carries it on as the house', async () => {
    const H = await import(/* @vite-ignore */ `${SERVER}/test/helpers.mjs`);
    const t = await H.house({}, { name: 'Server name' });
    try {
      const { e, raw } = await phoneDb();
      (await e.setMeta('device', 'f6f6f6f6f6f6f6f6'));
      (await e.setMeta('name', 'iPhone f6'));
      raw.run("INSERT INTO items (id, name, created_at, section) VALUES ('i-jam', 'Jam', '2026-11-01T00:00:00.000Z', 'pantry')");
      const air = new Map<string, Found>();
      const lan = nodeLan(air);
      const wifi = new WifiHouse(e, () => lan, () => ({ size: async () => -1, read: async () => null, write: async () => undefined }));
      (await wifi.start('Our phones'));
      const hid = (await e.householdValue('hid'));
      const house = new House(e, http);
      const code = (await t.web.post('/api/v3/phones', { label: 'Owner iPhone' })).body.code as string;
      expect(await house.check(code)).toMatchObject({ v: 3, mode: 'v3', inHousehold: false });

      // Only the owner can.
      const { e: other } = await phoneDb();
      await expect(new House(other, http).bring(code, 'wifi_house')).rejects.toThrow("Only the household's owner phone");

      await house.bring(code, 'wifi_house');
      expect((await house.joined())).toBe(true);
      expect((await wifi.joined())).toBe(false);
      // The same household, with its own name, id and key.
      expect((await e.householdValue('hid'))).toBe(hid);
      const r = await house.sync();
      expect(r.wrote).toBe(true);
      await t.settle();
      expect(H.rows(t, 'SELECT name FROM items').map((x: { name: string }) => x.name)).toContain('Jam');
      // The house's name is the one it was given on the server's page (as when an Android phone brings one).
      expect((await e.householdValue('name'))).toBe('Server name');

      // A phone added afterwards gets the household's things.
      const android = await H.addPhone(t, 'Later');
      const own = await android.serverFile(t.sid);
      expect(own.entries.some((x: { tbl: string; pk: string }) => x.tbl === 'items' && x.pk === 'i-jam')).toBe(true);
    } finally {
      await H.stop(t);
    }
  }, 60_000);
});
