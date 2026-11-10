/// <reference types="node" />
// 0.9.5: the web's Data tab, without a browser: the spreadsheet (a real .xlsx zip a spreadsheet can
// read), CSV (escaping, formulas made safe, dates), the charts' scaling, the two checks (Step 1 can't
// be skipped, a wrong word blocks Delete, a refusal keeps what was typed), Step 1's words from the
// server's summary, and the period buttons (what each asks the server for).
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cellOf, colName, columnsOf, csvField, csvFiles, csvOf, dateKind, excelSerial, exportTables, sheetName, sheetXml, xlsxOf, xmlText } from './ui/exportFiles';
import {
  barLayout,
  bytesText,
  cheapestByWeek,
  labelEvery,
  monthLabel,
  moneyShort,
  niceScale,
  niceStep,
  perMonth,
  readPeriod,
  shares,
  specialEvery,
  storageParts,
  yOf,
} from './ui/dataCharts';
import { canDelete, firstStep, stepOne, stepReducer, stepTwo, type Steps } from './ui/deleteSteps';
import { data, OLD_SERVER, PERIODS, periodParam, type DataSummary } from './ui/houseData';

describe('the spreadsheet (.xlsx)', () => {
  const tables = [
    { name: 'Items', rows: [{ id: 'i-milk', name: 'Full cream milk & "more" <3', price: 4.65, on: true, ids: ['a', 'b'], none: null }] },
    { name: 'Prices: 2026/11', rows: [{ date: '2026-11-10', at: '2026-11-10T09:30:00.000Z', price: 2.5 }] },
  ];
  const files = unzipSync(xlsxOf(tables));

  it('is a zip with the parts a spreadsheet needs', () => {
    for (const f of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'docProps/core.xml',
    ])
      expect(files[f], f).toBeDefined();
    const types = strFromU8(files['[Content_Types].xml']);
    expect(types).toContain('/xl/worksheets/sheet2.xml');
    expect(types).toContain('spreadsheetml.sheet.main+xml');
    const rels = strFromU8(files['xl/_rels/workbook.xml.rels']);
    expect(rels).toContain('Target="worksheets/sheet1.xml"');
    expect(rels).toContain('Target="styles.xml"');
  });

  it('names a sheet for each table, cleaned for Excel', () => {
    const wb = strFromU8(files['xl/workbook.xml']);
    expect(wb).toContain('<sheet name="Items" sheetId="1" r:id="rId1"/>');
    expect(wb).toContain('name="Prices  2026 11"');
  });

  it('writes numbers as numbers, text inline and escaped, true/false as booleans, arrays as JSON', () => {
    const s = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(s).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">id</t></is></c>');
    expect(s).toContain('<c r="C2"><v>4.65</v></c>');
    expect(s).toContain('<c r="D2" t="b"><v>1</v></c>');
    expect(s).toContain('Full cream milk &amp; &quot;more&quot; &lt;3');
    expect(s).toContain('[&quot;a&quot;,&quot;b&quot;]');
    // An empty cell is left out.
    expect(s).not.toContain('r="F2"');
    expect(s).toContain('<dimension ref="A1:F2"/>');
    expect(s).toContain('state="frozen"');
  });

  it('writes dates as Excel dates with a date format', () => {
    const s = strFromU8(files['xl/worksheets/sheet2.xml']);
    // 10 Nov 2026 is day 46336 counting from 30 Dec 1899.
    expect(s).toContain('<c r="A2" s="2"><v>46336</v></c>');
    const t = /<c r="B2" s="3"><v>([\d.]+)<\/v><\/c>/.exec(s);
    expect(t).not.toBeNull();
    // 9:30 UTC is 8:30 pm in Sydney (the tests' time zone; a sheet has none, so it's local time).
    expect(Number(t![1])).toBeCloseTo(46336 + 20.5 / 24, 5);
    expect(strFromU8(files['xl/styles.xml'])).toContain('formatCode="d mmm yyyy"');
  });

  it('keeps sheet names unique and short, and columns lettered past Z', () => {
    const used = new Set<string>();
    expect(sheetName('Spending by month', used)).toBe('Spending by month');
    expect(sheetName('spending by month', used)).toBe('spending by month 2');
    expect(sheetName('A very long table name that goes on and on', used).length).toBeLessThanOrEqual(31);
    expect(sheetName('[]', used)).toBe('Sheet');
    expect([colName(0), colName(25), colName(26), colName(27), colName(701), colName(702)]).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });

  it("leaves out characters XML can't hold", () => {
    expect(xmlText('a\u0000b\u0007c\td')).toBe('abc\td');
    expect(sheetXml({ name: 'x', rows: [{ a: 'bad\u0001' }] })).toContain('>bad<');
  });

  it('makes a workbook even with nothing in it', () => {
    const f = unzipSync(xlsxOf([]));
    expect(strFromU8(f['xl/workbook.xml'])).toContain('name="Empty"');
  });
});

