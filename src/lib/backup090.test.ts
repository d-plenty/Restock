import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { addListEntry, ensureDefaults, getSettings, initDb, snapshot, updateSettings } from './db';
import { loadDemo } from './demo';
import { backupJson, EVERYTHING, readBackup } from './backup';
import { isLocked, lockBackup, unlockBackup } from './backupLock';
import { csv, csvFiles } from './csvExport';
import { createSqlJsDriver } from './sql/sqljs';

// 0.9.0: backup passwords and the spreadsheet export.

beforeEach(async () => {
  await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
  await ensureDefaults();
});

describe('backup passwords', () => {
  it('locks a backup so only the password opens it', async () => {
    await loadDemo();
    const plain = await backupJson(EVERYTHING);
    const locked = await backupJson({ ...EVERYTHING, password: 'correct horse' });
    expect(isLocked(locked)).toBe(true);
    expect(isLocked(plain)).toBe(false);
    expect(locked).not.toContain('Milk');
    await expect(unlockBackup(locked, 'wrong horse')).rejects.toThrow('doesn’t open this backup');
    const opened = await unlockBackup(locked, 'correct horse');
    expect(readBackup(opened).counts.items).toBe(readBackup(plain).counts.items);
  });

  it('never puts the automatic backups’ password in a backup', async () => {
    const s = await getSettings();
    await updateSettings({ autoBackup: { ...s.autoBackup, password: 'hunter2hunter2' } });
    const json = await backupJson(EVERYTHING);
    expect(json).not.toContain('hunter2');
    expect(readBackup(json).counts.hasSettings).toBe(true);
    // Nor the password asked for when exporting.
    expect(await unlockBackup(await backupJson({ ...EVERYTHING, password: 'abcdefgh1' }), 'abcdefgh1')).not.toContain('abcdefgh1');
  });

  it('keeps this phone’s password when a backup is restored', async () => {
    const s = await getSettings();
    await updateSettings({ autoBackup: { ...s.autoBackup, password: 'hunter2hunter2' } });
    const summary = readBackup(await backupJson(EVERYTHING));
    const { restoreSnapshot, restoreParts } = await import('./db');
    await restoreSnapshot(summary.snapshot);
    expect((await getSettings()).autoBackup.password).toBe('hunter2hunter2');
    await restoreParts(summary.snapshot, { pantry: false, list: false, cards: false, settings: true });
    expect((await getSettings()).autoBackup.password).toBe('hunter2hunter2');
  });

  it('round-trips any text', async () => {
    const t = JSON.stringify({ app: 'restock', version: 2, tables: {}, note: 'é ✓ 🛒' });
    expect(await unlockBackup(await lockBackup(t, 'pässwörd'), 'pässwörd')).toBe(t);
  });
});

describe('spreadsheets', () => {
  it('quotes what needs it and keeps formulas out', () => {
    expect(csv([['a', 'b,c', 'say "hi"', '=SUM(A1)', 3]])).toBe('﻿a,"b,c","say ""hi""","\'=SUM(A1)",3\r\n');
  });

  it('makes the pantry, list and price history', async () => {
    await loadDemo();
    await addListEntry({ id: 'x1', text: 'Bin bags', checked: false, createdAt: '2026-11-09T00:00:00Z', qty: 2 });
    const files = csvFiles(await snapshot());
    expect(files.map((f) => f.name)).toEqual(['restock-pantry.csv', 'restock-shopping-list.csv', 'restock-price-history.csv']);
    const [pantry, list, prices] = files.map((f) => f.text.replace('﻿', '').split('\r\n'));
    expect(pantry[0]).toBe('Tab,Item,Category,Kind,Shop,Product,Brand,Size,Barcode,Latest price,Usual price,On special,Checked');
    expect(pantry.length).toBeGreaterThan(3);
    expect(list).toContain('Bin bags,2,,No,2026-11-09');
    // Sample items' prices are left out (they aren't real).
    expect(prices.length).toBe(2);
  });
});
