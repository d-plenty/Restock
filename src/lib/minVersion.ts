// 0.15.0: the oldest Restock a household's phones and server still sync with. Older ones are turned
// away with words that say to update (a server answers 403 old-app; the words are shown by the
// phone as they are, so phones from before this file existed show them too).

export const MIN_APP = '0.14.0';
export const OLD_APP_ERROR = 'old-app';
export const oldAppWords = (min = MIN_APP) => `Update Restock on this phone to ${min} or newer to keep syncing. Older versions can't sync with this one.`;

/** "0.13.1" → [0, 13, 1]; anything else → undefined. */
export function versionParts(v: string | null | undefined): number[] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** True when `v` is a version older than `min`. Unknown versions are not called old. */
export function appTooOld(v: string | null | undefined, min = MIN_APP): boolean {
  const a = versionParts(v);
  const b = versionParts(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** "A", "A and B", "A, B and C". */
export const andList = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