describe('CSV', () => {
  it('quotes commas, quotes and new lines, and doubles quotes', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField(null)).toBe('');
    expect(csvField(3.5)).toBe('3.5');
    expect(csvField(-2)).toBe('-2');
    expect(csvField(false)).toBe('false');
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('stops text being run as a formula', () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('+61 400')).toBe("'+61 400");
    expect(csvField('-sale')).toBe("'-sale");
    expect(csvField('@home')).toBe("'@home");
  });

  it('writes a header, the rows, and dates as they are (ISO, which every spreadsheet reads)', () => {
    const t = {
      name: 'Ticked',
      rows: [
        { at: '2026-11-10T09:30:00.000Z', text: 'Milk, 3L', total: 4.65 },
        { at: '2026-11-11', extra: 'x' },
      ],
    };
    expect(columnsOf(t.rows)).toEqual(['at', 'text', 'total', 'extra']);
    expect(csvOf(t)).toBe('at,text,total,extra\r\n2026-11-10T09:30:00.000Z,"Milk, 3L",4.65,\r\n2026-11-11,,,x\r\n');
  });

  it('is one file for one table (with a BOM), a zip for several', () => {
    const one = csvFiles([{ name: 'Items', rows: [{ a: 'é' }] }], 'restock-data-2026-11-10');
    expect(one.name).toBe('restock-data-2026-11-10.csv');
    expect([...one.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(strFromU8(one.bytes.slice(3))).toBe('a\r\né\r\n');
    const many = csvFiles(
      [
        { name: 'Shopping list', rows: [{ a: 1 }] },
        { name: 'Shopping list', rows: [{ b: 2 }] },
      ],
      'restock-data',
    );
    expect(many.name).toBe('restock-data-csv.zip');
    expect(Object.keys(unzipSync(many.bytes))).toEqual(['Shopping-list.csv', 'Shopping-list-2.csv']);
  });
});

describe('dates and the export tables', () => {
  it('knows a date from a date and time, and leaves other text alone', () => {
    expect(dateKind('2026-11-10')).toBe('date');
    expect(dateKind('2026-11-10T09:30:00Z')).toBe('time');
    expect(dateKind('2026-11-10T09:30:00.123+10:00')).toBe('time');
    expect(dateKind('2026-11')).toBeUndefined();
    expect(dateKind('10/11/2026')).toBeUndefined();
    expect(dateKind(20261110)).toBeUndefined();
    expect(excelSerial('1900-03-01')).toBe(61);
    expect(excelSerial('not a date')).toBeUndefined();
  });

  it('turns the restock-export into sheets, settings as rows', () => {
    const t = exportTables({
      tables: { items: [{ id: 'i1' }], settings: { tabs: 'pantry', 'shop:coles': { on: true } }, spending: [{ month: '2026-11', total: 10 }], mystery: [{ x: 1 }] },
    });
    expect(t.map((x) => x.name)).toEqual(['Spending by month', 'Items', 'Settings', 'mystery']);
    expect(t[2].rows).toEqual([
      { setting: 'tabs', value: 'pantry' },
      { setting: 'shop:coles', value: { on: true } },
    ]);
    expect(cellOf({ on: true })).toBe('{"on":true}');
  });
});

