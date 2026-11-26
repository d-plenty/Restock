import { describe, expect, it } from 'vitest';
import { version } from '../../package.json';
import { skippedNotes, versionBefore, WHATS_NEW } from './whatsNew';
import { EARLIER } from './whatsNewHistory';

// 0.17.0: What's new for someone who skipped some updates.
describe("what's new after skipping updates", () => {
  it('compares versions number by number', () => {
    expect(versionBefore('0.14.6', '0.17.0')).toBe(true);
    expect(versionBefore('0.12.10', '0.12.9')).toBe(false);
    expect(versionBefore('0.12.9', '0.12.10')).toBe(true);
    expect(versionBefore('0.17.0', '0.17.0')).toBe(false);
  });
  it('offers every version between the one you had and this one, newest first', () => {
    const got = skippedNotes('0.14.1', '0.17.0', EARLIER).map((v) => v.version);
    expect(got).toEqual(['0.16.0', '0.15.2', '0.15.1', '0.15.0']);
  });
  it('none when nothing was skipped, or it is not known', () => {
    expect(skippedNotes('0.16.0', '0.17.0', EARLIER)).toEqual([]);
    expect(skippedNotes(undefined, '0.17.0', EARLIER)).toEqual([]);
    expect(skippedNotes('0.17.0', '0.17.0', EARLIER)).toEqual([]);
  });
  it('has notes for every version from 0.12.0, in plain words, newest first, none twice', () => {
    const all = [...WHATS_NEW, ...EARLIER];
    expect(all[0].version).toBe(version);
    for (let i = 1; i < all.length; i++) expect(versionBefore(all[i].version, all[i - 1].version)).toBe(true);
    expect(all[all.length - 1].version).toBe('0.12.0');
    for (const v of all) {
      expect(v.about.trim()).not.toBe('');
      expect(v.changes.length).toBeGreaterThan(0);
      for (const c of v.changes) expect(c).not.toMatch(/\*\*|https?:/);
    }
  });
});
