// 0.9.5: the Data tab's numbers, worked out for the charts and words (no React, no server): nice
// axis steps, bar and line geometry, month labels, the cheapest price each specials week, how often
// something goes on special, sizes in words, and the storage bar's parts.
import type { DataSeries, DataSummary, Period } from './houseData';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A step for an axis: 1, 2, 2.5 or 5 times a power of ten, so about `ticks` lines cover `span`. */
export function niceStep(span: number, ticks = 4): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, ticks);
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return m * p;
}

/** An axis from below `min` to above `max` on nice steps (min 0 for bars). */
export function niceScale(min: number, max: number, ticks = 4): { min: number; max: number; step: number; ticks: number[] } {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 0;
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) {
    hi = lo === 0 ? 1 : hi * 1.1;
    lo = lo === 0 ? 0 : lo * 0.9;
  }
  const step = niceStep(hi - lo, ticks);
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = a; v <= b + step / 1e6 && out.length < 50; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return { min: a, max: b, step, ticks: out };
}

export interface Box {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Where a value sits on the y axis (pixels from the top), within the box. */
export const yOf = (v: number, s: { min: number; max: number }, box: Box) => {
  const h = box.height - box.top - box.bottom;
  const t = s.max === s.min ? 0 : (v - s.min) / (s.max - s.min);
  return box.top + h - Math.max(0, Math.min(1, t)) * h;
};

/** Bars for these values: an x, width, y and height each, on a scale from 0. */
export function barLayout(values: number[], box: Box, gapRatio = 0.3) {
  const s = niceScale(0, Math.max(0, ...values.map((v) => (Number.isFinite(v) ? v : 0))));
  const n = Math.max(1, values.length);
  const inner = box.width - box.left - box.right;
  const slot = inner / n;
  const w = Math.max(2, slot * (1 - gapRatio));
  const base = yOf(0, s, box);
  const bars = values.map((v, i) => {
    const x = box.left + i * slot + (slot - w) / 2;
    const y = yOf(Math.max(0, v || 0), s, box);
    return { x, y, w, h: Math.max(0, base - y), cx: x + w / 2 };
  });
  return { scale: s, bars, base, slot };
}

/** x positions spread evenly across the box for n points. */
export function xsOf(n: number, box: Box): number[] {
  const inner = box.width - box.left - box.right;
  if (n <= 1) return [box.left + inner / 2];
  return Array.from({ length: n }, (_, i) => box.left + (i * inner) / (n - 1));
}

/** "Nov", with the year on January and on the first one ("Nov 2025"). */
export function monthLabel(month: string, first = false): string {
  const [y, m] = month.split('-').map(Number);
  const name = MONTHS[(m || 1) - 1] ?? month;
  return first || m === 1 ? `${name} ${y}` : name;
}
export function longMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${LONG_MONTHS[(m || 1) - 1] ?? month} ${y}`;
}
/** "Nov 2024" for a date. */
export function monthYear(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
/** "10 Nov 2025". */
export function dayMonthYear(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Which month labels to show so they don't crowd: every one up to 12, else about 8 spread out. */
export function labelEvery(n: number, room = 12): number {
  return n <= room ? 1 : Math.ceil(n / Math.max(2, Math.round(room * 0.66)));
}

/** The month this is ("2026-11"), here. */
export function thisMonth(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * About how much a month: the months from the first one with anything ticked, leaving this month
 * out while it's still going (unless it's the only one). Undefined with nothing ticked.
 */
export function perMonth(months: { month: string; total: number; count: number }[], now = Date.now()): number | undefined {
  const from = months.findIndex((m) => m.count > 0);
  if (from < 0) return undefined;
  let use = months.slice(from);
  const cur = thisMonth(now);
  if (use.length > 1 && use[use.length - 1].month === cur) use = use.slice(0, -1);
  return use.reduce((s, m) => s + m.total, 0) / use.length;
}

/** "$7,076" (no cents from $1,000), "$842.50" below. */
export function moneyShort(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  const a = Math.abs(n);
  const s = a >= 1000 ? Math.round(a).toLocaleString('en-AU') : a >= 100 ? String(Math.round(a)) : a.toFixed(2).replace(/\.00$/, '');
  return `${n < 0 ? '-' : ''}$${s}`;
}
/** An axis label: "$500", "$1.5k". With `cents` (0.9.5: when any line of the axis has cents), every
 *  label under $1,000 shows them, so the axis reads $4.00, $4.50, $5.00 rather than $4, $4.50, $5. */
export function moneyAxis(n: number, cents = false): string {
  if (n >= 10000) return `$${Math.round(n / 1000)}k`;
  if (n >= 1000) return `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return Number.isInteger(n) && !cents ? `$${n}` : `$${n.toFixed(2)}`;
}
/** Whether an axis needs cents: any of its lines under $1,000 isn't whole dollars. */
export const axisCents = (ticks: number[]): boolean => ticks.some((t) => t < 1000 && !Number.isInteger(Math.round(t * 100) / 100));