describe('chart scaling', () => {
  it('steps on 1, 2, 2.5 and 5', () => {
    expect(niceStep(655, 4)).toBe(200);
    expect(niceStep(100, 4)).toBe(25);
    expect(niceStep(9, 4)).toBe(2.5);
    expect(niceStep(0)).toBe(1);
    const s = niceScale(0, 655);
    expect(s).toMatchObject({ min: 0, max: 800, step: 200 });
    expect(s.ticks).toEqual([0, 200, 400, 600, 800]);
    expect(niceScale(22.5, 40).ticks[0]).toBeLessThanOrEqual(22.5);
    expect(niceScale(5, 5).max).toBeGreaterThan(5);
  });

  it('puts bars in their slots, tallest to the top of the scale, zero with no height', () => {
    const box = { width: 600, height: 220, top: 20, right: 0, bottom: 30, left: 0 };
    const { bars, scale, base } = barLayout([0, 400, 800], box);
    expect(scale.max).toBe(800);
    expect(base).toBe(190);
    expect(bars[0].h).toBe(0);
    expect(bars[2].y).toBe(20);
    expect(bars[1].h).toBeCloseTo(85, 5);
    expect(bars[1].cx).toBeCloseTo(300, 5);
    expect(yOf(-5, scale, box)).toBe(190);
  });

  it('labels months, with the year on January and the first', () => {
    expect(monthLabel('2026-11')).toBe('Nov');
    expect(monthLabel('2026-01')).toBe('Jan 2026');
    expect(monthLabel('2025-07', true)).toBe('Jul 2025');
    expect(labelEvery(12)).toBe(1);
    expect(labelEvery(36)).toBeGreaterThan(3);
  });

  it('works out about a month from the first month with anything, not counting this one', () => {
    const now = new Date(2026, 10, 15).getTime();
    const m = [
      { month: '2026-08', total: 0, count: 0 },
      { month: '2026-09', total: 600, count: 10 },
      { month: '2026-10', total: 500, count: 9 },
      { month: '2026-11', total: 100, count: 2 },
    ];
    expect(perMonth(m, now)).toBe(550);
    expect(perMonth([{ month: '2026-11', total: 80, count: 1 }], now)).toBe(80);
    expect(perMonth([{ month: '2026-11', total: 0, count: 0 }], now)).toBeUndefined();
  });

  it('takes the cheapest shop each week, and says how often it goes on special', () => {
    const pts = cheapestByWeek([
      { week: '2026-01-07', chain: 'coles', price: 32, special: false },
      { week: '2026-01-07', chain: 'woolworths', price: 30, special: false },
      { week: '2026-02-04', chain: 'coles', price: 24, special: true },
      { week: '2026-02-11', chain: 'coles', price: 32, special: false },
      { week: '2026-06-03', chain: 'woolworths', price: 22.5, special: true },
    ]);
    expect(pts.map((p) => [p.week, p.price, p.chain])).toEqual([
      ['2026-01-07', 30, 'woolworths'],
      ['2026-02-04', 24, 'coles'],
      ['2026-02-11', 32, 'coles'],
      ['2026-06-03', 22.5, 'woolworths'],
    ]);
    expect(specialEvery(pts)).toBe('about every 4 months');
    expect(specialEvery(pts.slice(0, 2))).toBeUndefined();
  });

  it('shares add up to 100, and sizes read plainly', () => {
    expect(shares([3255, 2194, 1203, 283, 141])).toEqual([46, 31, 17, 4, 2]);
    expect(shares([1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(shares([0, 0])).toEqual([0, 0]);
    expect(bytesText(0)).toBe('0 KB');
    expect(bytesText(500)).toBe('1 KB');
    expect(bytesText(186 * 1024 * 1024)).toBe('186 MB');
    expect(bytesText(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(moneyShort(7076.4)).toBe('$7,076');
    expect(moneyShort(22.5)).toBe('$22.50');
    expect(moneyShort(24)).toBe('$24');
  });

  it("splits the storage bar by kind, a sliver for small ones, and what isn't a kind last-ish", () => {
    const parts = storageParts(
      { kinds: { prices: { bytes: 900 }, receipts: { bytes: 0 }, logs: { bytes: 1 } } as unknown as DataSummary['kinds'], other: 99 },
      { prices: 'Price history' },
    );
    expect(parts.map((p) => p.key)).toEqual(['prices', 'other', 'logs', 'receipts']);
    expect(parts.find((p) => p.key === 'logs')!.pct).toBeGreaterThan(0.9);
    expect(parts.find((p) => p.key === 'receipts')!.pct).toBe(0);
    expect(parts.reduce((a, p) => a + p.pct, 0)).toBeCloseTo(100, 6);
  });
});

describe('the two checks', () => {
  const at2 = (s: Partial<Steps> = {}): Steps => ({ ...firstStep(), step: 2, ...s });

  it("can't skip Step 1: Delete does nothing there, even with the word and passphrase typed", () => {
    const s = { ...firstStep(), typed: 'DELETE', pass: 'pass phrase' };
    expect(canDelete(s, 'DELETE')).toBe(false);
    expect(stepReducer(s, { t: 'start', word: 'DELETE' })).toBe(s);
    const two = stepReducer(s, { t: 'continue' });
    expect(two.step).toBe(2);
    expect(stepReducer(two, { t: 'start', word: 'DELETE' }).busy).toBe(true);
  });

  it('a wrong word blocks Delete; capitals count, spaces around it do not', () => {
    for (const typed of ['delete', 'DELET', 'DELETE EVERYTHING', '']) expect(canDelete(at2({ typed, pass: 'x' }), 'DELETE'), typed).toBe(false);
    expect(canDelete(at2({ typed: ' DELETE ', pass: 'x' }), 'DELETE')).toBe(true);
    expect(canDelete(at2({ typed: 'DELETE', pass: '' }), 'DELETE')).toBe(false);
    expect(canDelete(at2({ typed: 'DELETE', pass: 'x' }), 'DELETE EVERYTHING')).toBe(false);
    expect(canDelete(at2({ typed: 'DELETE EVERYTHING', pass: 'x' }), 'DELETE EVERYTHING')).toBe(true);
    const s = at2({ typed: 'DELET', pass: 'x' });
    expect(stepReducer(s, { t: 'start', word: 'DELETE' })).toBe(s);
  });

  it("a refusal says why and keeps what was typed; Back keeps it too; it can't go twice", () => {
    let s = stepReducer(at2({ typed: 'DELETE', pass: 'wrong one' }), { t: 'start', word: 'DELETE' });
    expect(stepReducer(s, { t: 'start', word: 'DELETE' })).toBe(s);
    expect(stepReducer(s, { t: 'back' })).toBe(s);
    s = stepReducer(s, { t: 'fail', error: "That isn't your passphrase. Nothing was deleted." });
    expect(s).toMatchObject({ step: 2, busy: false, typed: 'DELETE', pass: 'wrong one', error: "That isn't your passphrase. Nothing was deleted." });
    s = stepReducer(s, { t: 'pass', v: 'right one' });
    expect(s.error).toBeUndefined();
    s = stepReducer(s, { t: 'back' });
    expect(s).toMatchObject({ step: 1, typed: 'DELETE', pass: 'right one' });
  });

  const summary: DataSummary = {
    kinds: {
      prices: { count: 18420, products: 214, archives: 3, oldest: '2024-11-02T00:00:00.000Z', bytes: 92 * 1024 * 1024 },
      receipts: { count: 412, pinned: 2, photos: 380, oldest: '2024-11-05T00:00:00.000Z', bytes: 61 * 1024 * 1024 },
      stats: { count: 3000, oldest: '2025-12-01T00:00:00.000Z', bytes: 12 * 1024 * 1024 },
      logs: { count: 6210, activity: 400, oldest: '2026-10-01T00:00:00.000Z', bytes: 9 * 1024 * 1024 },
      backups: { count: 3, folders: 1, oldest: '2026-11-08T00:00:00.000Z', bytes: 12 * 1024 * 1024, nightly: false, keptDays: 30 },
    },
    total: 190 * 1024 * 1024,
    other: 4 * 1024 * 1024,
    database: 100,
    files: 100,
    measured: 'dbstat',
    disk: { free: 412 * 1024 ** 3, size: 1000 * 1024 ** 3 },
    autoDelete: { months: null, cutoff: null },
    resend: { at: null, next: null },
    at: '2026-11-10T00:00:00.000Z',
  };

  it('Step 1 gives exact counts when all of a kind goes (newest prices and pinned receipts stay)', () => {
    const one = stepOne(summary, ['prices', 'receipts', 'stats', 'logs', 'backups'], null);
    expect(one.goes[0]).toBe('18,206 older prices. The newest price of each of the 214 products stays.');
    expect(one.goes[1]).toBe('410 receipts and their photos. Pinned receipts (2) stay.');
    expect(one.goes[2]).toContain('3,000 ticked items');
    expect(one.goes[3]).toBe('6,210 activity and log entries.');
    expect(one.goes[4]).toContain('3 deleted files');
    expect(stepTwo(one, null)).toEqual({ line: "About 186 MB of your household's history will be gone for everyone on this server.", action: 'Delete 186 MB' });
  });

  it('Step 1 with a date says what is there now, and which kinds lose nothing', () => {
    const one = stepOne(summary, ['prices', 'stats', 'logs'], '2025-11-10T00:00:00.000Z');
    expect(one.goes).toHaveLength(1);
    expect(one.goes[0]).toContain('Prices from before 10 Nov 2025 (there are 18,420 now, the oldest from Nov 2024)');
    expect(one.none).toEqual(['Nothing ticked off is that old.', 'No activity or logs are that old.']);
    expect(one.bytes).toBeUndefined();
    expect(stepTwo(one, '2025-11-10T00:00:00.000Z').action).toBe('Delete older data');
  });
});

describe('the period buttons', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('are 3 months · 6 months · 12 months · All, 12 months unless one was picked', () => {
    expect(PERIODS.map((p) => p.label)).toEqual(['3 months', '6 months', '12 months', 'All']);
    expect(readPeriod(null)).toBe(12);
    expect(readPeriod('3')).toBe(3);
    expect(readPeriod('all')).toBe('all');
    expect(readPeriod('7')).toBe(12);
  });

  it('ask the server for that period, and an older server says it needs updating', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(String(url));
        if (String(url).includes('summary')) return new Response(JSON.stringify({ error: 'not-found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ period: 3 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    for (const p of PERIODS) await data.stats(p.value);
    await data.top('all', 20, 10);
    await data.series('i-milk&x', 6);
    expect(asked).toEqual([
      '/api/v3/data/stats?period=3',
      '/api/v3/data/stats?period=6',
      '/api/v3/data/stats?period=12',
      '/api/v3/data/stats?period=all',
      '/api/v3/data/top?period=all&offset=20&limit=10',
      '/api/v3/data/series?item=i-milk%26x&period=6',
    ]);
    expect(periodParam('all')).toBe('all');
    await expect(data.summary()).rejects.toThrow(OLD_SERVER);
  });
});
