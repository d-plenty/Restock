// 0.16.0: the holidays. On a holiday Restock opens with that holiday's animation (Opening.tsx) and,
// on the default theme, wears its colours (tokens.css [data-holiday]) with a little decoration in
// Home's top bar. Then everything goes back to normal by itself. On unless turned off in Settings →
// Look and colours (look.holidays); someone who picked their own colours keeps them, and only gets
// the opening.
//
//   Christmas      1–26 December
//   New Year       27 December – 1 January
//   Australia Day  19–27 January (0.18.0: the week leading up to it; 2–27 January before)
//   Easter         the three weeks up to Easter Monday (it moves: late March to late April)
//   Halloween      the three weeks up to Halloween, 11 October – 1 November
// 0.17.0: each ends the day after (Boxing Day, New Year's Day, the 27th, Easter Monday, 1 November).
import type { Settings } from '../types';

export type Holiday = 'christmas' | 'newyear' | 'australia' | 'easter' | 'halloween';

export const HOLIDAY_NAMES: Record<Holiday, string> = {
  christmas: 'Christmas',
  newyear: 'New Year',
  halloween: 'Halloween',
  easter: 'Easter',
  australia: 'Australia Day',
};

/** 0.18.0: in the order they come in the year (Look and colours lists them so, each with its own switch). */
export const HOLIDAY_ORDER: Holiday[] = ['newyear', 'australia', 'easter', 'halloween', 'christmas'];

/** When each one shows (See the animations and the switches say it). */
export const HOLIDAY_WHEN: Record<Holiday, string> = {
  christmas: '1–26 December',
  newyear: '27 December – 1 January',
  australia: '19–27 January',
  easter: 'The three weeks up to Easter Monday',
  halloween: '11 October – 1 November',
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
  if ((m === 10 && day >= 11) || (m === 11 && day === 1)) return 'halloween';
  // 0.18.0: Australia Day is the week leading up to it, to the day after (19–27 January).
  if (m === 1 && day >= 19 && day <= 27) return 'australia';
  const e = easterSunday(d.getFullYear());
  const sunday = new Date(d.getFullYear(), e.month - 1, e.day);
  const monday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 1);
  const from = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 20);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (today >= from && today <= monday) return 'easter';
  return undefined;
}

type Look = Pick<Settings, 'look'>;

/** Holidays switched on (they are unless turned off). */
const holidaysOn = (s: Look | undefined): boolean => s?.look.holidays !== false;

/** 0.18.0: one holiday switched off on its own (Look and colours), the others still on. */
const holidayOff = (s: Look | undefined, h: Holiday): boolean => !!s?.look.holidaysOff?.includes(h);

/** The holiday showing now: its opening animation. */
export const holidayNow = (s: Look | undefined, d = new Date()): Holiday | undefined => {
  if (!holidaysOn(s)) return undefined;
  const h = holidayOn(d);
  return h && !holidayOff(s, h) ? h : undefined;
};

/** On the default theme (navy, gold and green, no colour of its own picked, accent or theme): the holiday's colours too. */
export const holidayColours = (s: Look | undefined, d = new Date()): Holiday | undefined =>
  s && s.look.style === 'australia' && !s.look.accent && !s.look.bar ? holidayNow(s, d) : undefined;

/** Home's hello on the holiday ("Merry Christmas"), or the time of day's. */
export function holidayGreeting(h: Holiday | undefined, timeOfDay: string): string {
  if (h === 'christmas') return 'Merry Christmas';
  if (h === 'easter') return 'Happy Easter';
  if (h === 'newyear') return 'Happy New Year';
  if (h === 'australia') return 'G’day';
  return timeOfDay;
}
