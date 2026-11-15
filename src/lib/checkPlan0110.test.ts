import { describe, expect, it } from 'vitest';
import { checkChoice, checkDue, dayWords, nextCheckWords, nextSlot, planOf, presetDays } from './checkSchedule';
import { checkSettings } from './settingsCheck';

const Z = 'Australia/Brisbane';

describe('0.11.0: automatic price checks on set days', () => {
  it('moves a phone from 0.10.x to Wednesday and Saturday at 4:00 am once, on or off', () => {
    const was = checkSettings({ checkIntervalHours: 12, checkTime: '05:00', sync: { backgroundActivity: false } });
    expect(was.checkDays).toEqual([3, 6]);
    expect(was.checkTime).toBe('04:00');
    expect(was.sync.backgroundActivity).toBe(true);
    expect(was.checkMoved0110).toBe(true);
  });
  it('after the move, the phone’s own choice stays', () => {
    const s = checkSettings({ checkMoved0110: true, checkDays: [1, 5, 5, 9, 'x'], checkTime: '21:30', checkCustom: true, sync: { backgroundActivity: false } });
    expect(s.checkDays).toEqual([1, 5]);
    expect(s.checkTime).toBe('21:30');
    expect(s.checkCustom).toBe(true);
    expect(s.sync.backgroundActivity).toBe(false);
    expect(checkSettings({ checkMoved0110: true, checkDays: [] }).checkDays).toEqual([]);
  });
  it('names the five choices', () => {
    expect(checkChoice(presetDays('daily'), '04:00')).toBe('daily');
    expect(checkChoice([3, 6], '04:00')).toBe('twice');
    expect(checkChoice([3], '04:00')).toBe('weekly');
    expect(checkChoice([], '04:00')).toBe('off');
    expect(checkChoice([3, 6], '04:00', true)).toBe('custom');
    expect(checkChoice([3, 6], '06:00')).toBe('custom');
    expect(checkChoice([1, 2], '04:00')).toBe('custom');
    expect(checkChoice(undefined, undefined)).toBe('custom'); // no time means 5:00 am: not a preset
  });
  it('says the days Monday first', () => {
    expect(dayWords([3, 6])).toBe('Wednesday and Saturday');
    expect(dayWords([0, 1, 2, 5])).toBe('Monday, Tuesday, Friday and Sunday');
    expect(dayWords([0, 1, 2, 3, 4, 5, 6])).toBe('every day');
    expect(dayWords([3])).toBe('Wednesday');
  });
  it('off is never due and has no next time', () => {
    const plan = planOf({ checkIntervalHours: 24, checkTime: '04:00', checkDays: [] });
    expect(checkDue(plan, Date.parse('2026-11-21T02:00:00Z'), undefined, Z)).toBe(false);
    expect(nextCheckWords(plan, Date.parse('2026-11-21T02:00:00Z'), Z)).toBe('off');
  });
  it('twice a week: Sunday’s next check is Wednesday 4:00 am', () => {
    const plan = planOf({ checkIntervalHours: 24, checkTime: '04:00', checkDays: [3, 6] });
    const now = Date.parse('2026-11-15T05:00:00Z'); // Sunday 3:00 pm in Brisbane
    expect(new Date(nextSlot(plan, now, Z)).toISOString()).toBe('2026-11-17T18:00:00.000Z');
    expect(nextCheckWords(plan, now, Z)).toBe('Wednesday 4:00 am');
  });
  it('a settings file from before 0.11.0 (no days) still reads as its old plan', () => {
    expect(planOf({ checkIntervalHours: 168, checkTime: '05:00', checkWeekday: 3 }).days).toBeUndefined();
  });
});
