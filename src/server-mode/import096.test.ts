/// <reference types="node" />
// 0.9.6: Import on the web's Data tab, without a browser (ui/importFile.ts): reading the export file
// and the CSV zip back, refusing secrets and spreadsheets, one product per shop and shop number,
// Costco left out, chunks under the server's caps, the steps (no import without Step 2's passphrase,
// Cancel), the dry run's words, and the export leaving Costco's prices out (exportFiles.ts).
import { existsSync, readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { csvFiles, exportTables } from './ui/exportFiles';
import {
  chunksOf,
  csvRows,
  dryRunLine,
  firstImport,
  ignoredOf,
  ImportRefused,
  importReducer,
  LIMITS,
  parseCsv,
  readImport,
  type ImportProduct,
  type ImportState } from './ui/importFile';

const json = (v: unknown) => strToU8(JSON.stringify(v));
const exp = (tables: Record<string, unknown>, more: Record<string, unknown> = {}) => ({ format: 'restock-export', v: 1, app: 'restock-server', at: '2026-11-11T00:00:00.000Z', tables, ...more });

const sample = () =>
  exp({
    items: [{ id: 'i1', name: 'Milk' }],
    list: [{ id: 'l1', text: 'Milk' }],
    receipts: [{ id: 'r1', total: 20, photos: 1 }],
    products: [
      { id: 'p1', chain: 'coles', name: 'Milk 2L', store_product_id: '111', barcode: '9300633603205', qty: 2000, qty_unit: 'ml', created_at: 'x' },
      { id: 'p1b', chain: 'coles', name: 'Milk 2L (again)', store_product_id: '111' }, // the same product
      { id: 'p2', chain: 'woolworths', name: 'Bread', prices: [{ date: '2026-11-01', price: 4 }] },
      { id: 'p-cc', chain: 'costco', name: 'Nuts' },
    ],
    prices: [
      { id: 1, product_id: 'p1', date: '2026-11-02T01:00:00.000Z', price: 3.1, is_special: 0, member_only: 0, source: 'auto' },
      { id: 2, product_id: 'p1b', date: '2026-11-01T01:00:00.000Z', price: 3.3, is_special: 1, was_price: 3.6, member_only: 0 },
      { id: 3, product_id: 'p-cc', date: '2026-11-01', price: 19.99 },
      { id: 4, product_id: 'nope', date: '2026-11-01', price: 1 },
      { id: 5, product_id: 'p2', price: 1 },
    ],
  });

describe('reading a file', () => {

  it('the CSV files (.zip) the Data tab downloads read back the same', () => {
    const e = sample();
    const zip = csvFiles(exportTables(e as never), 'restock-data').bytes;
    const r = readImport(zip, 'restock-data-csv.zip');
    expect(r.kind).toBe('csv');
    const fromJson = readImport(json(e));
    // The CSV has no `prices` inside a product row (it's JSON text in a cell), so Bread has none there.
    expect(r.products.map((p) => [p.ref, p.store_product_id, p.barcode, p.qty, p.qty_unit])).toEqual(fromJson.products.map((p) => [p.ref, p.store_product_id, p.barcode, p.qty, p.qty_unit]));
    expect(r.products[0].prices).toEqual(fromJson.products[0].prices);
    expect(r.notTaken).toEqual(expect.arrayContaining(['items', 'receipts', 'shopping list']));
  });

  it('a formula guard and quotes in CSV come back as typed', () => {
    expect(parseCsv('﻿a,b\r\n"x, ""y""",\'=SUM\r\n')).toEqual([
      ['a', 'b'],
      ['x, "y"', "'=SUM"],
    ]);
    const zip = zipSync({ 'Products.csv': strToU8('id,chain,name,store_product_id\r\nq1,aldi,"\'=Choc, dark",55\r\n'), 'Prices.csv': strToU8('product_id,date,price,is_special\r\nq1,2026-11-01,$2.29,true\r\n') });
    const r = readImport(zip);
    expect(r.products[0]).toMatchObject({ ref: 'q1', chain: 'aldi', name: '=Choc, dark', store_product_id: '55', prices: [{ date: '2026-11-01', price: 2.29, is_special: true }] });
    expect(csvRows('a\n1')).toEqual([{ a: '1' }]);
  });

  it('refuses secrets, spreadsheets, newer versions, other files, and files over the caps', () => {
    const refused = (bytes: Uint8Array, name = '') => {
      try {
        readImport(bytes, name);
      } catch (e) {
        expect(e).toBeInstanceOf(ImportRefused);
        return (e as Error).message;
      }
      throw new Error('not refused');
    };
    expect(refused(json(exp({ products: [], cards: [{ id: 'c', number: '6008943212345678' }] })))).toMatch(/never imports card numbers/);
    expect(refused(json(exp({ products: [{ chain: 'coles', name: 'x', pin: '1234' }] })))).toMatch(/"pin"/);
    expect(refused(json(exp({ products: [{ chain: 'coles', name: 'x', prices: [{ date: '2026-11-01', price: 1, password: 'p' }] }] })))).toMatch(/"password"/);
    expect(refused(json(exp({ products: [], receipts: [{ id: 'r', text: 'FLYBUYS 6008…' }] })))).toMatch(/receipt words/);
    expect(refused(json(exp({ products: [{ chain: 'coles', name: 'x', image_url: 'data:image/png;base64,AAAA' }] })))).toMatch(/photo/);
    expect(refused(json(exp({ products: [] }, { keys: { owner: 'x' } })))).toMatch(/"keys"/);
    expect(refused(zipSync({ 'Products.csv': strToU8('id\n'), 'Cards.csv': strToU8('number\n1\n') }))).toMatch(/cards\.csv/);
    expect(refused(zipSync({ '[Content_Types].xml': strToU8('<x/>'), 'xl/workbook.xml': strToU8('<x/>') }), 'a.xlsx')).toMatch(/Spreadsheets \(\.xlsx\) can't be imported/);
    expect(refused(json({ ...exp({ products: [] }), v: 2 }))).toMatch(/newer Restock/);
    expect(refused(json({ tables: {} }))).toMatch(/restock-export/);
    expect(refused(strToU8('not json'))).toMatch(/isn't a Restock export/);
    expect(refused(new Uint8Array(0))).toMatch(/empty/);
    expect(refused(json(exp({ items: [] })))).toMatch(/no products/);
    const many = Array.from({ length: LIMITS.products + 1 }, (_, i) => ({ chain: 'aldi', name: 'x', store_product_id: String(i) }));
    expect(refused(json(exp({ products: many })))).toMatch(/25,000/);
    // The export's own receipts (metadata, a photo count) are fine; a list line's words are too.
    expect(() => readImport(json(sample()))).not.toThrow();
  });
});

describe('chunks', () => {
  const big = (products: number, prices: number): ImportProduct[] =>
    Array.from({ length: products }, (_, i) => ({
      ref: `p${i}`,
      chain: 'woolworths',
      name: `Product number ${i} with a fairly long name to take some room`,
      store_product_id: String(100000 + i),
      prices: Array.from({ length: prices }, (_, d) => ({ date: new Date(Date.UTC(2025, 0, 1) + d * 3600_000 * 7).toISOString(), price: 1 + (d % 50) / 10, promo: 'Down down' })),
    }));

  it('each chunk stays under the server caps (256 KB, products, prices); a big product goes in parts, cut between days', () => {
    const products = [...big(3000, 2), ...big(1, 4900)];
    const chunks = chunksOf(products);
    let total = 0;
    for (const c of chunks) {
      expect(new TextEncoder().encode(JSON.stringify({ import: 'x'.repeat(22), n: 999, products: c })).length).toBeLessThan(256 * 1024);
      expect(c.length).toBeLessThanOrEqual(LIMITS.chunkProducts);
      expect(c.reduce((s, p) => s + p.prices.length, 0)).toBeLessThanOrEqual(LIMITS.chunkPrices);
      total += c.reduce((s, p) => s + p.prices.length, 0);
    }
    expect(total).toBe(3000 * 2 + 4900);
    const parts = chunks.flat().filter((p) => p.ref === 'p0' && p.prices.length > 100);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.slice(1).every((p) => p.more === true)).toBe(true);
    expect(parts[0].more).toBeUndefined();
    for (let i = 1; i < parts.length; i++) expect(parts[i].prices[0].date.slice(0, 10)).not.toBe(parts[i - 1].prices[parts[i - 1].prices.length - 1].date.slice(0, 10));
  });
});

describe('the steps and the words', () => {
  const read = readImport(json(sample()));
  const answer = { products: { add: 12000, matched: 3 }, prices: { add: 90000, skipped: 300 }, costco: { products: 0, prices: 0 }, problems: { date: 2, shop: 1, 'picture-left-out': 4 } };

  it('the dry run, Step 1, Step 2 (only with a passphrase), the import, Cancel', () => {
    let s: ImportState = importReducer(firstImport(), { t: 'reading', file: 'a.json' });
    s = importReducer(s, { t: 'read', read, chunks: 2 });
    expect(s.phase).toBe('checking');
    s = importReducer(s, { t: 'checked', at: 1, answer });
    s = importReducer(s, { t: 'start' });
    expect(s.phase).toBe('checking'); // no import from the dry run
    s = importReducer(s, { t: 'review' });
    expect(s.phase).toBe('review');
    expect(dryRunLine(s.check)).toBe("Will add 12,000 products and 90,000 prices, skip 300 already there, ignore 5 it couldn't read.");
    expect(ignoredOf(s.check)).toBe(5); // the file's 2 and the server's 3; the 4 pictures left out are notes, not rows
    s = importReducer(s, { t: 'start' });
    expect(s.phase).toBe('review'); // Step 1 can't be skipped
    s = importReducer(s, { t: 'continue' });
    expect(s.phase).toBe('pass');
    s = importReducer(s, { t: 'start' });
    expect(s.phase).toBe('pass'); // no passphrase yet
    s = importReducer(s, { t: 'pass', v: 'kettle orbit' });
    s = importReducer(s, { t: 'start' });
    expect(s.phase).toBe('importing');
    // A wrong passphrase: back to Step 2, said plainly.
    const wrong = importReducer(s, { t: 'refused', error: "That isn't your passphrase. Nothing was imported." });
    expect([wrong.phase, wrong.busy, wrong.error]).toEqual(['pass', false, "That isn't your passphrase. Nothing was imported."]);
    s = importReducer(s, { t: 'sent', at: 1, answer: { products: { added: 5, matched: 0 }, prices: { added: 50, skipped: 1 }, costco: { products: 0, prices: 0 }, problems: {} } });
    s = importReducer(s, { t: 'cancel' });
    expect(s.cancel).toBe(true);
    expect(importReducer(s, { t: 'close' })).toBe(s); // not while it's going
    s = importReducer(s, { t: 'finished', how: 'cancelled' });
    expect(s.phase).toBe('stopped');
    expect(s.pass).toBe('');
    expect(s.done.products).toBe(5);
    expect(importReducer(s, { t: 'close' }).phase).toBe('idle');
  });

  it('Cancel during the dry run goes back to the start; nothing to add means no Continue', () => {
    let s = importReducer(importReducer(firstImport(), { t: 'reading', file: 'a.json' }), { t: 'read', read, chunks: 3 });
    s = importReducer(importReducer(s, { t: 'cancel' }), { t: 'review' });
    expect(s.phase).toBe('idle');
    let e = importReducer(importReducer(firstImport(), { t: 'reading', file: 'a.json' }), { t: 'read', read: { ...read, costco: { products: 0, prices: 0 }, problems: {} }, chunks: 1 });
    e = importReducer(e, { t: 'checked', at: 1, answer: { products: { add: 0, matched: 2 }, prices: { add: 0, skipped: 9 }, costco: { products: 0, prices: 0 }, problems: {} } });
    e = importReducer(importReducer(e, { t: 'review' }), { t: 'continue' });
    expect(e.phase).toBe('review');
  });

});


describe('docs/restock-import.md', () => {
  it("its example file reads as it says (two products, three prices), and the server's copy is the same", () => {
    const md = readFileSync(new URL('../../docs/restock-import.md', import.meta.url), 'utf8');
    const block = /```json\n([\s\S]*?)```/.exec(md)?.[1];
    expect(block).toBeTruthy();
    const r = readImport(strToU8(block!));
    expect(r.products.map((p) => p.ref)).toEqual(['ww-123456', 'aldi-choc']);
    expect(r.priceCount).toBe(3);
    expect(r.problems).toEqual({});
    // The server is its own repository (server/, ignored here): checked when it's there.
    const copy = new URL('../../server/docs/restock-import.md', import.meta.url);
    if (existsSync(copy)) expect(readFileSync(copy, 'utf8')).toBe(md);
  });
});
