// 0.9.5: the two checks before the Data tab deletes anything (no React): the steps themselves (Step 1
// says what goes and what stays; Step 2 wants the typed word and the passphrase), and the words of
// Step 1 from the server's summary. The server checks both again: this only keeps the page honest.
import type { DataKind, DataSummary, Deleted } from './houseData';
import { bytesText, dayMonthYear, monthYear } from './dataCharts';

export interface Steps {
  step: 1 | 2;
  typed: string;
  pass: string;
  busy: boolean;
  error?: string;
}

export type StepAction =
  { t: 'continue' } | { t: 'back' } | { t: 'typed'; v: string } | { t: 'pass'; v: string } | { t: 'start'; word: string } | { t: 'fail'; error: string } | { t: 'finished' };

export const firstStep = (): Steps => ({ step: 1, typed: '', pass: '', busy: false });

/** The word typed matches (spaces around it don't count; capitals do). */
export const wordMatches = (typed: string, word: string) => typed.trim() === word;

/** Step 2, the word typed, a passphrase, and not already going. */
export const canDelete = (s: Steps, word: string) => s.step === 2 && !s.busy && wordMatches(s.typed, word) && s.pass.length > 0;

/**
 * The steps move: Continue from Step 1 only; Back from Step 2 (what was typed stays); Delete only
 * from Step 2 once canDelete; a refusal keeps what was typed so it can be fixed.
 */
export function stepReducer(s: Steps, a: StepAction): Steps {
  switch (a.t) {
    case 'continue':
      return s.step === 1 && !s.busy ? { ...s, step: 2, error: undefined } : s;
    case 'back':
      return s.step === 2 && !s.busy ? { ...s, step: 1, error: undefined } : s;
    case 'typed':
      return s.busy ? s : { ...s, typed: a.v.slice(0, 40), error: undefined };
    case 'pass':
      return s.busy ? s : { ...s, pass: a.v.slice(0, 1024), error: undefined };
    case 'start':
      return canDelete(s, a.word) ? { ...s, busy: true, error: undefined } : s;
    case 'fail':
      return { ...s, busy: false, error: a.error };
    case 'finished':
      return { ...firstStep() };
    default:
      return s;
  }
}

const n = (v: number) => v.toLocaleString('en-AU');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

export interface StepOne {
  /** What goes, a line each. */
  goes: string[];
  /** Kinds with nothing that old (so nothing of them goes). */
  none: string[];
  /** About how much space it frees, when the whole of each kind goes. */
  bytes?: number;
}

/**
 * What Step 1 lists for deleting these kinds (`before` null: all of them). With all of a kind the
 * counts are exact (each product keeps its newest price; pinned receipts stay). With a date, the
 * summary can't say how many are older, so it says what's there now and how old the oldest is;
 * a kind whose oldest is newer than the date loses nothing, and says so.
 */
export function stepOne(s: DataSummary, kinds: DataKind[], before: string | null, exact?: Deleted | null): StepOne {
  if (exact) return exactStepOne(s, kinds, before, exact);
  const goes: string[] = [];
  const none: string[] = [];
  const cut = before ? Date.parse(before) : NaN;
  const older = (oldest: string | null) => (before ? !!oldest && Date.parse(oldest) < cut : true);
  const from = before ? ` from before ${dayMonthYear(before)}` : '';
  const since = (oldest: string | null) => (oldest ? `, the oldest from ${monthYear(oldest)}` : '');
  let bytes = 0;
  for (const k of kinds) {
    const kind = s.kinds[k];
    if (!kind) continue;
    if (!older(kind.oldest) || kind.count === 0) {
      none.push(NONE[k]);
      continue;
    }
    bytes += kind.bytes;
    if (k === 'prices') {
      const p = s.kinds.prices;
      goes.push(
        before
          ? `Prices${from} (there are ${n(p.count)} now${since(p.oldest)}). Each product keeps its newest price.`
          : `${plural(Math.max(0, p.count - p.products), 'older price')}. The newest price of each of the ${n(p.products)} products stays.`,
      );
    } else if (k === 'receipts') {
      const r = s.kinds.receipts;
      const pinned = r.pinned ? ` Pinned receipts (${n(r.pinned)}) stay.` : '';
      goes.push(
        before
          ? `Receipts${from} and their photos (there are ${n(r.count)} now${since(r.oldest)}).${pinned}`
          : `${plural(Math.max(0, r.count - r.pinned), 'receipt')} and their photos.${pinned}`,
      );
    } else if (k === 'stats') {
      const t = s.kinds.stats;
      goes.push(
        before
          ? `What you ticked off${from} (${plural(t.count, 'ticked item')} now${since(t.oldest)}), so the spending charts start from ${dayMonthYear(before)}.`
          : `${plural(t.count, 'ticked item')} behind the spending charts, so they start again from now.`,
      );
    } else if (k === 'logs') {
      const l = s.kinds.logs;
      goes.push(
        before ? `Activity and log entries${from} (there are ${n(l.count)} now${since(l.oldest)}).` : `${plural(l.count, 'activity and log entry', 'activity and log entries')}.`,
      );
    } else if (k === 'backups') {
      const b = s.kinds.backups;
      goes.push(
        before
          ? `Deleted files the server kept${from} (${plural(b.count, 'file')} kept now).`
          : `${plural(b.count, 'deleted file')} the server was keeping for ${b.keptDays} days in case you needed them back.`,
      );
    }
  }
  return { goes, none, bytes: before ? undefined : bytes };
}

