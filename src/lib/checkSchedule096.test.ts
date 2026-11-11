import { describe, expect, it } from 'vitest';
import fixtures from '../../tools/sync-test/schedule-fixtures.json';
import { checkDue, dailyTimes, latestSlot, nextCheckWords, nextSlot, nextWake, parseCheckTime, timeWords } from './checkSchedule';

interface Plan {
  name: string;
  zone: string;
  interval: number;
  time: string;
  weekday: number;
  now: string;
}
const plan = (c: Plan) => ({ intervalHours: c.interval, time: c.time, weekday: c.weekday });
const ms = (s: string | null) => (s === null ? undefined : Date.parse(s));
const iso = (n: number | undefined) => (n === undefined ? null : new Date(n).toISOString());
const same = (n: number | undefined, s: string | null) => expect(n === undefined ? null : n).toBe(s === null ? null : Date.parse(s));

// The same answers CheckSchedule.java gives (tools/sync-test/schedule-parity.sh).
describe('price check times shared with the phone (Java)', () => {
  for (const c of fixtures.cases) {
    it(c.name, () => {
      const now = Date.parse(c.now);
      same(nextSlot(plan(c), now, c.zone), c.next);
      same(latestSlot(plan(c), now, c.zone), c.latest);
      same(nextWake(plan(c), now, c.zone), c.wake);
    });
  }
  for (const c of fixtures.due) {
    it(`due: ${c.name}`, () => {
      expect(checkDue(plan(c), Date.parse(c.now), ms(c.served), c.zone)).toBe(c.due);
    });
  }
});

describe('set time of day', () => {
  const brisbane = 'Australia/Brisbane';
  it('is 5:00 am when no time is set or the time is not one', () => {
    expect(parseCheckTime(undefined)).toBe(300);
    expect(parseCheckTime('')).toBe(300);
    expect(parseCheckTime('5:00')).toBe(300);
    expect(parseCheckTime('24:00')).toBe(300);
    expect(parseCheckTime('13:45')).toBe(13 * 60 + 45);
  });

  it('a check at the set time or later does not move the next one (checking by hand is not a slot)', () => {
    const p = { intervalHours: 24 };
    const before = nextSlot(p, Date.parse('2026-11-10T22:00:00Z'), brisbane);
    // A manual check changes nothing in the schedule: the answer depends on the clock only.
    expect(nextSlot(p, Date.parse('2026-11-10T22:00:00Z'), brisbane)).toBe(before);
    expect(iso(before)).toBe('2026-11-11T19:00:00.000Z'); // 5:00 am Brisbane on the 12th
  });

  it('every 12 hours is the set time and 12 hours later', () => {
    const p = { intervalHours: 12, time: '05:00' };
    const a = nextSlot(p, Date.parse('2026-11-10T20:00:00Z'), brisbane); // 6 am Brisbane: next is 5 pm
    expect(new Date(a).toISOString()).toBe('2026-11-11T07:00:00.000Z');
    expect(new Date(nextSlot(p, a, brisbane)).toISOString()).toBe('2026-11-11T19:00:00.000Z');
  });

  it('the phone being off through a time: one check when it is back, not one per missed time', () => {
    const p = { intervalHours: 6 };
    const slotNow = latestSlot(p, Date.parse('2026-11-12T03:00:00Z'), brisbane)!;
    expect(checkDue(p, Date.parse('2026-11-12T03:00:00Z'), Date.parse('2026-11-08T00:00:00Z'), brisbane)).toBe(true);
    // Once it was run for the latest time, asking again (even a minute later) says no.
    expect(checkDue(p, Date.parse('2026-11-12T03:01:00Z'), slotNow, brisbane)).toBe(false);
  });

  it('a time zone change moves the times with the phone (5:00 am where it is now)', () => {
    const p = { intervalHours: 24 };
    const now = Date.parse('2026-11-10T20:00:00Z');
    expect(iso(nextSlot(p, now, 'Australia/Melbourne'))).toBe('2026-11-11T18:00:00.000Z');
    expect(iso(nextSlot(p, now, 'Australia/Perth'))).toBe('2026-11-10T21:00:00.000Z');
  });

  it('the time of day after clocks go forward and back stays the same on the wall clock', () => {
    const p = { intervalHours: 24, time: '05:00' };
    const z = 'Australia/Melbourne';
    const before = nextSlot(p, Date.parse('2026-10-02T20:00:00Z'), z); // 6 am on the 3rd -> the 4th, 5:00 am AEDT
    expect(iso(before)).toBe('2026-10-03T18:00:00.000Z');
    expect(iso(nextSlot(p, Date.parse('2027-04-03T10:00:00Z'), z))).toBe('2027-04-03T19:00:00.000Z');
  });

  it('weekly checks wake every day (so the catalogue day summary can go out) but check on the chosen day', () => {
    const p = { intervalHours: 168, time: '05:00', weekday: 3 };
    const now = Date.parse('2026-11-11T22:00:00Z'); // Thursday 8 am in Brisbane
    expect(iso(nextWake(p, now, brisbane))).toBe('2026-11-12T19:00:00.000Z');
    expect(iso(nextSlot(p, now, brisbane))).toBe('2026-11-17T19:00:00.000Z');
  });

  it('says it in words', () => {
    expect(timeWords('05:00')).toBe('5:00 am');
    expect(timeWords('17:05')).toBe('5:05 pm');
    expect(timeWords('00:30')).toBe('12:30 am');
    expect(timeWords('12:00')).toBe('12:00 pm');
    expect(dailyTimes({ intervalHours: 12, time: '05:00' })).toEqual(['5:00 am', '5:00 pm']);
    expect(dailyTimes({ intervalHours: 6, time: '05:00' })).toEqual(['5:00 am', '11:00 am', '5:00 pm', '11:00 pm']);
    expect(dailyTimes({ intervalHours: 24, time: '07:15' })).toEqual(['7:15 am']);
    const now = Date.parse('2026-11-10T12:00:00Z'); // 10 pm Brisbane
    expect(nextCheckWords({ intervalHours: 24 }, now, brisbane)).toBe('tomorrow 5:00 am');
    expect(nextCheckWords({ intervalHours: 24 }, Date.parse('2026-11-10T15:00:00Z'), brisbane)).toBe('today 5:00 am'); // 1 am
    expect(nextCheckWords({ intervalHours: 12 }, Date.parse('2026-11-10T22:00:00Z'), brisbane)).toBe('today 5:00 pm'); // 8 am
    expect(nextCheckWords({ intervalHours: 168, weekday: 3 }, Date.parse('2026-11-10T22:00:00Z'), brisbane)).toBe('Wednesday 5:00 am');
  });
});
