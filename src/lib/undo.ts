import { queryRows, rowsForGroups, runOps, setResetWatcher, setWriteWatcher, type RowSet } from './db';
import type { SqlOp, SqlValue } from './sql/driver';

// 0.9.5 (undo): one Undo for phone and web.
//
// Each thing someone does (add to the list, "Add all 32 to my list", a tick, a delete, an edit…)
// runs through act(). While it runs, every write db.ts makes is seen first (setWriteWatcher), and
// the rows it touches are remembered as they were, by their own ids. Undo then puts exactly those
// rows back, in one go, however many there were:
// - a row the action made is deleted again;
// - a row the action deleted is made again with the same id and the same values (sync counts it as
//   made again after the delete, so it comes back on the other phones and the server too);
// - a row the action changed gets its old values back with an ordinary update (a list line's tick
//   and amount are stamped now, so the other phones take the undo as the newer change).
// Anything someone else changed since (a sync from another phone) is left as it is.

type Row = Record<string, SqlValue>;

/** The tables an action can change, and each one's own key. */
const KEYS: Record<string, string> = {
  items: 'id',
  products: 'id',
  list_entries: 'id',
  cards: 'id',
  categories: 'id',
  receipts: 'id',
  prices: 'id',
  household_settings: 'k',
};
/** Columns that change by themselves (a price check, the tick's own clock): not a change by someone else. */
const VOLATILE = new Set(['in_stock', 'stock_at', 'in_stock_2', 'checked_at', 'qty_at']);

export interface UndoStep {
  id: number;
  /** What happened, as shown: "Added 32 to your shopping list". */
  label: string;
  at: number;
  /** Steps with the same key close together (tapping + three times) become one. */
  merge?: string;
}
interface Held extends UndoStep {
  before: Map<string, Map<string, Row | null>>;
  after: Map<string, Map<string, Row | null>>;
  extra: (() => Promise<void>)[];
}

export type UndoEvent = { kind: 'added'; step: UndoStep } | { kind: 'undone'; step: UndoStep; kept: number } | { kind: 'cleared' };

const MAX_STEPS = 20;
/** How long an action can still be undone (Ctrl+Z on the web; the button shows for a few seconds). */
export const UNDO_KEEP_MS = 30 * 60_000;
const MERGE_MS = 6000;

let steps: Held[] = [];
let nextId = 1;
const listeners = new Set<(e: UndoEvent) => void>();
let queue: Promise<unknown> = Promise.resolve();

