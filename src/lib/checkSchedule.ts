// 0.9.6: when price checks run. At a set time of day on the phone's own clock (default 5:00 am),
// not "every N hours from the last check". CheckSchedule.java is the phone's twin: change both
// together (tools/sync-test/schedule-fixtures.json holds the shared answers, and both test suites
// read it).
//
// A "slot" is one scheduled moment. Every 6 or 12 hours is the set time and every 6 or 12 hours from
// it, all day. Once a day is the set time. Every 2 days is the set time on every second calendar day.
// Once a week is the set time on the chosen weekday. Slots are wall-clock times in the phone's time
// zone, so a daylight saving change keeps 5:00 am at 5:00 am. A time that doesn't exist on a day the
// clocks go forward (2:30 am) is run later by the length of the gap; one that happens twice is run
// the first time. A manual "Check now" is never a slot and never moves the schedule.

export const DEFAULT_CHECK_TIME = '05:00';

export interface CheckPlan {
  /** 6, 12, 24, 48 or 168 (weekly). Anything else is treated as once a day. */
  intervalHours: number;
  /** "HH:MM", 24 hour. Anything else is 5:00 am. */
  time?: string;
  /** 0 = Sunday. Only used when checking weekly. */
  weekday?: number;
}

const DAY = 86_400_000;

/** "05:00" to minutes after midnight; 5:00 am when it isn't a time. */
export function parseCheckTime(t: string | undefined): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : 5 * 60;
}

export const isCheckTime = (t: unknown): t is string => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

const intervalOf = (h: number) => (h === 6 || h === 12 || h === 48 || h === 168 ? h : 24);

/** Minutes after midnight of the check slots on a day that has checks. */
function minutesInDay(plan: CheckPlan): number[] {
  const minute = parseCheckTime(plan.time);
  const h = intervalOf(plan.intervalHours);
  if (h === 6 || h === 12) {
    const out: number[] = [];
    for (let m = minute % (h * 60); m < 1440; m += h * 60) out.push(m);
    return out;
  }
  return [minute];
}

interface Day {
  y: number;
  m: number; // 1-12
  d: number;
}

const epochDay = ({ y, m, d }: Day) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
const dayFromEpoch = (n: number): Day => {
  const t = new Date(n * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, zone: string | undefined): { day: Day; minute: number; weekday: number } {
  const key = zone ?? '';
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    fmtCache.set(key, f);
  }
  const v: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') v[p.type] = Number(p.value);
  const day = { y: v.year, m: v.month, d: v.day };
  return { day, minute: v.hour * 60 + v.minute, weekday: (epochDay(day) + 4) % 7 };
}

/** The zone's offset from UTC at an instant, in ms. */
const offsetAt = (ms: number, zone: string | undefined): number => {
  const p = parts(ms, zone);
  return Date.UTC(p.day.y, p.day.m - 1, p.day.d, 0, p.minute) - Math.floor(ms / 60_000) * 60_000;
};

/** A wall-clock time in a zone, as an instant (ms). See the file's top for gaps and repeats. */
function wallToInstant(day: Day, minute: number, zone: string | undefined): number {
  const guess = Date.UTC(day.y, day.m - 1, day.d, 0, minute);
  const offBefore = offsetAt(guess - DAY, zone);
  const offAfter = offsetAt(guess + DAY, zone);
  const valid = [guess - offBefore, guess - offAfter].filter((t) => offsetAt(t, zone) === guess - t);
  if (valid.length) return Math.min(...valid);
  return guess - offBefore; // in a gap: later by the length of the gap
}

const localDayOf = (ms: number, zone: string | undefined) => parts(ms, zone).day;

function checksOn(plan: CheckPlan, day: Day): boolean {
  const h = intervalOf(plan.intervalHours);
  if (h === 48) return epochDay(day) % 2 === 0;
  if (h === 168) return (epochDay(day) + 4) % 7 === (plan.weekday ?? 3);
  return true;
}

/** Check slots on a day (ms), in order. */
function slotsOn(plan: CheckPlan, day: Day, zone: string | undefined): number[] {
  return checksOn(plan, day) ? minutesInDay(plan).map((m) => wallToInstant(day, m, zone)) : [];
}

/** The first check slot after `after` (ms). `zone` is an IANA name; the device's own when left out. */
export function nextSlot(plan: CheckPlan, after: number, zone?: string): number {
  const start = epochDay(localDayOf(after, zone)) - 1;
  for (let i = 0; i < 20; i++) {
    for (const s of slotsOn(plan, dayFromEpoch(start + i), zone)) if (s > after) return s;
  }
  return after + DAY;
}

/** The latest check slot at or before `now` (ms), or undefined. */
export function latestSlot(plan: CheckPlan, now: number, zone?: string): number | undefined {
  const start = epochDay(localDayOf(now, zone)) + 1;
  for (let i = 0; i < 20; i++) {
    const s = slotsOn(plan, dayFromEpoch(start - i), zone);
    for (let k = s.length - 1; k >= 0; k--) if (s[k] <= now) return s[k];
  }
  return undefined;
}

/**
 * When the background job wakes next: the next slot, except weekly checks wake every day so the
 * catalogue day summary can still go out on the days nothing is checked.
 */
export function nextWake(plan: CheckPlan, after: number, zone?: string): number {
  if (intervalOf(plan.intervalHours) !== 168) return nextSlot(plan, after, zone);
  const day = epochDay(localDayOf(after, zone));
  const today = wallToInstant(dayFromEpoch(day), parseCheckTime(plan.time), zone);
  return today > after ? today : wallToInstant(dayFromEpoch(day + 1), parseCheckTime(plan.time), zone);
}

/**
 * Is a check owed? The latest slot has passed and no check was run for it (`served`: the slot the
 * last scheduled check was run for). Once per slot, however many times this is asked, and a manual
 * "Check now" never changes the answer.
 */
export function checkDue(plan: CheckPlan, now: number, served: number | undefined, zone?: string): boolean {
  const latest = latestSlot(plan, now, zone);
  return latest !== undefined && (served === undefined || served < latest);
}

/** "5:00 am", "5:00 pm", "12:30 am". */
export function timeWords(time: string | undefined): string {
  const m = parseCheckTime(time);
  const h = Math.floor(m / 60);
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** The other times of day a check runs when checking every 6 or 12 hours ("5:00 am, 11:00 am, ..."). */
export function dailyTimes(plan: CheckPlan): string[] {
  const h = intervalOf(plan.intervalHours);
  return (h === 6 || h === 12 ? minutesInDay(plan) : [parseCheckTime(plan.time)]).map((m) => timeWords(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`));
}

/** When the next check runs, in words ("today 5:00 am", "tomorrow 5:00 am", "Wednesday 5:00 am"). */
export function nextCheckWords(plan: CheckPlan, now = Date.now(), zone?: string): string {
  const at = nextSlot(plan, now, zone);
  const p = parts(at, zone);
  const today = epochDay(localDayOf(now, zone));
  const diff = epochDay(p.day) - today;
  const time = timeWords(`${String(Math.floor(p.minute / 60)).padStart(2, '0')}:${String(p.minute % 60).padStart(2, '0')}`);
  if (diff <= 0) return `${p.minute >= 18 * 60 ? 'tonight' : 'today'} ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  const name = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][p.weekday];
  return `${name} ${time}`;
}
