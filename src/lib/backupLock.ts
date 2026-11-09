// Backup passwords (0.9.0): a backup file can be locked with a password. The whole backup is
// encrypted on the phone (AES-256-GCM, with a key made from the password by PBKDF2-SHA256), so the
// file says nothing about what's in it without the password. Nothing about the password is kept
// in the file; if it's forgotten, the backup can't be opened, by anyone.

import { base64ToBytes, bytesToBase64 } from './base64';

export interface LockedBackup {
  app: 'restock';
  version: 2;
  locked: { v: 1; kdf: 'PBKDF2-SHA256'; iterations: number; salt: string; iv: string; data: string };
}

/**
 * 0.9.0: new backups use 600,000 rounds of PBKDF2-SHA256 (OWASP's advice), so guessing a password
 * takes about twice as long as with the 310,000 earlier builds used. Backups locked with those still open.
 */
export const ITERATIONS = 600_000;
/**
 * A locked backup only opens if it asks for a sensible number of rounds: not so few that it
 * wasn't made by Restock, not so many that the phone would hang trying.
 */
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 5_000_000;
export const NOT_OURS = 'That backup’s lock isn’t one Restock made.';

async function keyFrom(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Is this backup file's text a locked (password) backup? */
export function isLocked(text: string): boolean {
  if (!text.includes('"locked"')) return false;
  try {
    const f = JSON.parse(text) as Partial<LockedBackup>;
    return f.app === 'restock' && !!f.locked?.data;
  } catch {
    return false;
  }
}

/** Locks a backup's text with a password. */
export async function lockBackup(json: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt, ITERATIONS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json)));
  const file: LockedBackup = {
    app: 'restock',
    version: 2,
    locked: { v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(data) },
  };
  return JSON.stringify(file);
}

/** Opens a locked backup; throws "That password doesn't open this backup." if it's wrong. */
export async function unlockBackup(text: string, password: string): Promise<string> {
  const f = JSON.parse(text) as LockedBackup;
  const l = f.locked;
  // 0.9.0: checked before anything is worked out (see MIN_ITERATIONS).
  const n = l?.iterations;
  if (
    !l ||
    l.kdf !== 'PBKDF2-SHA256' ||
    typeof n !== 'number' ||
    !Number.isInteger(n) ||
    n < MIN_ITERATIONS ||
    n > MAX_ITERATIONS ||
    typeof l.salt !== 'string' ||
    typeof l.iv !== 'string' ||
    typeof l.data !== 'string'
  )
    throw new Error(NOT_OURS);
  try {
    const key = await keyFrom(password, base64ToBytes(l.salt), l.iterations);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(l.iv) as BufferSource }, key, base64ToBytes(l.data) as BufferSource);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('That password doesn’t open this backup.');
  }
}