export function onUndo(fn: (e: UndoEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (e: UndoEvent) => listeners.forEach((fn) => fn(e));

/** The newest action that can still be undone. */
export function lastStep(now = Date.now()): UndoStep | undefined {
  const s = steps[steps.length - 1];
  return s && now - s.at <= UNDO_KEEP_MS ? public_(s) : undefined;
}
const public_ = (s: Held): UndoStep => ({ id: s.id, label: s.label, at: s.at, merge: s.merge });

/** Forget every action (signing out, erasing, restoring a backup). */
export function clearUndo(): void {
  steps = [];
  emit({ kind: 'cleared' });
}

// ---------- seeing writes ----------

interface Capture {
  before: Map<string, Map<string, Row | null>>;
  /** Prices are added without an id: the ones there were for each product and date, to find the new ones after. */
  priceKeys: Map<string, Set<string>>;
  extra: (() => Promise<void>)[];
}
let capture: Capture | undefined;

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');
const countQ = (s: string) => (s.match(/\?/g) ?? []).length;

async function remember(table: string, rows: Row[]) {
  const c = capture!;
  const key = KEYS[table];
  let m = c.before.get(table);
  if (!m) c.before.set(table, (m = new Map()));
  for (const r of rows) {
    const pk = String(r[key]);
    if (!m.has(pk)) m.set(pk, { ...r });
  }
}
function rememberMissing(table: string, pk: string) {
  const c = capture!;
  let m = c.before.get(table);
  if (!m) c.before.set(table, (m = new Map()));
  if (!m.has(pk)) m.set(pk, null);
}

/** Works out which rows one statement touches and remembers them as they are now. */
async function see(op: SqlOp): Promise<void> {
  const text = op.sql.replace(/\s+/g, ' ').trim();
  const params = op.params ?? [];
  let m = /^INSERT (?:OR (REPLACE|IGNORE) )?INTO (\w+) \(([^)]*)\) VALUES/i.exec(text);
  if (m) {
    const table = m[2];
    if (!(table in KEYS)) return;
    const cols = m[3].split(',').map((c) => c.trim());
    const at = cols.indexOf(KEYS[table]);
    if (at >= 0) {
      const pk = params[at];
      const now = m[1] ? await queryRows<Row>(`SELECT * FROM ${table} WHERE ${KEYS[table]} = ?`, [pk]) : [];
      if (now.length) await remember(table, now);
      else rememberMissing(table, String(pk));
    } else if (table === 'prices') {
      const pi = cols.indexOf('product_id');
      const di = cols.indexOf('date');
      if (pi < 0 || di < 0) return;
      const k = `${params[pi]}|${params[di]}`;
      if (capture!.priceKeys.has(k)) return;
      const had = await queryRows<{ id: number }>('SELECT id FROM prices WHERE product_id = ? AND date = ?', [params[pi], params[di]]);
      capture!.priceKeys.set(k, new Set(had.map((r) => String(r.id))));
    }
    return;
  }
  m = /^UPDATE (\w+) SET (.*?) WHERE (.*)$/i.exec(text);
  if (m) {
    const table = m[1];
    if (!(table in KEYS)) return;
    const n = countQ(m[3]);
    const rows = await queryRows<Row>(`SELECT * FROM ${table} WHERE ${m[3]}`, n ? params.slice(params.length - n) : []);
    await remember(table, rows);
    return;
  }
  m = /^DELETE FROM (\w+)(?: WHERE (.*))?$/i.exec(text);
  if (m) {
    const table = m[1];
    if (!(table in KEYS)) return;
    const rows = await queryRows<Row>(`SELECT * FROM ${table}${m[2] ? ` WHERE ${m[2]}` : ''}`, m[2] ? params : []);
    await remember(table, rows);
  }
}

setResetWatcher(() => clearUndo());

setWriteWatcher(async (ops) => {
  if (!capture) return;
  for (const op of ops) await see(op);
});

async function rowsNow(table: string, pks: string[]): Promise<Map<string, Row>> {
  const key = KEYS[table];
  const out = new Map<string, Row>();
  for (let i = 0; i < pks.length; i += 400) {
    const part = pks.slice(i, i + 400);
    for (const r of await queryRows<Row>(`SELECT * FROM ${table} WHERE ${key} IN (${placeholders(part.length)})`, part)) out.set(String(r[key]), r);
  }
  return out;
}

const same = (a: SqlValue | undefined, b: SqlValue | undefined) =>
  a === b || ((a === null || a === undefined) && (b === null || b === undefined)) || (a !== null && b !== null && a !== undefined && b !== undefined && String(a) === String(b));

function rowsSame(a: Row | null | undefined, b: Row | null | undefined, skipVolatile = false): boolean {
  if (!a || !b) return !a && !b;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (skipVolatile && VOLATILE.has(k)) continue;
    if (!same(a[k], b[k])) return false;
  }
  return true;
}

// ---------- actions ----------

export interface ActOptions {
  /** Steps with the same key within a few seconds become one (the + button pressed three times). */
  merge?: string;
}
export interface ActContext {
  /** Something outside the database to put back too (a receipt's photo). */
  onUndo: (fn: () => Promise<void>) => void;
  /**
   * Another action's code, run as part of this one (one Undo for both). The only way to nest:
   * calling act() inside an action queues a separate action after this one (and waiting for it
   * there would never end).
   */
  act: <U>(change: (ctx: ActContext) => Promise<U>) => Promise<U>;
}

function contextFor(c: Capture): ActContext {
  const ctx: ActContext = {
    onUndo: (fn) => c.extra.push(fn),
    act: (change) => change(ctx),
  };
  return ctx;
}

/** Runs `fn` next in the one queue every action, undo and background write goes through. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * 0.9.5 (review): a write nobody pressed for (a Home Assistant round, a price check, a sync
 * round's tidy-up). It waits for the action that's running to finish, and actions wait for it,
 * so its writes are never seen as part of an action (and never undone by its Undo). Keep `fn`
 * to the database writes: it holds up the next tap while it runs. Never call it from inside an
 * action (it would wait for that action, which waits for it).
 */
