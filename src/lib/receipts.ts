import { SHOPS, type Section, type StoreChain } from '../shops';
import type { Receipt, Settings } from '../types';
import { allReceipts, deleteReceipts, getSettings } from './db';
import { deletePhoto } from './receiptFiles';
import { KEEP_MONTHS } from './settingsCheck';

// Receipts: how long they're kept, and reading the shop, date and total off the words the reader
// found. Reading is a best guess; everything can be corrected before saving.

/** Keep for 1, 2, 3, 6 or 12 months, or forever (0). Counted from the day it was scanned. (Listed in settingsCheck.ts.) */
export { KEEP_MONTHS };
export const keepLabel = (m: number) => (m === 0 ? 'Until I delete them' : m === 12 ? '12 months' : m === 1 ? '1 month' : `${m} months`);

/** The day a receipt will be deleted, or undefined if it's kept (pinned, or keeping forever). */
export function deleteOn(r: Pick<Receipt, 'scannedAt' | 'pinned'>, keepMonths: number): Date | undefined {
  if (r.pinned || !keepMonths) return undefined;
  // 0.9.0: only one of the real choices. A nonsense keep time (a damaged setting, say -1) keeps
  // the receipt rather than deleting it.
  if (!KEEP_MONTHS.includes(keepMonths)) return undefined;
  const d = new Date(r.scannedAt);
  if (Number.isNaN(d.getTime())) return undefined;
  const day = d.getDate();
  d.setMonth(d.getMonth() + keepMonths);
  // 31 March + 1 month is 1 May in JavaScript; keep it to the end of April.
  if (d.getDate() < day) d.setDate(0);
  return d;
}

/** Receipts that would go if the keep time were `keepMonths`. */
export function expired(receipts: Receipt[], keepMonths: number, now = new Date()): Receipt[] {
  return receipts.filter((r) => {
    const on = deleteOn(r, keepMonths);
    return on !== undefined && on <= now;
  });
}

/** Deletes receipts past their keep time (pinned ones stay). Returns how many went. */
export async function tidyReceipts(s?: Settings): Promise<number> {
  const settings = s ?? (await getSettings());
  // 0.9.0: nothing is deleted unless the keep time is one of the real choices.
  const keep = settings.receipts?.keepMonths;
  if (!KEEP_MONTHS.includes(keep) || keep === 0) return 0;
  const gone = expired(await allReceipts(), keep);
  await removeReceipts(gone);
  return gone.length;
}

export async function removeReceipts(list: Receipt[]): Promise<void> {
  for (const r of list) for (const path of [r.photo, ...(r.pages ?? [])]) if (path) await deletePhoto(path);
  await deleteReceipts(list.map((r) => r.id));
}

// ---------- reading a receipt ----------

export interface ReadReceipt {
  shop?: string;
  chain?: StoreChain;
  section?: Section;
  /** YYYY-MM-DD */
  date?: string;
  total?: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function validDate(y: number, m: number, d: number, now: Date): string | undefined {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(y, m - 1, d);
  if (dt.getMonth() !== m - 1) return undefined;
  // A receipt is from the past two years, and not from the future (a day's grace for time zones).
  const age = now.getTime() - dt.getTime();
  if (age < -86_400_000 || age > 2 * 366 * 86_400_000) return undefined;
  return iso(y, m, d);
}

/** The date printed on the receipt. Australian receipts write day first (07/11/26). */
export function findDate(text: string, now = new Date()): string | undefined {
  const t = text.replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, '0');
  for (const m of t.matchAll(/\b(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4}|\d{2})\b/g)) {
    const d = validDate(Number(m[3]), Number(m[2]), Number(m[1]), now);
    if (d) return d;
  }
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const d = validDate(Number(m[1]), Number(m[2]), Number(m[3]), now);
    if (d) return d;
  }
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4}|\d{2})\b/g)) {
    const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    const d = mon >= 0 ? validDate(Number(m[3]), mon + 1, Number(m[1]), now) : undefined;
    if (d) return d;
  }
  for (const m of t.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const d = mon >= 0 ? validDate(Number(m[3]), mon + 1, Number(m[2]), now) : undefined;
    if (d) return d;
  }
  return undefined;
}

const MONEY = /(?:\$\s*)?(-?\d{1,4}(?:,\d{3})*[.,]\s?\d{2})(?!\d)/g;
const amount = (s: string) =>
  Number(
    s
      .replace(/\s/g, '')
      .replace(/,(?=\d{3})/g, '')
      .replace(',', '.'),
  );