/**
 * 0.9.5: Step 1 with the server's exact counts (POST /api/v3/data/delete with dryRun: the same rules
 * as the delete itself), for a date too: what goes, a line each, and the kinds that lose nothing.
 */
function exactStepOne(s: DataSummary, kinds: DataKind[], before: string | null, c: Deleted): StepOne {
  const goes: string[] = [];
  const none: string[] = [];
  const from = before ? ` from before ${dayMonthYear(before)}` : '';
  const v = (x: number | undefined) => Math.max(0, Number(x) || 0);
  let bytes = 0;
  for (const k of kinds) {
    const kind = s.kinds[k];
    if (!kind) continue;
    if (k === 'prices') {
      if (!v(c.prices)) {
        none.push(NONE.prices);
        continue;
      }
      goes.push(`${plural(v(c.prices), 'older price')}${from}. Each product keeps its newest price.`);
    } else if (k === 'receipts') {
      if (!v(c.receipts)) {
        none.push(NONE.receipts);
        continue;
      }
      const pinned = s.kinds.receipts.pinned ? ` Pinned receipts (${n(s.kinds.receipts.pinned)}) stay.` : '';
      goes.push(`${plural(v(c.receipts), 'receipt')}${from}${v(c.photos) ? ` and ${plural(v(c.photos), 'photo')}` : ''}.${pinned}`);
    } else if (k === 'stats') {
      if (!v(c.stats)) {
        none.push(NONE.stats);
        continue;
      }
      goes.push(
        before
          ? `${plural(v(c.stats), 'ticked item')}${from}, so the spending charts start from ${dayMonthYear(before)}.`
          : `${plural(v(c.stats), 'ticked item')} behind the spending charts, so they start again from now.`,
      );
    } else if (k === 'logs') {
      if (!v(c.logs)) {
        none.push(NONE.logs);
        continue;
      }
      goes.push(`${plural(v(c.logs), 'activity and log entry', 'activity and log entries')}${from}.`);
    } else if (k === 'backups') {
      if (!v(c.backups)) {
        none.push(NONE.backups);
        continue;
      }
      goes.push(`${plural(v(c.backups), 'deleted file')}${from} the server was keeping for ${s.kinds.backups.keptDays} days in case you needed them back.`);
    }
    bytes += kind.bytes;
  }
  if (v(c.archives)) goes.push(`${plural(v(c.archives), 'month file')} of older prices and receipts the phones moved to the server.`);
  return { goes, none, bytes: before ? undefined : bytes };
}

const NONE: Record<DataKind, string> = {
  prices: 'No prices are that old.',
  receipts: 'No receipts are that old.',
  stats: 'Nothing ticked off is that old.',
  logs: 'No activity or logs are that old.',
  backups: 'No deleted files are that old.',
};

/** Step 2's line and button: "About 88 MB of your household's history…", "Delete 88 MB". */
export function stepTwo(one: StepOne, before: string | null): { line: string; action: string } {
  if (!before && one.bytes && one.bytes > 0) {
    const size = bytesText(one.bytes);
    return { line: `About ${size} of your household's history will be gone for everyone on this server.`, action: `Delete ${size}` };
  }
  if (before) return { line: `Your household's history from before ${dayMonthYear(before)} will be gone for everyone on this server.`, action: 'Delete older data' };
  return { line: 'This will be gone for everyone on this server.', action: 'Delete' };
}