export function background<T>(fn: () => Promise<T>): Promise<T> {
  return enqueue(fn);
}

/**
 * Runs something someone did so it can be undone in one press. `label` says what happened
 * ("Added 32 to your shopping list"); from the result if it's a function, and null for "nothing
 * changed" (then no Undo is offered). Every action is queued: one starts when the one before has
 * finished, so two actions started together are two Undo steps, never one. To run another
 * action's code as part of this one, use ctx.act.
 */
export function act<T>(label: string | ((result: T) => string | null | undefined), change: (ctx: ActContext) => Promise<T>, opts: ActOptions = {}): Promise<T> {
  return enqueue(async () => {
    const { result, held } = await record(change);
    const text = typeof label === 'function' ? label(result) : label;
    if (held && text) push(held, text, opts.merge);
    return result;
  });
}

type Recorded = Pick<Held, 'before' | 'after' | 'extra'>;

/** Runs a change, seeing its writes; what it changed, or no `held` if nothing did. */
async function record<T>(change: (ctx: ActContext) => Promise<T>): Promise<{ result: T; held?: Recorded }> {
  const c: Capture = { before: new Map(), priceKeys: new Map(), extra: [] };
  capture = c;
  let result: T;
  try {
    result = await change(contextFor(c));
  } finally {
    capture = undefined;
  }
  // New prices: the ids for each product and date that weren't there before.
  for (const [k, had] of c.priceKeys) {
    const cut = k.lastIndexOf('|');
    const ids = await queryRows<{ id: number }>('SELECT id FROM prices WHERE product_id = ? AND date = ?', [k.slice(0, cut), k.slice(cut + 1)]);
    for (const r of ids)
      if (!had.has(String(r.id))) {
        let m = c.before.get('prices');
        if (!m) c.before.set('prices', (m = new Map()));
        if (!m.has(String(r.id))) m.set(String(r.id), null);
      }
  }
  const after = new Map<string, Map<string, Row | null>>();
  let changedAny = c.extra.length > 0;
  for (const [table, rows] of c.before) {
    const now = await rowsNow(table, [...rows.keys()]);
    const m = new Map<string, Row | null>();
    for (const [pk, was] of rows) {
      const is = now.get(pk) ?? null;
      if (rowsSame(was, is)) {
        rows.delete(pk);
        continue;
      }
      m.set(pk, is && { ...is });
      changedAny = true;
    }
    after.set(table, m);
  }
  return { result, held: changedAny ? { before: c.before, after, extra: c.extra } : undefined };
}

function push(rec: Recorded, label: string, merge?: string) {
  const top = steps[steps.length - 1];
  const at = Date.now();
  if (merge && top && top.merge === merge && at - top.at < MERGE_MS) {
    // One step: what was there before the first press, what's there after the last.
    for (const [table, rows] of rec.before) {
      let b = top.before.get(table);
      if (!b) top.before.set(table, (b = new Map()));
      let a = top.after.get(table);
      if (!a) top.after.set(table, (a = new Map()));
      for (const [pk, was] of rows) if (!b.has(pk)) b.set(pk, was);
      for (const [pk, is] of rec.after.get(table) ?? []) a.set(pk, is);
    }
    top.extra.push(...rec.extra);
    top.label = label;
    top.at = at;
    emit({ kind: 'added', step: public_(top) });
    return;
  }
  const step: Held = { id: nextId++, label, at, merge, ...rec };
  steps.push(step);
  if (steps.length > MAX_STEPS) steps = steps.slice(-MAX_STEPS);
  emit({ kind: 'added', step: public_(step) });
}

