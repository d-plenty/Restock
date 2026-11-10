// 0.9.5: the Data tab's downloads, built in the browser from the server's restock-export answer:
// - a spreadsheet (.xlsx): minimal SpreadsheetML, one sheet per table, inline strings, real numbers,
//   and dates as Excel dates (local time) so they sort and filter as dates;
// - CSV: one file per table (a zip of them when there are several), UTF-8 with a BOM so Excel reads
//   the accents, and text that a spreadsheet would run as a formula made safe;
// - the full export file: the restock-export JSON, pretty, with every page in it.
// Nothing here talks to the server: it only shapes rows into files.
import { strToU8, zipSync } from 'fflate';

export type Cell = string | number | boolean | null | undefined;
export interface Table {
  name: string;
  /** Column order (the keys of the rows); left out: every key, in the order first seen. */
  columns?: string[];
  rows: Record<string, unknown>[];
}

/** Every key of the rows, in the order first seen. */
export function columnsOf(rows: Record<string, unknown>[], max = 200): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (seen.size >= max) break;
      seen.add(k);
    }
  }
  return [...seen];
}

/** A value as one cell: objects and arrays as JSON text. */
export function cellOf(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------- dates ----------

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** 'date' for "2026-11-10", 'time' for an ISO date and time, else undefined. */
export function dateKind(v: unknown): 'date' | 'time' | undefined {
  if (typeof v !== 'string' || v.length > 40) return undefined;
  if (DATE_ONLY.test(v)) return 'date';
  if (DATE_TIME.test(v) && Number.isFinite(Date.parse(v))) return 'time';
  return undefined;
}

const EPOCH = Date.UTC(1899, 11, 30);
/**
 * An Excel date serial (days since 30 Dec 1899) for a date or ISO time. A date stays that calendar
 * day; a time is shown in this computer's time zone (a spreadsheet has none), to the second.
 */
export function excelSerial(v: string): number | undefined {
  const d = DATE_ONLY.exec(v);
  if (d) return (Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])) - EPOCH) / 86_400_000;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return undefined;
  const local = new Date(t);
  const asUtc = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds());
  return Math.round(((asUtc - EPOCH) / 86_400_000) * 86_400) / 86_400;
}

// ---------- CSV ----------

/** A spreadsheet runs text starting = + - @ (or a tab or return) as a formula: a ' in front stops it. */
const FORMULA = /^[=+\-@\t\r]/;

export function csvField(v: unknown): string {
  const c = cellOf(v);
  if (c === null || c === undefined) return '';
  if (typeof c === 'number') return String(c);
  if (typeof c === 'boolean') return c ? 'true' : 'false';
  const s = FORMULA.test(c) ? `'${c}` : c;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One table as CSV text: a header row, then the rows, CRLF line ends (RFC 4180). */
export function csvOf(t: Table): string {
  const cols = t.columns ?? columnsOf(t.rows);
  const lines = [cols.map(csvField).join(',')];
  for (const r of t.rows) lines.push(cols.map((c) => csvField(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const withBom = (s: string) => {
  const b = strToU8(s);
  const out = new Uint8Array(BOM.length + b.length);
  out.set(BOM);
  out.set(b, BOM.length);
  return out;
};

/** A file name part: letters, digits, - and _ only. */
export const safeName = (s: string) =>
  s
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'table';

/** One CSV file (one table), or a zip of one CSV per table. */
export function csvFiles(tables: Table[], base: string): { name: string; bytes: Uint8Array; type: string } {
  if (tables.length === 1) return { name: `${base}.csv`, bytes: withBom(csvOf(tables[0])), type: 'text/csv;charset=utf-8' };
  const files: Record<string, Uint8Array> = {};
  for (const t of tables) {
    let n = `${safeName(t.name)}.csv`;
    for (let i = 2; files[n]; i++) n = `${safeName(t.name)}-${i}.csv`;
    files[n] = withBom(csvOf(t));
  }
  return { name: `${base}-csv.zip`, bytes: zipSync(files, { level: 6, mtime: new Date() }), type: 'application/zip' };
}

// ---------- the spreadsheet (.xlsx) ----------

/** Text Excel will take in XML: & < > " escaped, and characters XML can't hold left out. */
export function xmlText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '').replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

/** A, B, … Z, AA, AB … for column 0, 1, … */
export function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A sheet name Excel takes: no : \ / ? * [ ], at most 31 characters, not empty, and not used already. */
export function sheetName(name: string, used: Set<string>): string {
  const base = (
    name
      .replace(/[:\\/?*[\]]/g, ' ')
      .replace(/^'+|'+$/g, '')
      .trim() || 'Sheet'
  ).slice(0, 31);
  let n = base;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
  used.add(n.toLowerCase());
  return n;
}

/** Excel's cap on rows a sheet (the header takes one); longer tables are cut there. */
export const MAX_ROWS = 1_048_575;
/** Excel's cap on characters in a cell. */
const MAX_CELL = 32_767;

// Styles: 0 plain, 1 bold (the header), 2 a date (d mmm yyyy), 3 a date and time (d mmm yyyy h:mm).
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="d mmm yyyy"/><numFmt numFmtId="165" formatCode="d mmm yyyy h:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellXml(ref: string, v: unknown, header = false): string {
  const c = cellOf(v);
  if (c === null || c === undefined || c === '') return '';
  if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
  if (typeof c === 'boolean') return `<c r="${ref}" t="b"><v>${c ? 1 : 0}</v></c>`;
  if (!header) {
    const k = dateKind(c);
    const serial = k ? excelSerial(c) : undefined;
    if (k && serial !== undefined && serial > 0) return `<c r="${ref}" s="${k === 'date' ? 2 : 3}"><v>${serial}</v></c>`;
  }
  const text = xmlText(c.length > MAX_CELL ? c.slice(0, MAX_CELL) : c);
  return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${text}</t></is></c>`;
}

/** One sheet's XML: the header row (bold, frozen), then the rows. */
export function sheetXml(t: Table): string {
  const cols = t.columns ?? columnsOf(t.rows);
  const rows = t.rows.length > MAX_ROWS ? t.rows.slice(0, MAX_ROWS) : t.rows;
  const parts: string[] = [];
  parts.push(`<row r="1">${cols.map((c, i) => cellXml(`${colName(i)}1`, c, true)).join('')}</row>`);
  rows.forEach((r, n) => {
    const at = n + 2;
    parts.push(`<row r="${at}">${cols.map((c, i) => cellXml(`${colName(i)}${at}`, r[c])).join('')}</row>`);
  });
  const widths = cols.map((c, i) => {
    let w = c.length;
    for (const r of rows.slice(0, 200)) {
      const v = cellOf(r[c]);
      const len = v === null || v === undefined ? 0 : dateKind(v) ? 16 : String(v).length;
      if (len > w) w = len;
    }
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, w + 2))}" customWidth="1"/>`;
  });
  const dim = cols.length ? `<dimension ref="A1:${colName(Math.max(0, cols.length - 1))}${rows.length + 1}"/>` : '';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    dim +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    (widths.length ? `<cols>${widths.join('')}</cols>` : '') +
    `<sheetData>${parts.join('')}</sheetData>` +
    '</worksheet>'
  );
}

