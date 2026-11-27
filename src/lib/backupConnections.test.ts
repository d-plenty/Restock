// 0.18.3: Connections never go in a file anyone could open: only locked, or sent straight across.
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDefaults, initDb } from './db';
import { createSqlJsDriver } from './sql/sqljs';

vi.mock('./connections', () => ({
  collectConnections: async () => ({ homeAssistant: { address: 'http://homeassistant.local:8123', entity: 'todo.shopping_list', enabled: true, token: 'secret-token' } }),
  restoreConnections: async () => ({ server: 'join' }),
}));
const { backupJson, EVERYTHING, readBackup, restoreBackup, lastRestoreServer } = await import('./backup');
const { unlockBackup } = await import('./backupLock');

beforeEach(async () => {
  await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
  await ensureDefaults();
});

describe('0.18.3: Connections in a backup', () => {
  it('not in a plain file, even when ticked; in a locked one and one sent straight across', async () => {
    expect(await backupJson({ ...EVERYTHING, connections: true })).not.toContain('secret-token');
    expect(await backupJson({ ...EVERYTHING, connections: false, password: 'correct horse' })).not.toContain('connections');
    const locked = await backupJson({ ...EVERYTHING, connections: true, password: 'correct horse' });
    const s = readBackup(await unlockBackup(locked, 'correct horse'));
    expect(s.connections?.homeAssistant?.token).toBe('secret-token');
    expect(readBackup(await backupJson({ ...EVERYTHING, connections: true, direct: true })).connections).toBeTruthy();
  });

  it('restored only when ticked', async () => {
    const s = readBackup(await backupJson({ ...EVERYTHING, connections: true, direct: true }));
    await restoreBackup(s, { pantry: false, list: false, cards: false, settings: false });
    expect(lastRestoreServer()).toBeUndefined();
    await restoreBackup(s, { pantry: false, list: false, cards: false, settings: false, connections: true });
    expect(lastRestoreServer()).toBe('join');
  });
});
