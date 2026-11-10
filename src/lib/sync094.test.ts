import { describe, expect, it } from 'vitest';
import { applyRows, checkBranch, settingChangeOk, settingTab, type SettingsRoom } from './sharedSettings';
import { syncStatus } from './protection';
import { dayAndTime, handoverCode, serverCode, serverCodeVersion, syncNowMessage, webPageCode } from './sync';
import type { SyncNowResult } from './sql/native';

// 0.9.4 (docs/server-v3-design.md): the phone's side of a server-first household, the parts in TypeScript.

const invite = 'abcdefghijklmnopqrstuvwxyz012345';
const kex = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEOMTsPFHlwag3mPC3fxpULBtDatMpPgTgxuBM2qB1K2AS_bgWGcCxT3';

describe('v3 codes', () => {
  it('takes a v3 Add a phone code only with the server key in it', () => {
    const code = `restock-server:3?h=http%3A%2F%2F192.168.1.20%3A8787&i=${invite}&k=${kex}`;
    expect(serverCode(code)).toBe(code);
    expect(serverCodeVersion(code)).toBe(3);
    expect(serverCode(`restock-server:3?h=x&i=${invite}`)).toBeUndefined();
    expect(serverCodeVersion(`restock-server:2?h=x&i=${invite}`)).toBe(2);
  });
  it('reads the Take this household code and a v3 sign-in code', () => {
    expect(handoverCode(`restock-handover:3?u=http%3A%2F%2F192.168.1.20%3A8787&t=${invite}&k=${kex}`)).toBeDefined();
    expect(handoverCode(`restock-handover:3?u=x&t=short&k=${kex}`)).toBeUndefined();
    expect(webPageCode(`restock-login:3?u=http%3A%2F%2Fx&s=abcdefgh12&k=${kex}`)).toBeDefined();
    expect(webPageCode(`restock-link:3?u=http%3A%2F%2Fx&s=abcdefgh12&k=${kex}`)).toBeUndefined();
  });
});

const base: SyncNowResult = { paired: true, batteryExempt: true, reached: 0, received: 0, sent: 0 };

describe('Sync now says what it did', () => {
  it('names the server, the phones and the folder it synced with', () => {
    expect(syncNowMessage({ ...base, server: true, viaServer: true, wifi: false })).toBe('Synced with your server');
    expect(syncNowMessage({ ...base, server: true, viaServer: true, serverLabel: 'Home', wifi: true, reached: 1, names: ["Sarah's phone"], received: 3 })).toBe(
      "Synced with your server, Home and Sarah's phone: 3 changes came in",
    );
    expect(syncNowMessage({ ...base, folder: 'content://x', viaFolder: true, wifi: true, reached: 2 })).toBe('Synced with 2 phones and your drive folder');
  });
  it('never mentions the Wi-Fi phones when Wi-Fi sync is off', () => {
    const off = { ...base, server: true, serverError: "Couldn't reach your Restock server.", wifi: false, lastError: 'No other phones found on this Wi-Fi.' };
    expect(syncNowMessage(off)).toBe("Couldn't reach your Restock server.");
    expect(syncNowMessage({ ...base, wifi: false, lastError: 'No other phones found on this Wi-Fi.' })).not.toMatch(/Wi-Fi/);
    expect(syncNowMessage({ ...base, wifi: true, lastError: 'No other phones found on this Wi-Fi.' })).toBe('No other phones found on this Wi-Fi.');
  });
});

describe('the strip', () => {
  const now = Date.parse('2026-11-10T02:00:00Z');
  it('shows only what is in use, and the last backup as a day and a time', () => {
    const s = syncStatus(
      { enabled: true, lastAt: '2026-11-09T20:00:00Z' },
      { paired: true, server: true, serverAt: '2026-11-10T01:59:00Z', members: [1, 2, 3], wifiSync: false },
      now,
    );
    expect(s.cells.map((c) => c.label)).toEqual(['Server', 'Last backup']);
    expect(s.cells[1].day).toBe(true);
    expect(s.ok).toBe(true);
  });
  it('day and time reads like a person would say it', () => {
    const at = new Date(2026, 10, 10, 6, 0).getTime();
    expect(dayAndTime(new Date(2026, 10, 10, 6, 0).toISOString(), at + 3600_000)).toBe('Today 6:00 am');
    expect(dayAndTime(new Date(2026, 10, 9, 21, 15).toISOString(), at)).toBe('Yesterday 9:15 pm');
    expect(dayAndTime(new Date(2026, 10, 3, 6, 0).toISOString(), at)).toMatch(/^Tue 3 Nov 6:00 am$/);
    expect(dayAndTime(undefined, at)).toBe('Not yet');
  });
});

const room = (rows: string[] = []): SettingsRoom => ({ has: (k) => rows.includes(k), count: () => rows.length, added: () => undefined });

describe('the household default branch (branch:<chain>, written by the web)', () => {
  it('is checked strictly', () => {
    expect(checkBranch('branch:coles', { name: 'Coles Kirwan', storeNo: '0844' })).toEqual({ name: 'Coles Kirwan', storeNo: '0844' });
    expect(checkBranch('branch:coles', { name: '' })).toBeUndefined();
    expect(checkBranch('branch:nowhere', { name: 'X' })).toBeUndefined();
    expect(checkBranch('branch:coles', { name: 'X', storeNo: '08/44' })).toBeUndefined();
    expect(settingChangeOk('branch:coles', { k: 'branch:coles', v: '{"name":"Coles Kirwan"}' }, false, room())).toBe(true);
    expect(settingChangeOk('branch:coles', { k: 'branch:coles', v: '{"name":""}' }, false, room())).toBe(false);
    expect(settingTab('branch:coles', '{}')).toBe('pantry');
  });
  it("fills in a phone's branch only where it hasn't picked its own, and never overwrites its pick", () => {
    const rows = [{ k: 'branch:coles', v: '{"name":"Coles Kirwan","storeNo":"0844"}' }, { k: 'branch:woolworths', v: '{"name":"Woolworths Willows"}' }];
    const s: Record<string, unknown> = { stores: { coles: {}, woolworths: { primary: 'Woolworths Aitkenvale' } } };
    expect(applyRows(s, rows, new Set(['pantry']))).toBe(true);
    const st = s.stores as Record<string, Record<string, string>>;
    expect(st.coles).toMatchObject({ primary: 'Coles Kirwan', branchStoreNo: '0844', householdBranch: 'Coles Kirwan' });
    expect(st.woolworths.primary).toBe('Woolworths Aitkenvale');
    // A new default follows while the phone still has the old one; a phone's own pick stays.
    applyRows(s, [{ k: 'branch:coles', v: '{"name":"Coles Thuringowa","storeNo":"0900"}' }], new Set(['pantry']));
    expect(st.coles.primary ?? (s.stores as Record<string, Record<string, string>>).coles.primary).toBeDefined();
    const after = (s.stores as Record<string, Record<string, string>>).coles;
    expect(after).toMatchObject({ primary: 'Coles Thuringowa', branchStoreNo: '0900' });
    (s.stores as Record<string, Record<string, string>>).coles = { ...after, primary: 'Coles Kirwan' };
    expect(applyRows(s, [{ k: 'branch:coles', v: '{"name":"Coles Annandale"}' }], new Set(['pantry']))).toBe(false);
    // Not applied for a tab this phone doesn't share.
    const t: Record<string, unknown> = { stores: {} };
    expect(applyRows(t, rows, new Set(['keg']))).toBe(false);
  });
});
