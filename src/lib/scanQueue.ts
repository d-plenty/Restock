// 0.10.7: the barcodes from "Scan several", kept on this phone until each one's sorted, so none
// get lost: after matching one you come back to the rest. Things already in your pantry go
// straight on your shopping list as they're scanned; new ones wait here to be matched.

export type ScanStatus = 'added' | 'already' | 'new' | 'matched';
export interface ScanLine {
  code: string;
  name: string;
  status: ScanStatus;
  groupId?: string;
  /** A new one's plain line on the shopping list, replaced when it's matched. */
  entryId?: string;
  at: string;
}

const KEY = 'restock.scanQueue';
/** Finished lines go after this long; ones still to match are kept. */
const KEEP_DONE_DAYS = 2;
const listeners = new Set<() => void>();

function load(): ScanLine[] {
  try {
    const raw = localStorage.getItem(KEY);
    const out = raw ? (JSON.parse(raw) as ScanLine[]) : [];
    return Array.isArray(out) ? out.filter((l) => l && typeof l.code === 'string') : [];
  } catch {
    return [];
  }
}

function store(lines: ScanLine[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // storage full or blocked: the list lasts until the app closes
  }
  memory = lines;
  for (const l of listeners) l();
}

let memory: ScanLine[] | undefined;

/** Newest first. */
export function scanLines(): ScanLine[] {
  if (!memory) {
    const cutoff = Date.now() - KEEP_DONE_DAYS * 86_400_000;
    memory = load().filter((l) => l.status === 'new' || Date.parse(l.at) > cutoff);
  }
  return memory;
}

export function addScanLine(line: Omit<ScanLine, 'at'>) {
  store([{ ...line, at: new Date().toISOString() }, ...scanLines()]);
}

/** A scanned barcode is sorted: matched to a pantry item (or put on the list). */
export function markMatched(code: string, name: string, groupId?: string) {
  store(scanLines().map((l) => (l.code === code && l.status === 'new' ? { ...l, status: 'matched' as const, name, groupId } : l)));
}

/** Clear the ones that are done (kept: the ones still to match). */
export function clearDone() {
  store(scanLines().filter((l) => l.status === 'new'));
}

export function removeScanLine(code: string) {
  store(scanLines().filter((l) => l.code !== code));
}

export const toMatch = (lines = scanLines()) => lines.filter((l) => l.status === 'new').length;

export function onScanLines(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 0.10.7: before, Scan several put a barcode Restock didn't know on the shopping list as "Item
 * 9310205800987", where it turned up while shopping with no way to sort it out. Once, after the
 * update: those lines come off the list and wait in Scanned barcodes to be matched instead.
 */
export async function rescueOldScans(): Promise<number> {
  const KEY_DONE = 'restock.scanRescue0107';
  try {
    if (localStorage.getItem(KEY_DONE)) return 0;
  } catch {
    return 0;
  }
  const { allListEntries, deleteListEntries } = await import('./db');
  const old = (await allListEntries()).filter((e) => !e.groupId && !e.product && !e.checked && /^Item \d{8,14}$/.test(e.text.trim()));
  const have = new Set(scanLines().map((l) => l.code));
  for (const e of old) {
    const code = e.text.trim().slice(5);
    if (!have.has(code)) addScanLine({ code, name: `Barcode ${code}`, status: 'new' });
  }
  if (old.length) await deleteListEntries(old.map((e) => e.id));
  try {
    localStorage.setItem(KEY_DONE, '1');
  } catch {
    // tried once this time
  }
  return old.length;
}