/** 186 MB, 412 GB, 820 KB (powers of 1024, as the disk tools say). */
export function bytesText(n: number | null | undefined): string {
  if (!n || !Number.isFinite(n) || n < 0) return '0 KB';
  // Under a kilobyte reads as 1 KB (bytes are too fine to matter here).
  if (n < 1024) return '1 KB';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** The cheapest price each specials week, over the item's shops, and whether that one was on special. */
export function cheapestByWeek(weeks: DataSeries['weeks']): { week: string; price: number; special: boolean; chain: string }[] {
  const by = new Map<string, { week: string; price: number; special: boolean; chain: string }>();
  for (const w of weeks) {
    if (!Number.isFinite(w.price)) continue;
    const had = by.get(w.week);
    if (!had || w.price < had.price || (w.price === had.price && w.special && !had.special)) by.set(w.week, { week: w.week, price: w.price, special: !!w.special, chain: w.chain });
  }
  return [...by.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/**
 * How often it's gone on special: the gap between the starts of its runs of special weeks, on
 * average, in words ("about every 4 months"). Undefined with fewer than two runs.
 */
export function specialEvery(points: { week: string; special: boolean }[]): string | undefined {
  const starts: number[] = [];
  let prev = false;
  for (const p of points) {
    if (p.special && !prev) starts.push(Date.parse(`${p.week}T00:00:00`));
    prev = p.special;
  }
  if (starts.length < 2) return undefined;
  const days = (starts[starts.length - 1] - starts[0]) / 86_400_000 / (starts.length - 1);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  if (days < 10) return 'about every week';
  if (days < 45) {
    const w = Math.round(days / 7);
    return w <= 1 ? 'about every week' : `about every ${w} weeks`;
  }
  const m = Math.round(days / 30.4);
  return m <= 1 ? 'about every month' : `about every ${m} months`;
}

export interface Part {
  key: string;
  label: string;
  bytes: number;
  /** Its share of the bar, 0–100 (at least a sliver when it has anything). */
  pct: number;
}

/** The storage bar: each kind, then what isn't a kind, biggest first; shares add up to 100. */
export function storageParts(s: Pick<DataSummary, 'kinds' | 'other'>, names: Record<string, string>): Part[] {
  const raw: { key: string; label: string; bytes: number }[] = [
    ...Object.entries(s.kinds).map(([key, k]) => ({ key, label: names[key] ?? key, bytes: Math.max(0, k.bytes || 0) })),
    { key: 'other', label: 'Sync and other', bytes: Math.max(0, s.other || 0) },
  ];
  const total = raw.reduce((a, p) => a + p.bytes, 0);
  const parts = raw
    .sort((a, b) => b.bytes - a.bytes)
    .map((p) => ({ ...p, pct: total ? (p.bytes / total) * 100 : 0 }))
    // A kind with anything in it stays visible, as a sliver.
    .map((p) => ({ ...p, pct: p.bytes > 0 ? Math.max(1, p.pct) : 0 }));
  const sum = parts.reduce((a, p) => a + p.pct, 0);
  return sum > 0 ? parts.map((p) => ({ ...p, pct: (p.pct / sum) * 100 })) : parts;
}

/** Whole-number shares (largest remainder), so they add up to exactly 100. */
export function shares(values: number[]): number[] {
  const total = values.reduce((a, v) => a + Math.max(0, v), 0);
  if (!total) return values.map(() => 0);
  const exact = values.map((v) => (Math.max(0, v) / total) * 100);
  const floor = exact.map(Math.floor);
  let left = 100 - floor.reduce((a, v) => a + v, 0);
  const order = exact.map((v, i) => [v - floor[i], i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floor[i]++;
    left--;
  }
  return floor;
}

/** A period from what was saved ("3", "6", "12", "all"), else 12 months. */
export function readPeriod(v: unknown): Period {
  return v === '3' || v === 3 ? 3 : v === '6' || v === 6 ? 6 : v === 'all' ? 'all' : 12;
}
/** The words for a period, for headings and screen readers ("the last 6 months"). */
export const periodWords = (p: Period) => (p === 'all' ? 'all the time there is' : `the last ${p} months`);