/** The statements that put one step back, and how many rows were left because they changed since. */
export async function undoOps(step: Pick<Held, 'before' | 'after'>, now = Date.now()): Promise<{ ops: SqlOp[]; kept: number; back: number }> {
  const ops: SqlOp[] = [];
  let kept = 0;
  let back = 0;
  const deletes: SqlOp[] = [];
  const inserts: SqlOp[] = [];
  const updates: SqlOp[] = [];
  for (const [table, rows] of step.before) {
    const key = KEYS[table];
    const cur = await rowsNow(table, [...rows.keys()]);
    for (const [pk, was] of rows) {
      const is = step.after.get(table)?.get(pk) ?? null;
      const here = cur.get(pk) ?? null;
      if (!was && is) {
        // Made by the action: take it away again, unless someone has changed it since.
        if (!here) continue;
        if (!rowsSame(here, is, true)) {
          kept++;
          continue;
        }
        deletes.push({ sql: `DELETE FROM ${table} WHERE ${key} = ?`, params: [pk] });
        back++;
      } else if (was && !is) {
        // Deleted by the action: make it again, the same record with the same id.
        if (here) {
          kept++;
          continue;
        }
        const cols = Object.keys(was);
        inserts.push({ sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders(cols.length)})`, params: cols.map((c) => was[c]) });
        back++;
      } else if (was && is) {
        if (!here) {
          kept++;
          continue;
        }
        const sets: string[] = [];
        const params: SqlValue[] = [];
        let skipped = false;
        for (const col of Object.keys(was)) {
          if (table === 'list_entries' && (col === 'checked_at' || col === 'qty_at')) continue;
          if (same(was[col], is[col])) continue;
          if (!same(here[col], is[col])) {
            skipped = true;
            continue;
          }
          sets.push(`${col} = ?`);
          params.push(was[col]);
          // The tick and the amount keep whichever changed last when phones sync: the undo is the newest.
          if (table === 'list_entries' && col === 'checked') sets.push(`checked_at = ${Math.trunc(now)}`);
          if (table === 'list_entries' && col === 'qty') sets.push(`qty_at = ${Math.trunc(now)}`);
        }
        if (skipped) kept++;
        if (sets.length) {
          updates.push({ sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE ${key} = ?`, params: [...params, pk] });
          back++;
        }
      }
    }
  }
  ops.push(...deletes, ...inserts, ...updates);
  return { ops, kept, back };
}

/** Undo one step (the newest if no id). Returns what was undone, or undefined if there was nothing. */
export function undo(id?: number): Promise<{ step: UndoStep; kept: number } | undefined> {
  return enqueue(async () => {
    const i = id === undefined ? steps.length - 1 : steps.findIndex((s) => s.id === id);
    const step = steps[i];
    if (!step || Date.now() - step.at > UNDO_KEEP_MS) return undefined;
    steps.splice(i, 1);
    const { ops, kept } = await undoOps(step);
    // The rows first, then what's outside them (a photo, or what the server made for a web add:
    // searchUndo.ts, which needs the list line put back as it was before it takes the item away).
    if (ops.length) await runOps(ops);
    for (const fn of step.extra) await fn();
    const out = { step: public_(step), kept };
    emit({ kind: 'undone', ...out });
    return out;
  });
}

/** "Undone: Milk added to your shopping list" (and what was left because it changed on another phone since). */
export const undoneText = (r: { step: UndoStep; kept: number }) =>
  `Undone: ${r.step.label}${r.kept ? `. ${r.kept} left as ${r.kept === 1 ? 'it is' : 'they are'}: changed on another phone since` : ''}`;

// ---------- before 0.9.5 ----------

/**
 * Run a change and return a function that puts it back. Kept for older callers; act() is the
 * one to use (it also offers the Undo button). The rows argument isn't needed any more.
 */
export async function undoable(change: () => Promise<void>, _rows?: RowSet[] | Promise<RowSet[]>): Promise<() => Promise<void>> {
  let { held } = await enqueue(() => record(change));
  return async () => {
    if (!held) return;
    const h = held;
    held = undefined;
    const { ops } = await undoOps(h);
    if (ops.length) await runOps(ops);
    for (const fn of h.extra) await fn();
  };
}

export const groupRows = (ids: string[]) => rowsForGroups(ids);
export const entryRows = (ids: string[]): RowSet[] =>
  ids.length ? [{ table: 'list_entries', where: `id IN (${ids.map(() => '?').join(',')})`, params: ids }] : [];
export const cardRows = (id: string): RowSet[] => [{ table: 'cards', where: 'id = ?', params: [id] }];
export const productRows = (groupId: string, productId: string): RowSet[] => [
  { table: 'items', where: 'id = ?', params: [groupId] },
  { table: 'products', where: 'id = ?', params: [productId] },
  { table: 'prices', where: 'product_id = ?', params: [productId] },
];
