import { describe, expect, it } from 'vitest';
import { wasSince } from './wasSince';

const now = new Date(2026, 10, 19); // 19 Nov 2026

describe('0.12.7: "Was $5.80 - 01/09/2026" on a special', () => {
  it('said in plain words, and flagged when more than 14 days old', () => {
    expect(wasSince('Was $5.80 - 01/09/2026', now)).toEqual({ text: 'Was $5.80 until 1 Sep 2026', old: true, days: 79 });
  });
  it('14 days or less is not flagged', () => {
    expect(wasSince('Was $6 - 05/11/2026', now)).toMatchObject({ text: 'Was $6.00 until 5 Nov 2026', old: false, days: 14 });
    expect(wasSince('Was $6 - 04/11/2026', now)?.old).toBe(true);
    expect(wasSince('was $3.50 – 18/11/2026', now)?.old).toBe(false);
  });
  it('any other promo text is left alone', () => {
    expect(wasSince('2 for $12', now)).toBeUndefined();
    expect(wasSince('Was $5.80', now)).toBeUndefined();
    expect(wasSince('Was $5.80 - 31/02/2026', now)).toBeUndefined();
    expect(wasSince(undefined, now)).toBeUndefined();
  });
});
