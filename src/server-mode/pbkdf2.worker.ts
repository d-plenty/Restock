// Server mode: the passphrase's 600 000 PBKDF2 rounds off the page's thread (crypto.ts).
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';

self.onmessage = async (e: MessageEvent<{ pw: Uint8Array; salt: Uint8Array; rounds: number }>) => {
  try {
    const out = await pbkdf2Async(sha256, e.data.pw, e.data.salt, { c: e.data.rounds, dkLen: 64, asyncTick: 50 });
    (self as unknown as Worker).postMessage({ out });
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