/** The total paid: the "Total" line, not the subtotal, GST, savings or change. */
export function findTotal(text: string): number | undefined {
  const lines = text.split(/\n/).map((l) => l.trim());
  const isPaid = /\b(eftpos|card|visa|mastercard|amex|debit|credit|paid|tap)\b/i;
  const notTotal = /\b(sub\s*-?total|subtotal|gst|tax|sav(e|ed|ing|ings)|discount|change|cash out|rounding|points|items?\b(?!.*\$)|qty)\b/i;
  const pick = (re: RegExp) => {
    const found: number[] = [];
    lines.forEach((l, i) => {
      if (!re.test(l) || notTotal.test(l)) return;
      // The amount is usually on the same line, sometimes the next one.
      const here = [...l.matchAll(MONEY)].map((m) => amount(m[1]));
      const next = here.length ? [] : [...(lines[i + 1] ?? '').matchAll(MONEY)].map((m) => amount(m[1]));
      found.push(...[...here, ...next].filter((n) => n > 0 && n < 5000));
    });
    return found;
  };
  // "TOTAL" itself first; then what was paid by card. When the reader misreads one of them
  // ($9.26 for $9.20), the amount that shows up on more than one line wins.
  const totals = pick(/\btotal\b|balance due|amount due|to pay/i);
  const paid = pick(isPaid);
  const seen = new Map<number, number>();
  for (const n of [...totals, ...paid]) seen.set(n, (seen.get(n) ?? 0) + 1);
  const agreed = [...seen].filter(([, c]) => c > 1).map(([n]) => n);
  if (agreed.length) return Math.max(...agreed);
  if (totals.length) return Math.max(...totals);
  if (paid.length) return Math.max(...paid);
  return undefined;
}

/** Which shop: a chain Restock knows, found near the top of the receipt first. */
export function findShop(text: string): { shop?: string; chain?: StoreChain; section?: Section } {
  // OCR often reads O as 0 inside words ("W00LWORTHS").
  const clean = text.replace(/(?<=[A-Za-z])0|0(?=[A-Za-z])/g, 'o');
  const lines = clean
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => /[A-Za-z]{3}/.test(l));
  const tryIn = (ls: string[]) => {
    for (const l of ls)
      for (const s of SHOPS) {
        if (s.map.test(l) || l.toLowerCase().includes(s.name.toLowerCase())) return { line: l, s };
      }
    return undefined;
  };
  const hit = tryIn(lines.slice(0, 8)) ?? tryIn(lines);
  if (hit) {
    const line = hit.line
      .replace(/[^A-Za-z0-9'&\- ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const tidy = line.length <= 40 ? titleCase(line) : hit.s.name;
    return { shop: tidy, chain: hit.s.id as StoreChain, section: hit.s.section };
  }
  // Otherwise the first line that looks like a name.
  const first = lines.find((l) => /^[A-Za-z][A-Za-z '&-]{2,30}$/.test(l));
  return first ? { shop: titleCase(first) } : {};
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bBws\b/, 'BWS')
    .replace(/\bIga\b/, 'IGA');
}

export function parseReceipt(text: string, now = new Date()): ReadReceipt {
  const shop = findShop(text);
  return { ...shop, date: findDate(text, now), total: findTotal(text) };
}

/** The item lines on a receipt (for recall checks): lines with words and a price, minus the totals. */
export function itemLines(text: string): string[] {
  return text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        /[A-Za-z]{3}/.test(l) &&
        /\d[.,]\d{2}\b/.test(l) &&
        !/(total|\bgst\b|eftpos|\bchange\b|\bcash\b|\bcard\b|visa|mastercard|sav(e|ed|ing|ings)\b|rounding|discount)/i.test(l),
    )
    .map((l) => l.replace(MONEY, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 3);
}

/** The product's name on the front of a pack: the biggest words (used when a barcode isn't known). */
export function packName(lines: { text: string; height: number; confidence: number }[]): string | undefined {
  const words = lines
    .filter((l) => l.confidence > 50 && /[A-Za-z]{3}/.test(l.text))
    .map((l) => ({
      ...l,
      text: l.text
        .replace(/[^A-Za-z0-9'&%.\- ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((l) => l.text.length >= 3)
    .sort((a, b) => b.height - a.height);
  if (!words.length) return undefined;
  const big = words[0].height;
  // The biggest line, plus anything nearly as big (brand on one line, product on the next).
  const picked = words.filter((w) => w.height >= big * 0.6).slice(0, 3);
  return picked
    .map((w) => w.text)
    .join(' ')
    .split(' ')
    .slice(0, 8)
    .join(' ');
}

// ---------- a long receipt in several photos ----------

const lineKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, '');

/** Do two read lines say the same thing? Allows a misread letter or two. */
function sameLine(a: string, b: string): boolean {
  const x = lineKey(a);
  const y = lineKey(b);
  if (!x || !y) return !x && !y;
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 6) return false;
  // Edit distance, so "Weet-Bix Bites 500g 6.50" and "Weet-Bix Bltes 500g 6.50" still match.
  const prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[y.length] / Math.max(x.length, y.length) <= 0.2;
}

/**
 * The words from several photos of one long receipt, taken top to bottom, as one list. Each
 * photo usually overlaps the one before, so the lines at the top of a photo that repeat the
 * bottom of the last one are left out (the longest run that matches, allowing small misreads).
 */
export function joinPages(texts: string[]): string {
  const out: string[] = [];
  for (const text of texts) {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    let skip = 0;
    for (let k = Math.min(lines.length, out.length); k >= 1; k--) {
      const tail = out.slice(out.length - k);
      if (tail.every((l, i) => sameLine(l, lines[i]))) {
        skip = k;
        break;
      }
    }
    // A short overlap of one or two lines only counts when those lines say something.
    if (skip > 0 && skip < 3 && lines.slice(0, skip).every((l) => lineKey(l).length < 6)) skip = 0;
    out.push(...lines.slice(skip));
  }
  return out.join('\n');
}
