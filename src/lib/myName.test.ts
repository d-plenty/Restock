import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 0.16.0: what to call the person (myName.ts).

const calls: { name?: string }[] = [];
let info: { name?: string; defaultName?: string } = {};
let ios = false;
vi.mock('@capacitor/core', async (orig) => {
  const real = await orig<typeof import('@capacitor/core')>();
  return { ...real, Capacitor: { ...real.Capacitor, isNativePlatform: () => true, getPlatform: () => (ios ? 'ios' : 'android') } };
});
vi.mock('./sql/native', async (orig) => {
  const real = await orig<typeof import('./sql/native')>();
  return {
    ...real,
    RestockNative: {
      syncInfo: async () => ({ paired: false, ...info }),
      syncSet: async (o: { name?: string }) => {
        calls.push(o);
        if (o.name) info.name = o.name;
        return { paired: false, ...info };
      },
    },
  };
});
vi.mock('./platform', async (orig) => {
  const real = await orig<typeof import('./platform')>();
  return { ...real, isIos: () => ios, deviceWord: () => (ios ? 'iPhone' : 'phone') };
});

const db = await import('./db');
const { createSqlJsDriver } = await import('./sql/sqljs');
const m = await import('./myName');
const { autoName } = await import('./autoBackup');

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
beforeEach(async () => {
  calls.length = 0;
  info = { name: 'Pixel 7', defaultName: 'Pixel 7' };
  ios = false;
  await db.initDb(await createSqlJsDriver({ load: async () => SQL }));
  await db.ensureDefaults();
});

describe('your name', () => {
  it('is tidied, and the greeting has it only when there is one', () => {
    expect(m.cleanName('  Dec \n  lan  ')).toBe('Dec lan');
    expect(m.cleanName('x'.repeat(50))).toHaveLength(m.NAME_MAX);
    expect(m.withName('Good morning', { myName: 'Declan' })).toBe('Good morning, Declan');
    expect(m.withName('Good morning', { myName: '   ' })).toBe('Good morning');
    expect(m.withName('Good morning', {})).toBe('Good morning');
  });

  it('goes into file names safely', () => {
    expect(m.fileNamePart({ myName: 'Zoë & Sam' })).toBe('Zoe-Sam');
    expect(m.fileNamePart({ myName: '../../etc' })).toBe('etc');
    expect(m.fileNamePart({})).toBe('');
    expect(autoName(new Date(2026, 10, 7, 9, 15), 'Declan')).toBe('restock-auto-2026-11-07-0915-Declan.json');
    expect(autoName(new Date(2026, 10, 7, 9, 15))).toBe('restock-auto-2026-11-07-0915.json');
  });

  it('names the phone "Declan’s iPhone", and a name ending in s gets only the apostrophe', () => {
    expect(m.phoneLabelFor('Declan', 'iPhone')).toBe('Declan’s iPhone');
    expect(m.phoneLabelFor('James', 'Pixel 7')).toBe('James’ Pixel 7');
    expect(m.phoneLabelFor('', 'iPad')).toBe('iPad');
  });

  it('saving names this phone in the household while it still has its own name, and follows later changes', async () => {
    await m.setMyName('Declan');
    expect((await db.getSettings()).myName).toBe('Declan');
    expect((await db.getSettings()).nameAsked).toBe(true);
    expect(calls.at(-1)).toEqual({ name: 'Declan’s Pixel 7' });
    await m.setMyName('Dec');
    expect(calls.at(-1)).toEqual({ name: 'Dec’s Pixel 7' });
    // Cleared: back to the phone's own name.
    await m.setMyName('');
    expect((await db.getSettings()).myName).toBeUndefined();
    expect(calls.at(-1)).toEqual({ name: 'Pixel 7' });
  });

  it("never replaces a name someone gave the phone themselves", async () => {
    info.name = 'Kitchen tablet';
    await m.setMyName('Declan');
    expect(calls).toHaveLength(0);
  });

  it('on iPhone, the base is iPhone; skipping is asked once', async () => {
    ios = true;
    info = { name: 'iPhone' };
    await m.setMyName('Sarah');
    expect(calls.at(-1)).toEqual({ name: 'Sarah’s iPhone' });
    await db.updateSettings({ nameAsked: false });
    await m.skipName();
    expect((await db.getSettings()).nameAsked).toBe(true);
  });

  it('comes back with a backup (it is one of the settings in it)', async () => {
    await m.setMyName('Declan');
    const snap = await db.snapshot();
    const s = snap.kv.find((k) => k.key === 'settings')!.value as { myName?: string };
    expect(s.myName).toBe('Declan');
  });
});
