import { describe, expect, it } from 'vitest';
import { needsBackupNudge } from './backup';
import { protection, suggestLocalText } from './protection';

describe('0.9.3: what counts as kept somewhere else', () => {
  it('nothing on: not covered', () => {
    const p = protection(false, { paired: false, server: false });
    expect(p).toMatchObject({ covered: false, suggestLocal: false, short: 'Off' });
    expect(protection(false, undefined).covered).toBe(false);
  });
  it('any one of the three counts', () => {
    expect(protection(true, null)).toMatchObject({ covered: true, suggestLocal: false, short: 'Backed up' });
    expect(protection(false, { paired: true })).toMatchObject({ covered: true, suggestLocal: true, short: 'Synced' });
    expect(protection(false, { paired: true, server: true })).toMatchObject({ covered: true, suggestLocal: true, short: 'Server' });
  });
  it('any mix is fine, and a local backup stops the suggestion', () => {
    expect(protection(true, { paired: true, server: true })).toMatchObject({ covered: true, suggestLocal: false, short: 'Backup + server' });
    expect(protection(true, { paired: true })).toMatchObject({ suggestLocal: false, short: 'Backup + phones' });
  });
  it('the suggestion names the reason', () => {
    expect(suggestLocalText(protection(false, { paired: true, server: true }))).toMatch(/down or out of reach/);
    expect(suggestLocalText(protection(false, { paired: true }))).toMatch(/goes to every phone/);
  });
  it('the Home nudge stays quiet when sync or a server keeps a copy', () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    const old = '2026-10-01T00:00:00Z';
    expect(needsBackupNudge({}, 10, old, now)).toBe(true);
    expect(needsBackupNudge({}, 10, old, now, true)).toBe(false);
  });
});

import { syncStatus } from './protection';

describe('0.9.3: the Sync and backups strip', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  it('nothing on asks for something', () => {
    expect(syncStatus({ enabled: false }, { paired: false }, now)).toMatchObject({ ok: false, title: "Nothing's kept anywhere else yet", cells: [] });
  });
  it('all well shows one cell per copy', () => {
    const s = syncStatus(
      { enabled: true, lastAt: '2026-11-09T20:00:00Z' },
      { paired: true, server: true, serverAt: '2026-11-09T23:59:00Z', lastSyncAt: '2026-11-09T23:50:00Z', members: [1, 2] },
      now,
    );
    expect(s.ok).toBe(true);
    expect(s.title).toBe('All up to date');
    // 0.9.4: the server first, then the phones, then the last backup (a day and a time).
    expect(s.cells.map((c) => c.label)).toEqual(['Server', 'Phones', 'Last backup']);
  });
  it('names the first problem', () => {
    expect(syncStatus({ enabled: true, lastError: 'no folder' }, { paired: false }, now).title).toBe('The last automatic backup failed');
    expect(syncStatus({ enabled: false }, { paired: true, server: true, serverError: 'down' }, now).title).toBe("Your Restock server can't be reached");
    expect(syncStatus({ enabled: false }, { paired: true, members: [1, 2], lastSyncAt: '2026-10-01T00:00:00Z' }, now).title).toBe(
      "Your phones haven't synced in a week",
    );
    // A household of one phone: no other phone holds a copy yet.
    expect(syncStatus({ enabled: false }, { paired: true, members: [1] }, now).title).toBe("Nothing's kept anywhere else yet");
    expect(syncStatus({ enabled: false }, { paired: true, members: [1], server: true }, now).ok).toBe(true);
  });
});
