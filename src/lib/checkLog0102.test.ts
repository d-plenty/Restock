import { describe, expect, it } from 'vitest';
import { missedSlot, missedWords, whenWords, type CheckRun } from './checkLog';

const Z = 'Australia/Brisbane';
// Friday 13 November 2026, 10:35 am in Brisbane.
const NOW = Date.parse('2026-11-13T00:35:00Z');
const daily5pm = { intervalHours: 24, time: '17:00' };

describe("the background checks' log (0.10.2)", () => {
  it('says when, in words', () => {
    process.env.TZ = Z;
    expect(whenWords('2026-11-13T00:02:00Z', NOW)).toBe('today 10:02 am');
    expect(whenWords('2026-11-12T07:02:00Z', NOW)).toBe('yesterday 5:02 pm');
    expect(whenWords('2026-11-11T07:02:00Z', NOW)).toBe('Wednesday 5:02 pm');
    expect(whenWords('2026-11-03T07:02:00Z', NOW)).toBe('3 Nov 5:02 pm');
  });

  it("finds Thursday's 5 pm check that never ran", () => {
    process.env.TZ = Z;
    const slot = missedSlot(daily5pm, '2026-11-11T07:02:00Z', [], NOW, Z);
    expect(slot).toBe(Date.parse('2026-11-12T07:00:00Z'));
    expect(missedWords(slot!, [], NOW)).toBe("Yesterday's 5 pm check didn't run");
    const stopped: CheckRun[] = [{ slot: '2026-11-12T07:00:00Z', start: '2026-11-12T07:03:00Z', outcome: 'stopped' }];
    expect(missedWords(missedSlot(daily5pm, '2026-11-11T07:02:00Z', stopped, NOW, Z)!, stopped, NOW)).toBe("Yesterday's 5 pm check stopped part way");
  });

  it('is fine when it ran, when you checked since, or with every 2 days', () => {
    process.env.TZ = Z;
    const done: CheckRun[] = [{ slot: '2026-11-12T07:00:00Z', start: '2026-11-12T07:04:00Z', outcome: 'done' }];
    expect(missedSlot(daily5pm, '2026-11-11T07:02:00Z', done, NOW, Z)).toBeUndefined();
    expect(missedSlot(daily5pm, '2026-11-12T22:00:00Z', [], NOW, Z)).toBeUndefined();
    // Every 2 days at 5 pm: Wednesday's was the last one due, and it ran.
    const every2 = { intervalHours: 48, time: '17:00' };
    const last = missedSlot(every2, '2026-11-11T07:02:00Z', [], NOW, Z);
    expect(last === undefined || last <= Date.parse('2026-11-11T07:00:00Z') + 1).toBe(true);
  });

  it('gives a late check an hour', () => {
    process.env.TZ = Z;
    expect(missedSlot(daily5pm, '2026-11-11T07:02:00Z', [], Date.parse('2026-11-12T07:30:00Z'), Z)).toBeUndefined();
  });
});
