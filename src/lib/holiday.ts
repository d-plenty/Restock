// 0.16.0: the holidays. On a holiday Restock opens with that holiday's animation (Opening.tsx) and,
// on the default theme, wears its colours (tokens.css [data-holiday]) with a little decoration in
// Home's top bar. Then everything goes back to normal by itself. On unless turned off in Settings →
// Look and colours (look.holidays); someone who picked their own colours keeps them, and only gets
// the opening.
//
//   Christmas      1–26 December
//   New Year       27 December – 1 January
//   Australia Day  2–31 January
//   Easter         the two weeks up to Easter Monday (it moves: late March to late April)
//   Halloween      all of October
import type { Settings } from '../types';

export type Holiday = 'christmas' | 'newyear' | 'australia' | 'easter' | 'halloween';

export const HOLIDAY_NAMES: Record<Holiday, string> = {
  christmas: 'Christmas',
  newyear: 'New Year',
  halloween: 'Halloween',
  easter: 'Easter',
  australia: 'Australia Day',
};

/** Easter Sunday in a year (the Gregorian calendar's rule: Meeus/Jones/Butcher). Month is 1–12. */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** The holiday on this day (the phone's own calendar), if there is one. */
export function holidayOn(d = new Date()): Holiday | undefined {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if ((m === 12 && day >= 27) || (m === 1 && day === 1)) return 'newyear';
  if (m === 12) return 'christmas';
  if (m === 10) return 'halloween';
  if (m === 1) return 'australia';
  const e = easterSunday(d.getFullYear());
  const sunday = new Date(d.getFullYear(), e.month - 1, e.day);
  const monday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 1);
  const from = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 13);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (today >= from && today <= monday) return 'easter';
  return undefined;
}

type Look = Pick<Settings, 'look'>;

/** Holidays switched on (they are unless turned off). */
export const holidaysOn = (s: Look | undefined): boolean => s?.look.holidays !== false;

/** The holiday showing now: its opening animation. */
export const holidayNow = (s: Look | undefined, d = new Date()): Holiday | undefined => (holidaysOn(s) ? holidayOn(d) : undefined);

/** On the default theme (navy, gold and green, no colour of its own picked): the holiday's colours too. */
export const holidayColours = (s: Look | undefined, d = new Date()): Holiday | undefined =>
  s && s.look.style !== 'plain' && !s.look.accent ? holidayNow(s, d) : undefined;

/** Home's hello on the holiday ("Merry Christmas"), or the time of day's. */
export function holidayGreeting(h: Holiday | undefined, timeOfDay: string): string {
  if (h === 'christmas') return 'Merry Christmas';
  if (h === 'easter') return 'Happy Easter';
  if (h === 'newyear') return 'Happy New Year';
  if (h === 'australia') return 'G’day';
  return timeOfDay;
}
