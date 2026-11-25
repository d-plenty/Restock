import { describe, expect, it } from 'vitest';
import { appTooOld, MIN_APP, oldAppWords, versionParts } from './minVersion';

describe('the oldest Restock that still syncs', () => {
  it('is 0.14.0', () => expect(MIN_APP).toBe('0.14.0'));
  it('calls older versions too old, and the same or newer fine', () => {
    for (const v of ['0.9.4', '0.13.1', '0.13.9', '0.12.10']) expect(appTooOld(v), v).toBe(true);
    for (const v of ['0.14.0', '0.14.1', '0.15.0', '1.0.0', '0.14.0-debug']) expect(appTooOld(v), v).toBe(false);
  });
  it('never calls an unknown version too old', () => {
    for (const v of [undefined, null, '', 'abc', '1.2']) expect(appTooOld(v)).toBe(false);
    expect(versionParts('0.14.1')).toEqual([0, 14, 1]);
  });
  it('tells the person what to do', () => expect(oldAppWords()).toContain('Update Restock on this phone to 0.14.0 or newer'));
});
