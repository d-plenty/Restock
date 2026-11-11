import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SyncInfo } from '../../lib/sql/native';

// 0.9.6: Wi-Fi sync is its own optional feature (off in a server's house until set up), leaving a
// server has its own labelled button, and the "Backup from before ..." list is gone.

vi.mock('../../lib/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/db')>();
  return { ...real, getSettings: async () => undefined as never };
});

const { SyncOverview } = await import('./SyncOverview');
const { NavContext } = await import('../nav');
const nav = { toast: () => undefined, pop: () => undefined, push: () => undefined } as never;
const settings = { autoBackup: { enabled: false, keep: 5 }, household: { name: 'Home' } } as never;
const html = (info: SyncInfo) =>
  renderToStaticMarkup(createElement(NavContext.Provider, { value: nav }, createElement(SyncOverview, { settings, info, onInfo: () => undefined }))).replace(/&#x27;/g, "'");
const house = (more: Partial<SyncInfo> = {}) =>
  ({ paired: true, house: true, serverApi: 3, server: true, serverLabel: 'Home', members: [{ device: 'a', name: 'Me', me: true }], ...more }) as SyncInfo;

describe('Wi-Fi sync in a server house (0.9.6)', () => {
  it('shows as an optional Wi-Fi sync that is off, never "Phones on your Wi-Fi: On"', () => {
    const off = html(house({ wifiSync: false }));
    expect(off).toContain('Wi-Fi sync (phone to phone)');
    expect(off).toContain('Off · optional');
    expect(off).not.toContain('Phones on your Wi-Fi');
  });
  it('is on only when set up', () => {
    expect(html(house({ wifiSync: true }))).toContain('On · ');
  });
  it('0.9.6 (review L4): when the phone can\'t say, a server house shows it off', () => {
    const unknown = html(house({ wifiSync: undefined }));
    expect(unknown).toContain('Off · optional');
    expect(unknown).not.toContain('Phones on your Wi-Fi');
  });
});

describe('wifiSyncOn (0.9.6, review L4)', () => {
  it('the phone\'s answer wins; without one, off in a server house and on for a household of phones', async () => {
    const { wifiSyncOn } = await import('../../lib/protection');
    expect(wifiSyncOn({ wifiSync: true, house: true })).toBe(true);
    expect(wifiSyncOn({ wifiSync: false })).toBe(false);
    expect(wifiSyncOn({ house: true })).toBe(false);
    expect(wifiSyncOn({ serverApi: 3 })).toBe(false);
    expect(wifiSyncOn({})).toBe(true);
    expect(wifiSyncOn(undefined)).toBe(true);
  });
  it('the phone says off, not on, when it can\'t work it out (SyncHub.wifiOn)', () => {
    const hub = readFileSync(new URL('../../../android/app/src/main/java/family/plenty/restock/SyncHub.java', import.meta.url), 'utf8');
    const body = hub.slice(hub.indexOf('boolean wifiOn()'), hub.indexOf('void setWifi('));
    expect(body).toContain('return false;');
    expect(body).not.toContain('return true;');
  });
});

describe('screens (0.9.6)', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  it('Stop syncing on the Wi-Fi screen never leaves the server; the server screen has Leave this server', () => {
    const sync = read('./Sync.tsx');
    expect(sync).not.toContain('setLeavingServer');
    expect(sync).toContain('Stop Wi-Fi sync');
    expect(sync).toContain('Set up Wi-Fi sync');
    const server = read('./RestockServer.tsx');
    expect(server).toContain('Leave this server');
  });
  it('no more Backup from before lists or before-update backups', () => {
    expect(read('./Settings.tsx')).not.toMatch(/Backup from before|beforeUpdate|BEFORE_UPGRADE/);
    const boot = read('../../lib/boot.ts');
    expect(boot).not.toMatch(/saveCopyInApp|BEFORE_UPDATE|backupBeforeUpdate/);
  });
});