/** The workbook: one sheet per table, as .xlsx bytes (a zip). */
export function xlsxOf(tables: Table[]): Uint8Array {
  const list = tables.length ? tables : [{ name: 'Empty', rows: [] }];
  const used = new Set<string>();
  const names = list.map((t) => sheetName(t.name, used));
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, xml: string) => (files[path] = strToU8(xml));
  put(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      names
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('') +
      '</Types>',
  );
  put(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>',
  );
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  put(
    'docProps/core.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>Restock data</dc:title><dc:creator>Restock</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`,
  );
  put(
    'docProps/app.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Restock</Application></Properties>',
  );
  put(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>',
  );
  put(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      names
        .map(
          (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
  );
  put('xl/styles.xml', STYLES);
  list.forEach((t, i) => put(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(t)));
  return zipSync(files, { level: 6, mtime: new Date() });
}

// ---------- the restock-export, as tables ----------

/** What each table of the export is called in a spreadsheet, in this order. */
const TABLE_NAMES: [string, string][] = [
  ['spending', 'Spending by month'],
  ['ticked', 'Ticked off'],
  ['items', 'Items'],
  ['products', 'Products'],
  ['prices', 'Prices'],
  ['list', 'Shopping list'],
  ['categories', 'Categories'],
  ['receipts', 'Receipts'],
  ['shops', 'Shops'],
  ['aliases', 'Words for items'],
  ['settings', 'Settings'],
];

/** The export's tables as spreadsheet tables (settings, an object, as rows of setting and value). */
export function exportTables(exp: { tables: Record<string, unknown> }): Table[] {
  const out: Table[] = [];
  const known = new Set(TABLE_NAMES.map(([k]) => k));
  const keys = [...TABLE_NAMES.map(([k]) => k).filter((k) => k in exp.tables), ...Object.keys(exp.tables).filter((k) => !known.has(k))];
  for (const k of keys) {
    const v = exp.tables[k];
    const name = TABLE_NAMES.find(([t]) => t === k)?.[1] ?? k;
    if (Array.isArray(v)) out.push({ name, rows: v.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)) });
    else if (v && typeof v === 'object') out.push({ name, columns: ['setting', 'value'], rows: Object.entries(v).map(([setting, value]) => ({ setting, value })) });
  }
  return out;
}

/** "restock-data-2026-11-10" (this computer's day). */
export function fileBase(what = 'data', at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `restock-${what}-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Hands the browser a file to save. */
export function saveFile(bytes: Uint8Array | string, name: string, type: string): void {
  const blob = new Blob([typeof bytes === 'string' ? bytes : (bytes as BlobPart)], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
