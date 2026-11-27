import { describe, expect, it } from 'vitest';
import { easterSunday, holidayColours, holidayGreeting, holidayNow, holidayOn } from './holiday';
import { DEFAULT_SETTINGS } from '../types';

// 0.16.0: the holidays (holiday.ts).
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 9, 0);
const look = (l: Partial<typeof DEFAULT_SETTINGS.look>) => ({ look: { ...DEFAULT_SETTINGS.look, ...l } });

describe('the holidays', () => {
  it('works out Easter Sunday', () => {
    expect(easterSunday(2008)).toEqual({ month: 3, day: 23 });
    expect(easterSunday(2024)).toEqual({ month: 3, day: 31 });
    expect(easterSunday(2025)).toEqual({ month: 4, day: 20 });
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
    expect(easterSunday(2027)).toEqual({ month: 3, day: 28 });
    expect(easterSunday(2038)).toEqual({ month: 4, day: 25 });
  });

  it('knows which holiday a day is in', () => {
    expect(holidayOn(d(2026, 12, 1))).toBe('christmas');
    expect(holidayOn(d(2026, 12, 26))).toBe('christmas');
    expect(holidayOn(d(2026, 12, 27))).toBe('newyear');
    expect(holidayOn(d(2026, 12, 31))).toBe('newyear');
    expect(holidayOn(d(2027, 1, 1))).toBe('newyear');
    // 0.18.0: Australia Day is the week leading up to it, to the day after (19–27 January).
    expect(holidayOn(d(2027, 1, 2))).toBeUndefined();
    expect(holidayOn(d(2027, 1, 18))).toBeUndefined();
    expect(holidayOn(d(2027, 1, 19))).toBe('australia');
    expect(holidayOn(d(2026, 10, 10))).toBeUndefined();
    expect(holidayOn(d(2026, 10, 11))).toBe('halloween');
    expect(holidayOn(d(2026, 10, 31))).toBe('halloween');
    expect(holidayOn(d(2026, 11, 1))).toBe('halloween');
    expect(holidayOn(d(2026, 11, 2))).toBeUndefined();
    expect(holidayOn(d(2027, 1, 27))).toBe('australia');
    expect(holidayOn(d(2027, 1, 28))).toBeUndefined();
    expect(holidayOn(d(2027, 2, 1))).toBeUndefined();
    expect(holidayOn(d(2026, 11, 26))).toBeUndefined();
    // Easter 2027 is Sunday 28 March: the three weeks up to Easter Monday (9–29 March).
    expect(holidayOn(d(2027, 3, 8))).toBeUndefined();
    expect(holidayOn(d(2027, 3, 9))).toBe('easter');
    expect(holidayOn(d(2027, 3, 29))).toBe('easter');
    expect(holidayOn(d(2027, 3, 30))).toBeUndefined();
    // and late Easters in April
    expect(holidayOn(d(2038, 4, 26))).toBe('easter');
  });

  it('can be turned off, and its colours are only on the default theme with no colour of your own', () => {
    const xmas = d(2026, 12, 20);
    expect(holidayNow(look({}), xmas)).toBe('christmas');
    expect(holidayNow(look({ holidays: false }), xmas)).toBeUndefined();
    expect(holidayColours(look({}), xmas)).toBe('christmas');
    expect(holidayColours(look({ style: 'simple' }), xmas)).toBeUndefined();
    expect(holidayColours(look({ accent: '#6b3fa0' }), xmas)).toBeUndefined();
    expect(holidayColours(look({ bar: '#6b3fa0' }), xmas)).toBeUndefined();
    // Your own colours still get the opening.
    expect(holidayNow(look({ accent: '#6b3fa0' }), xmas)).toBe('christmas');
  });

  it('says hello for the holiday', () => {
    expect(holidayGreeting('christmas', 'Good morning')).toBe('Merry Christmas');
    expect(holidayGreeting('easter', 'Good morning')).toBe('Happy Easter');
    expect(holidayGreeting('newyear', 'Good evening')).toBe('Happy New Year');
    expect(holidayGreeting('australia', 'Good morning')).toBe('G’day');
    expect(holidayGreeting('halloween', 'Good evening')).toBe('Good evening');
    expect(holidayGreeting(undefined, 'Good afternoon')).toBe('Good afternoon');
  });

  it('0.18.0: one holiday off on its own; the others still show; Holiday themes off turns them all off', () => {
    const on = { look: { ...DEFAULT_SETTINGS.look, holidaysOff: ['christmas' as const] } };
    expect(holidayNow(on, d(2026, 12, 10))).toBeUndefined();
    expect(holidayNow(on, d(2026, 12, 30))).toBe('newyear');
    expect(holidayNow({ look: { ...on.look, holidays: false } }, d(2026, 12, 30))).toBeUndefined();
  });
});
