// 0.15.0: a household folder on Nextcloud or another WebDAV server, from an iPhone (ios/dav.ts):
// addresses, the folder listing, the folder itself against a pretend WebDAV server, Nextcloud's
// sign-in, and two iPhones sharing a household through it.
import initSqlJs from 'sql.js';
import { strFromU8, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { initDb, updateSettings } from '../lib/db';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { signedText, signWithPkcs8, verifySig } from '../server-mode/crypto';
import { AsyncSyncEngine } from '../server-mode/engine';
import { asyncSyncDbOf, syncDbOf } from '../server-mode/sqldb';
import { davAddress, davFolder, DavProblem, isHomeHost, nextcloudFolderUrl, nextcloudServer, parseListing, pollNextcloud, startNextcloud, type DavHttp } from './dav';
import { FolderHouse } from './folderHouse';

/** A WebDAV server holding one user's files, checking the password on every request. */
function davServer(user = 'declan', password = 'app-pass') {
  const folders = new Set<string>(['/dav/']);
  const files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  const seen: { method: string; url: string }[] = [];
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const ok = (h: Record<string, string>) => h.Authorization === 'Basic ' + btoa(`${user}:${password}`);
  const res = (status: number, body = '') => ({ status, headers: {}, bytes: strToU8(body) });
  const http: DavHttp = async ({ method, url, headers, body }) => {
    seen.push({ method, url });
    if (!ok(headers)) return res(401);
    const path = decodeURIComponent(new URL(url).pathname);
    const parent = path.replace(/[^/]+\/?$/, '');
    switch (method) {
      case 'MKCOL':
        if (folders.has(path)) return res(405);
        if (!folders.has(parent)) return res(409);
        folders.add(path);
        return res(201);
      case 'PROPFIND': {
        if (!folders.has(path)) return res(files.has(path) ? 207 : 404, files.has(path) ? '<d:multistatus xmlns:d="DAV:"><d:response><d:href>x</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>' : '');
        const row = (href: string, prop: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
        let xml = row(encodeURI(path), '<d:resourcetype><d:collection/></d:resourcetype>');
        if (headers.Depth === '1')
          for (const [p, f] of files)
            if (p.startsWith(path) && !p.slice(path.length).includes('/'))
              xml += row(encodeURI(p), `<d:getcontentlength>${f.bytes.length}</d:getcontentlength><d:getlastmodified>${new Date(f.mtime).toUTCString()}</d:getlastmodified><d:resourcetype/>`);
        return res(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${xml}</d:multistatus>`);
      }
      case 'GET':
        return files.has(path) ? { status: 200, headers: {}, bytes: files.get(path)!.bytes } : res(404);
      case 'PUT':
        if (!folders.has(parent)) return res(409);
        files.set(path, { bytes: body ?? new Uint8Array(), mtime: (clock += 1000) });
        return res(201);
      case 'DELETE':
        return files.delete(path) ? res(204) : res(404);
    }
    return res(405);
  };
  return { http, files, folders, seen };
}

describe('0.15.0: a WebDAV address', () => {
  it('becomes https with the folder ending in a slash; http only on the home network', () => {
    expect(davAddress(' cloud.example.com/remote.php/dav/files/d/Restock ')).toBe('https://cloud.example.com/remote.php/dav/files/d/Restock/');
    expect(davAddress('http://192.168.1.20:8080/dav')).toBe('http://192.168.1.20:8080/dav/');
    expect(davAddress('http://nas.local/dav/')).toBe('http://nas.local/dav/');
    expect(() => davAddress('http://cloud.example.com/dav')).toThrow(/https/);
    expect(() => davAddress('https://me:pw@cloud.example.com/dav')).toThrow(/their own boxes/);
    expect(() => davAddress('ftp://x.example.com')).toThrow(DavProblem);
    expect(isHomeHost('172.20.0.1')).toBe(true);
    expect(isHomeHost('172.40.0.1')).toBe(false);
    expect(isHomeHost('nas')).toBe(true);
    expect(isHomeHost('example.com')).toBe(false);
  });

  it("Nextcloud's server part and folder address come from whatever page was copied", () => {
    expect(nextcloudServer('cloud.example.com/index.php/apps/files/?dir=/')).toBe('https://cloud.example.com');
    expect(nextcloudServer('https://example.com/nextcloud/login')).toBe('https://example.com/nextcloud');
    expect(nextcloudFolderUrl('https://cloud.example.com', 'Declan P')).toBe('https://cloud.example.com/remote.php/dav/files/Declan%20P/Restock/');
  });
});

describe('0.15.0: a WebDAV folder listing', () => {
  it('lists the files only, with size and time, from any server spelling', () => {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
      <D:response><D:href>/dav/Restock/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
      <D:response><D:href>https://cloud.example.com/dav/Restock/restock-sync-a.bin</D:href><D:propstat><D:prop><D:getcontentlength>12</D:getcontentlength><D:getlastmodified>Sun, 01 Nov 2026 00:00:00 GMT</D:getlastmodified><D:resourcetype/></D:prop></D:propstat></D:response>
      <D:response><D:href>/dav/Restock/My%20notes.txt</D:href><D:propstat><D:prop><D:getcontentlength>3</D:getcontentlength></D:prop></D:propstat></D:response>
      <D:response><D:href>/dav/Restock/sub/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
      </D:multistatus>`;
    expect(parseListing(xml, 'https://cloud.example.com/dav/Restock/')).toEqual([
      { name: 'restock-sync-a.bin', size: 12, mtime: Date.parse('2026-11-01T00:00:00Z') },
      { name: 'My notes.txt', size: 3, mtime: 0 },
    ]);
  });
});

describe('0.15.0: a WebDAV folder', () => {
  it('is made if missing, then saves, lists, reads and deletes Restock files only', async () => {
    const s = davServer();
    const f = davFolder({ url: 'https://cloud.example.com/dav/Restock', user: 'declan', password: 'app-pass' }, s.http);
    await f.ensure();
    expect(s.folders.has('/dav/Restock/')).toBe(true);
    await f.ensure(); // already there: fine
    await f.write('restock-sync-aaaa.bin', strToU8('hello'));
    s.files.set('/dav/Restock/holiday.jpg', { bytes: strToU8('x'), mtime: 1 });
    expect((await f.list()).map((x) => x.name)).toEqual(['restock-sync-aaaa.bin']);
    expect(strFromU8((await f.read('restock-sync-aaaa.bin'))!)).toBe('hello');
    expect(await f.read('restock-sync-gone.bin')).toBeNull();
    await f.remove('restock-sync-aaaa.bin');
    await f.remove('restock-sync-aaaa.bin'); // already gone: fine
    expect(s.files.has('/dav/Restock/restock-sync-aaaa.bin')).toBe(false);
    // Never anything but Restock's own files, and never a path.
    await expect(f.read('holiday.jpg')).rejects.toThrow(/Not a Restock file/);
    await expect(f.write('restock-../../x', strToU8('x'))).rejects.toThrow(/Not a Restock file/);
    expect(s.files.has('/dav/Restock/holiday.jpg')).toBe(true);
  });

  it('says in words what went wrong', async () => {
    const s = davServer();
    await expect(davFolder({ url: 'https://cloud.example.com/dav/Restock', user: 'declan', password: 'wrong' }, s.http).ensure()).rejects.toThrow(/didn't accept the user name or password/);
    await expect(davFolder({ url: 'https://cloud.example.com/dav/missing/Restock', user: 'declan', password: 'app-pass' }, s.http).ensure()).rejects.toThrow(/folder above that one/);
  });
});

describe('0.15.0: signing in to Nextcloud', () => {
  it('opens Nextcloud’s page, waits, then gets an app password of its own', async () => {
    let done = false;
    const calls: string[] = [];
    const http: DavHttp = async ({ method, url, body }) => {
      calls.push(`${method} ${url}`);
      if (url === 'https://cloud.example.com/index.php/login/v2')
        return { status: 200, headers: {}, bytes: strToU8(JSON.stringify({ login: 'https://cloud.example.com/login/v2/flow/abc', poll: { token: 'tok', endpoint: 'https://cloud.example.com/login/v2/poll' } })) };
      if (url === 'https://cloud.example.com/login/v2/poll') {
        expect(strFromU8(body!)).toBe('token=tok');
        return done ? { status: 200, headers: {}, bytes: strToU8(JSON.stringify({ server: 'https://cloud.example.com', loginName: 'declan', appPassword: 'abc-123' })) } : { status: 404, headers: {}, bytes: new Uint8Array() };
      }
      return { status: 404, headers: {}, bytes: new Uint8Array() };
    };
    const l = await startNextcloud('cloud.example.com/apps/files/', http);
    expect(l.login).toBe('https://cloud.example.com/login/v2/flow/abc');
    expect(await pollNextcloud(l, http)).toBeUndefined();
    done = true;
    expect(await pollNextcloud(l, http)).toEqual({ server: 'https://cloud.example.com', loginName: 'declan', appPassword: 'abc-123' });
    expect(calls[0]).toBe('POST https://cloud.example.com/index.php/login/v2');
  });

  it("turns down a server that isn't Nextcloud", async () => {
    const http: DavHttp = async () => ({ status: 404, headers: {}, bytes: new Uint8Array() });
    await expect(startNextcloud('example.com', http)).rejects.toThrow(/doesn't look like a Nextcloud server/);
    const odd: DavHttp = async () => ({ status: 200, headers: {}, bytes: strToU8('<html>hi</html>') });
    await expect(startNextcloud('example.com', odd)).rejects.toThrow(/wasn't what Nextcloud sends/);
  });
});

async function device(name: string, id: string, io: () => ReturnType<typeof davFolder>) {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  await initDb(driver);
  await updateSettings({ onboarded: true }, { local: true });
  const raw = driver.raw;
  raw.run('UPDATE sync_meta SET value = ? WHERE key = ?', [id, 'device']);
  const sign = (t: string, priv: string | null) => signWithPkcs8(priv ?? '', t);
  const e = new AsyncSyncEngine(asyncSyncDbOf(syncDbOf(raw)), verifySig, signedText, () => Date.now(), { role: 'phone', sign });
  await e.setMeta('name', name);
  const q = (sql: string) => raw.exec(sql)[0]?.values ?? [];
  return { e, raw, q, house: new FolderHouse(e, async () => io(), () => Date.now()) };
}

describe('0.15.0: two iPhones in a household folder on WebDAV', () => {
  it('join and share both ways, with nothing readable on the server', async () => {
    const s = davServer();
    const folder = davFolder({ url: 'https://cloud.example.com/dav/Restock', user: 'declan', password: 'app-pass' }, s.http);
    await folder.ensure();
    const a = await device("Declan's iPhone", 'aaaa000000000001', () => folder);
    const b = await device("Sarah's iPhone", 'bbbb000000000002', () => folder);
    a.raw.run("INSERT INTO items (id, name, created_at, section) VALUES ('i-milk', 'Milk', '2026-11-01T00:00:00.000Z', 'pantry')");
    b.raw.run("INSERT INTO items (id, name, created_at, section) VALUES ('i-bread', 'Bread', '2026-11-01T00:00:00.000Z', 'pantry')");
    (await a.house.start('Declan and Sarah'));
    await a.house.sync();
    await b.house.askToJoin((await a.house.invite()).code);
    await a.house.sync();
    expect((await b.house.sync()).justJoined).toBe(true);
    await a.house.sync();
    const names = (d: { q: (s: string) => unknown[][] }) => d.q('SELECT name FROM items ORDER BY name').map((r) => r[0]);
    expect(names(a)).toEqual(['Bread', 'Milk']);
    expect(names(b)).toEqual(['Bread', 'Milk']);
    for (const [, f] of s.files) expect(strFromU8(f.bytes, true)).not.toMatch(/Milk|Bread|Sarah/);
    expect([...s.files.keys()].every((p) => p.startsWith('/dav/Restock/restock-'))).toBe(true);
  });
});
