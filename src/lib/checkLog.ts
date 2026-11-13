import { latestSlot, type CheckPlan } from './checkSchedule';
import { getKV } from './db';

// 0.10.2: what the background price checks did. PriceCheckWorker.java notes each scheduled check in
// the "checkLog" store entry (this phone's only), newest first:
//   { runs: [{ slot, start, end?, outcome: running | done | stopped | failed | app, checked?, updated?, errors? }] }
// A set time with no entry never ran: Android held it back (battery settings), or there was no
// connection or the battery was low when it was due.

export interface CheckRun {
  slot: string;
  start: string;
  end?: string;
  outcome: 'running' | 'done' | 'stopped' | 'failed' | 'app';
  checked?: number;
  updated?: number;
  errors?: number;
}

export const getCheckLog = async (): Promise<CheckRun[]> => (await getKV<{ runs?: CheckRun[] }>('checkLog'))?.runs ?? [];

export const OUTCOME_WORDS: Record<CheckRun['outcome'], string> = {
  running: 'started, still going (or the phone was turned off)',
  done: 'done',
  stopped: "stopped part way: Android's time for it ran out",
  failed: "didn't finish: something went wrong",
  app: 'Restock had just checked, so that counted',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const clock = (d: Date) => d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s?([ap])\.?m\.?/i, ' $1m').toLowerCase();
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "today 5:02 pm", "yesterday 5:02 pm", "Wednesday 5:02 pm", or "3 Nov 5:02 pm" (over a week ago). */
export function whenWords(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  const days = Math.round((dayStart(new Date(now)) - dayStart(d)) / 86_400_000);
  const t = clock(d);
  if (days <= 0) return `today ${t}`;
  if (days === 1) return `yesterday ${t}`;
  if (days < 7) return `${WEEKDAYS[d.getDay()]} ${t}`;
  return `${d.getDate()} ${d.toLocaleString('en-AU', { month: 'short' })} ${t}`;
}

/**
 * The last set time that came and went without a check finishing for it, or undefined. A check
 * gets an hour's grace (Android runs them a little late), and one finished since the set time (a
 * Check now, or opening Restock) counts.
 */
export function missedSlot(plan: CheckPlan, lastCheck: string | undefined, runs: CheckRun[], now = Date.now(), zone?: string): number | undefined {
  const slot = latestSlot(plan, now, zone);
  if (slot === undefined || now - slot < 60 * 60_000) return undefined;
  const last = lastCheck ? Date.parse(lastCheck) : NaN;
  if (Number.isFinite(last) && last >= slot - 30 * 60_000) return undefined;
  const r = runs.find((x) => Math.abs(Date.parse(x.slot) - slot) < 60_000);
  if (r && (r.outcome === 'done' || r.outcome === 'app')) return undefined;
  return slot;
}

/** "Thursday's 5 pm check didn't run" (or "stopped part way"), for the Home screen. */
export function missedWords(slot: number, runs: CheckRun[], now = Date.now()): string {
  const d = new Date(slot);
  const days = Math.round((dayStart(new Date(now)) - dayStart(d)) / 86_400_000);
  const day = days <= 0 ? "Today's" : days === 1 ? "Yesterday's" : `${WEEKDAYS[d.getDay()]}'s`;
  const t = clock(d).replace(':00', '');
  const r = runs.find((x) => Math.abs(Date.parse(x.slot) - slot) < 60_000);
  return `${day} ${t} check ${r?.outcome === 'stopped' ? 'stopped part way' : r?.outcome === 'failed' ? "didn't finish" : "didn't run"}`;
}
