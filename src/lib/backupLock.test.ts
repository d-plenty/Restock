import { describe, expect, it } from 'vitest';
import { ITERATIONS, lockBackup, NOT_OURS, unlockBackup, type LockedBackup } from './backupLock';

// 0.9.0: new backups use 600,000 rounds; ones locked with 310,000 still open; a lock asking for
// too few or too many rounds isn't one Restock made, and is turned down before any work.

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A locked backup made the way a given number of rounds would make it (as older builds did). */
async function lockWith(json: string, password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
  ]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json)));
  const file: LockedBackup = {
    app: 'restock',
    version: 2,
    locked: { v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: b64(salt), iv: b64(iv), data: b64(data) },
  };
  return JSON.stringify(file);
}

describe('backup locks (0.9.0)', () => {
  it('locks new backups with 600,000 rounds', async () => {
    expect(ITERATIONS).toBe(600_000);
    const locked = await lockBackup('{"app":"restock"}', 'correct horse');
    expect((JSON.parse(locked) as LockedBackup).locked.iterations).toBe(600_000);
    expect(await unlockBackup(locked, 'correct horse')).toBe('{"app":"restock"}');
  });

  it('still opens a backup locked with 310,000 rounds', async () => {
    const old = await lockWith('{"app":"restock","old":true}', 'correct horse', 310_000);
    expect(await unlockBackup(old, 'correct horse')).toBe('{"app":"restock","old":true}');
    await expect(unlockBackup(old, 'wrong horse')).rejects.toThrow('doesn’t open this backup');
  });

  it('turns down a lock with too few or too many rounds, or an odd shape', async () => {
    const ok = JSON.parse(await lockWith('{}', 'pw', 100_000)) as LockedBackup;
    expect(await unlockBackup(JSON.stringify(ok), 'pw')).toBe('{}');
    for (const iterations of [1, 99_999, 5_000_001, 1e12, 310_000.5, '310000', null]) {
      const odd = { ...ok, locked: { ...ok.locked, iterations } };
      await expect(unlockBackup(JSON.stringify(odd), 'pw')).rejects.toThrow(NOT_OURS);
    }
    await expect(unlockBackup(JSON.stringify({ ...ok, locked: { ...ok.locked, kdf: 'scrypt' } }), 'pw')).rejects.toThrow(NOT_OURS);
    await expect(unlockBackup(JSON.stringify({ ...ok, locked: { ...ok.locked, salt: 5 } }), 'pw')).rejects.toThrow(NOT_OURS);
    await expect(unlockBackup(JSON.stringify({ app: 'restock', version: 2 }), 'pw')).rejects.toThrow(NOT_OURS);
  });
});
