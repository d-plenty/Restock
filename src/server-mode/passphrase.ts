// Server mode: what makes a passphrase good enough (docs/server-protocol.md "Web users"), checked in
// the page: at least 20 characters or 4 words, not a common password, not the user name, not
// "admin". The meter is a rough guess at how long it would take to guess, shown in plain words.

/** Passwords people pick most (and the ones a Restock server starts with). Lower case, no spaces. */
const COMMON = new Set(
  (
    'admin password passw0rd password1 password123 123456 1234567 12345678 123456789 1234567890 qwerty qwertyuiop ' +
    'iloveyou letmein welcome welcome1 monkey dragon football baseball sunshine princess shadow master superman ' +
    'trustno1 abc123 111111 000000 654321 qazwsx asdfgh zxcvbnm changeme default restock restockserver ' +
    'correcthorsebatterystaple thequickbrownfoxjumpsoverthelazydog administrator letmeinplease opensesame'
  ).split(' '),
);

export interface PassphraseCheck {
  ok: boolean;
  /** What's wrong, for the person (empty when ok). */
  problem: string;
  /** 0 (very weak) … 4 (strong), for the meter. */
  score: number;
  label: string;
}

export const words = (s: string) => s.trim().split(/[\s\-_.,;:]+/u).filter((w) => w.length >= 2);

const squash = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** A rough number of bits: by the kinds of characters used, less for repeats and plain words. */
function bits(p: string): number {
  if (!p) return 0;
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[^A-Za-z0-9\s]/.test(p)) pool += 33;
  if (/\s/.test(p)) pool += 1;
  if (/[^\x00-\x7f]/.test(p)) pool += 100;
  const unique = new Set(p).size;
  const perChar = Math.log2(Math.max(pool, 2));
  // Long runs of the same few characters count for little.
  const length = Math.min(p.length, unique * 3);
  const ws = words(p);
  const w = ws.length;
  // Plain words: about 11 bits each from a big list; whichever estimate is lower.
  const plain = w >= 2 && ws.every((x) => /^\p{L}+$/u.test(x));
  const byWords = plain ? w * 11 + Math.max(0, p.length - w * 6) * 0.5 : Infinity;
  return Math.min(length * perChar * 0.6, byWords);
}

export function checkPassphrase(pass: string, user: string): PassphraseCheck {
  const p = pass.normalize('NFKC');
  const sq = squash(p);
  const u = squash(user);
  const b = bits(p);
  const score = b < 28 ? 0 : b < 40 ? 1 : b < 56 ? 2 : b < 72 ? 3 : 4;
  const label = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][score];
  const fail = (problem: string): PassphraseCheck => ({ ok: false, problem, score: Math.min(score, 1), label: score > 1 ? 'Weak' : label });
  if (!p.trim()) return { ok: false, problem: '', score: 0, label: '' };
  if (sq === 'admin' || sq === u || COMMON.has(sq)) return fail("That's one of the first things anyone would try. Pick something only you'd think of.");
  if (u && sq.includes(u) && sq.length - u.length < 12) return fail("Leave your user name out of it, or add a lot more.");
  if (p.length < 20 && words(p).length < 4) return fail(`Make it at least 20 characters, or 4 words (${p.length} so far).`);
  if (new Set(sq).size < 6) return fail('Use more different letters: a few words from a sentence only you know works well.');
  if (score < 2) return fail('Easy to guess. Add another word or two.');
  return { ok: true, problem: '', score, label };
}
