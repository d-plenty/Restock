import { describe, expect, it } from 'vitest';
import { isLocked, lockBackup, unlockBackup } from './backupLock';
import { makeCardsFile, readCardsFile } from './giftCards';

describe('0.11.0: the cards file is locked with a passphrase', () => {
  const loyalty = [{ id: 'c1', program: 'flybuys' as const, name: 'Flybuys', number: '6008943218616910', createdAt: '2026-11-01T00:00:00Z' }];
  it('holds no card number in the clear, and opens again with the passphrase', async () => {
    const plain = makeCardsFile(loyalty as never, [], {});
    const locked = await lockBackup(plain, 'correct horse battery');
    expect(isLocked(locked)).toBe(true);
    expect(locked).not.toContain('6008943218616910');
    expect(readCardsFile(await unlockBackup(locked, 'correct horse battery')).loyalty[0].number).toBe('6008943218616910');
  }, 30_000);
  it('a wrong passphrase opens nothing', async () => {
    const locked = await lockBackup(makeCardsFile(loyalty as never, [], {}), 'correct horse battery');
    await expect(unlockBackup(locked, 'wrong one here')).rejects.toThrow();
  }, 30_000);
  it('a file saved before 0.11.0 (not locked) still reads', () => {
    const plain = makeCardsFile(loyalty as never, [], {});
    expect(isLocked(plain)).toBe(false);
    expect(readCardsFile(plain).loyalty).toHaveLength(1);
  });
});
