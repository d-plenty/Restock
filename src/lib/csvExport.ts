import { chainName } from '../shops';
import { SECTION_NAMES } from '../shops';
import type { Snapshot } from './db';
import { localDay } from './verdict';
import { withoutCostco } from './costcoLocal';

// Spreadsheet export (0.9.0): the pantry, the shopping list and the price history as CSV files
// that Excel, LibreOffice, Google Sheets or Numbers open as they are. Your data, in a format
// anything can read.

const cell = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s;
};
/** Comma separated, Windows line ends and a byte-order mark, so Excel reads it as UTF-8. */
export const csv = (rows: unknown[][]): string => '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
/** The day on the phone's own calendar (0.9.0), not UTC's: a 7:30 am Monday price in Brisbane is Monday, not Sunday. */
const day = (iso: string | undefined) => (iso ? localDay(iso) : '');
const money = (n: number | undefined) => (n === undefined || n === null || Number.isNaN(n) ? '' : n.toFixed(2));

export function csvFiles(all: Snapshot): { name: string; text: string }[] {
  // 0.9.6: Costco's prices stay on the phone (costcoLocal.ts).
  const s = withoutCostco(all);
  const products = new Map(s.products.map((p) => [p.id, p]));
  const cats = new Map(s.categories.map((c) => [c.id, c.name]));
  const groups = new Map(s.groups.map((g) => [g.id, g]));
  const latest = new Map<string, (typeof s.prices)[number]>();
  for (const r of s.prices) {
    const had = latest.get(r.productId);
    if (!had || r.date > had.date) latest.set(r.productId, r);
  }
  const sectionName = (sec: string | undefined) => SECTION_NAMES[(sec ?? 'pantry') as keyof typeof SECTION_NAMES] ?? sec ?? '';

  const pantry: unknown[][] = [['Tab', 'Item', 'Category', 'Kind', 'Shop', 'Product', 'Brand', 'Size', 'Barcode', 'Latest price', 'Usual price', 'On special', 'Checked']];
  for (const g of s.groups) {
    const kinds: [string, string][] = [
      ...[g.usualProductId, ...(g.sameProductIds ?? [])].filter((x): x is string => !!x).map((id) => [id, 'My pick'] as [string, string]),
      ...(g.altProductIds ?? []).map((id) => [id, 'Would also take'] as [string, string]),
    ];
    if (!kinds.length) pantry.push([sectionName(g.section), g.name, cats.get(g.categoryId ?? '') ?? '', '', '', '', '', '', '', '', '', '', '']);
    for (const [id, kind] of kinds) {
      const p = products.get(id);
      if (!p) continue;
      const r = latest.get(id);
      pantry.push([
        sectionName(g.section),
        g.name,
        cats.get(g.categoryId ?? '') ?? '',
        kind,
        chainName(p.chain),
        p.name,
        p.brand ?? '',
        p.size ?? '',
        p.barcode ?? '',
        money(r?.price),
        money(r?.wasPrice),
        r ? (r.isSpecial ? 'Yes' : 'No') : '',
        day(r?.date),
      ]);
    }
  }

  const list: unknown[][] = [['Item', 'How many', 'Shop', 'Ticked', 'Added']];
  for (const e of s.list) {
    const g = e.groupId ? groups.get(e.groupId) : undefined;
    list.push([g?.name ?? e.text, e.qty ?? 1, e.chain ? chainName(e.chain) : '', e.checked ? 'Yes' : 'No', day(e.createdAt)]);
  }

  const prices: unknown[][] = [['Date', 'Shop', 'Product', 'Size', 'Price', 'Usual price', 'On special', 'Member price', 'Deal']];
  for (const r of [...s.prices].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const p = products.get(r.productId);
    if (!p || p.id.startsWith('demo-')) continue;
    prices.push([day(r.date), chainName(p.chain), p.name, p.size ?? '', money(r.price), money(r.wasPrice), r.isSpecial ? 'Yes' : 'No', r.memberOnly ? 'Yes' : 'No', r.promo ?? '']);
  }

  return [
    { name: 'restock-pantry.csv', text: csv(pantry) },
    { name: 'restock-shopping-list.csv', text: csv(list) },
    { name: 'restock-price-history.csv', text: csv(prices) },
  ];
}

/** The three CSV files, through Android's share menu (or downloads, in a browser). */
export async function shareCsv(): Promise<number> {
  const { snapshot } = await import('./db');
  const { shareTextFiles } = await import('./shareFile');
  const files = csvFiles(await snapshot());
  await shareTextFiles(files, 'text/csv', 'Restock spreadsheets');
  return files.length;
}
