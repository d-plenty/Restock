import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { b64ToBytes, bytesToB64, databaseStore, DB_FILE, looksLikeSqlite, type FileStore } from './store';

// The iPhone and iPad app's database file: where it's read from at start-up, where saves go, and
// what happens when a save fails.

const memFile = (): FileStore & { files: Map<string, Uint8Array>; fail: boolean; writes: number } => {
  const files = new Map<string, Uint8Array>();
  const f = {
    files,
    fail: false,
    writes: 0,
    read: async (name: string) => files.get(name),
    write: async (name: string, bytes: Uint8Array) => {
      if (f.fail) throw new Error('disk full');
      f.writes++;
      files.set(name, bytes.slice());
    },
    remove: async (name: string) => void files.delete(name),
  };
  return f;
};
const memWeb = () => {
  const m = new Map<string, unknown>();
  return { m, get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => void m.set(k, v) };
};
const aDatabase = async (name: string) => {
  const d = await createSqlJsDriver({ load: () => initSqlJs() });
  await d.run('CREATE TABLE t (name TEXT)');
  await d.run('INSERT INTO t VALUES (?)', [name]);
  return d.raw.export();
};
const nameIn = async (bytes: Uint8Array | undefined) => {
  const d = await createSqlJsDriver({ load: () => initSqlJs(), restore: async () => bytes });
  return (await d.query<{ name: string }>('SELECT name FROM t'))[0]?.name;
};

describe('the iPhone database file', () => {
  it('base64 goes there and back, including big files', () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 31) % 256);
    expect(b64ToBytes(bytesToB64(big))).toEqual(big);
    expect(b64ToBytes(bytesToB64(new Uint8Array()))).toEqual(new Uint8Array());
  });

  it('only loads something that is a SQLite file', async () => {
    expect(looksLikeSqlite(await aDatabase('x'))).toBe(true);
    expect(looksLikeSqlite(new Uint8Array(200))).toBe(false);
    expect(looksLikeSqlite(undefined)).toBe(false);
  });

  it('first start after updating: the web view copy is read, then written to the file, and left where it is', async () => {
    const file = memFile();
    const web = memWeb();
    web.m.set('db', await aDatabase('from web'));
    const store = databaseStore(file, web);
    const bytes = await store.restore();
    expect(await nameIn(bytes)).toBe('from web');
    expect(store.needsFirstWrite()).toBe(true);
    await store.persist(bytes!);
    expect(await nameIn(file.files.get(DB_FILE))).toBe('from web');
    expect(store.needsFirstWrite()).toBe(false);
    expect(web.m.get('db')).toBeTruthy();
  });

  it('after that the file is what is read, not the old web view copy', async () => {
    const file = memFile();
    const web = memWeb();
    web.m.set('db', await aDatabase('old web copy'));
    file.files.set(DB_FILE, await aDatabase('the file'));
    const store = databaseStore(file, web);
    expect(await nameIn(await store.restore())).toBe('the file');
    expect(store.needsFirstWrite()).toBe(false);
  });

  it('a failed save is reported, kept in the web view, and read back from there next time', async () => {
    const file = memFile();
    const web = memWeb();
    file.files.set(DB_FILE, await aDatabase('older'));
    const store = databaseStore(file, web);
    file.fail = true;
    await expect(store.persist(await aDatabase('newer'))).rejects.toThrow('disk full');
    expect(web.m.get('fileBehind')).toBe(1);
    const again = databaseStore(file, web);
    expect(await nameIn(await again.restore())).toBe('newer');
    expect(again.needsFirstWrite()).toBe(true);
    file.fail = false;
    await again.persist(await aDatabase('newest'));
    expect(web.m.get('fileBehind')).toBe(0);
    expect(await nameIn(await databaseStore(file, web).restore())).toBe('newest');
  });

  it('a damaged file is not loaded: the web view copy is used', async () => {
    const file = memFile();
    const web = memWeb();
    file.files.set(DB_FILE, new Uint8Array(500));
    web.m.set('db', await aDatabase('web'));
    expect(await nameIn(await databaseStore(file, web).restore())).toBe('web');
  });

  it('without the file store (an older build of the native side) it keeps using the web view', async () => {
    const web = memWeb();
    const store = databaseStore(undefined, web);
    expect(await store.restore()).toBeUndefined();
    await store.persist(await aDatabase('w'));
    expect(await nameIn(await store.restore())).toBe('w');
  });
});

describe('saving the in-memory database', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it('saves after a write, in order, and reports a failure then tries again at the next flush', async () => {
    const saved: string[] = [];
    const heard: (unknown | undefined)[] = [];
    let fail = true;
    const d = await createSqlJsDriver({
      load: () => initSqlJs(),
      saveAfterMs: 10,
      persist: async (bytes) => {
        if (fail) throw new Error('no room');
        saved.push((await nameIn(bytes)) ?? '');
      },
      onSaved: (e) => heard.push(e),
    });
    await d.run('CREATE TABLE t (name TEXT)');
    await d.run('INSERT INTO t VALUES (?)', ['a']);
    await wait(40);
    expect(heard.length).toBe(1);
    expect(heard[0]).toBeInstanceOf(Error);
    fail = false;
    await d.flush();
    expect(saved).toEqual(['a']);
    expect(heard[1]).toBeUndefined();
    await d.flush(); // nothing waiting: nothing written
    expect(saved).toEqual(['a']);
  });

  it('a steady run of writes cannot put the save off for ever', async () => {
    let saves = 0;
    const d = await createSqlJsDriver({ load: () => initSqlJs(), saveAfterMs: 50, saveWithinMs: 120, persist: async () => void saves++ });
    await d.run('CREATE TABLE t (name TEXT)');
    for (let i = 0; i < 12; i++) {
      await d.run('INSERT INTO t VALUES (?)', [String(i)]);
      await wait(20);
    }
    expect(saves).toBeGreaterThanOrEqual(1);
  });

  it('touched() marks a direct write to the raw database for saving', async () => {
    let saves = 0;
    const d = await createSqlJsDriver({ load: () => initSqlJs(), saveAfterMs: 5, persist: async () => void saves++ });
    d.raw.run('CREATE TABLE t (name TEXT)');
    d.touched();
    await d.flush();
    expect(saves).toBe(1);
  });
});
