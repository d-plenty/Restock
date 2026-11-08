import {
  DEFAULT_SETTINGS,
  type Category,
  type Chain,
  type Group,
  type ListEntry,
  type ListProduct,
  type LoyaltyCard,
  type PriceReading,
  type Product,
  type Receipt,
  type Settings,
} from '../types';
import { changed } from './live';
import { DEFAULT_SECTION_CATEGORIES, SECTIONS, setCustomShops, shopDef, type Section } from '../shops';
import type { SqlDriver, SqlOp, SqlValue } from './sql/driver';
import { migrate } from './sql/schema';
import { toPicks } from './picks';

// All reads and writes to the on-device SQLite database go through this file.

let driver: SqlDriver | undefined;

export async function initDb(d: SqlDriver): Promise<void> {
  driver = d;
  await migrate(d);
}

/** Use a database without upgrading it yet (to back it up first, 0.8.0). */
export function useDriver(d: SqlDriver): void {
  driver = d;
}

function sql(): SqlDriver {
  if (!driver) throw new Error('Database not ready');
  return driver;
}

async function write(ops: SqlOp[]): Promise<void> {
  if (!ops.length) return;
  if (ops.length === 1) await sql().run(ops[0].sql, ops[0].params);
  else await sql().batch(ops);
  changed();
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const nowIso = () => new Date().toISOString();

const b = (v: boolean) => (v ? 1 : 0);
const n = <T>(v: T | undefined | null): T | null => (v === undefined ? null : v);
const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);
const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(',');

// ---------- row mapping ----------

type Row = Record<string, unknown>;

const toProduct = (r: Row): Product => ({
  id: r.id as string,
  chain: r.chain as Chain,
  name: r.name as string,
  brand: opt(r.brand as string | null),
  size: opt(r.size as string | null),
  barcode: opt(r.barcode as string | null),
  storeProductId: opt(r.store_product_id as string | null),
  imageUrl: opt(r.image_url as string | null),
  qty: opt(r.qty as number | null),
  qtyUnit: opt(r.qty_unit as Product['qtyUnit'] | null),
  inStock: r.in_stock === null || r.in_stock === undefined ? undefined : Number(r.in_stock) === 1,
  stockAt: opt(r.stock_at as string | null),
  inStock2: r.in_stock_2 === null || r.in_stock_2 === undefined ? undefined : Number(r.in_stock_2) === 1,
  createdAt: r.created_at as string,
});

const toGroup = (r: Row): Group => ({
  id: r.id as string,
  name: r.name as string,
  categoryId: opt(r.category_id as string | null),
  usualProductId: opt(r.usual_product_id as string | null),
  sameProductIds: JSON.parse((r.same_product_ids as string) || '[]'),
  altProductIds: JSON.parse((r.alt_product_ids as string) || '[]'),
  alertPct: opt(r.threshold_pct as number | null),
  alertLevel: (r.alert_level as Group['alertLevel']) ?? 'good',
  allowBulk: r.allow_bulk === undefined || r.allow_bulk === null ? undefined : Number(r.allow_bulk) === 1,
  allowMulti: r.allow_multi === undefined || r.allow_multi === null ? undefined : Number(r.allow_multi) === 1,
  targetPrice: r.target_price === undefined || r.target_price === null ? undefined : Number(r.target_price),
  section: asSection(r.section),
  anySize: Number(r.any_size ?? 0) === 1,
  notAt: JSON.parse((r.not_at as string) || '[]'),
  createdAt: r.created_at as string,
});

const asSection = (v: unknown): Section => (v === 'keg' || v === 'pharmacy' ? v : 'pantry');

const toReading = (r: Row): PriceReading => ({
  id: r.id as number,
  productId: r.product_id as string,
  date: r.date as string,
  price: Number(r.price),
  wasPrice: opt(r.was_price as number | null),
  isSpecial: Number(r.is_special) === 1,
  memberOnly: Number(r.member_only) === 1,
  promo: opt(r.promo as string | null),
  source: r.source as PriceReading['source'],
});

const toEntry = (r: Row): ListEntry => ({
  id: r.id as string,
  text: r.text as string,
  groupId: opt(r.item_id as string | null),
  chain: opt(r.chain as Chain | null),
  categoryId: opt(r.category_id as string | null),
  qty: Math.max(1, Number(r.qty ?? 1) || 1),
  price: r.price === null || r.price === undefined ? undefined : Number(r.price),
  section: r.section === null || r.section === undefined ? undefined : asSection(r.section),
  product: parseListProduct(r.product),
  checked: Number(r.checked) === 1,
  createdAt: r.created_at as string,
});

function parseListProduct(v: unknown): ListProduct | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  try {
    const p = JSON.parse(v) as ListProduct;
    return p && typeof p.name === 'string' && typeof p.chain === 'string' ? p : undefined;
  } catch {
    return undefined;
  }
}

const toCard = (r: Row): LoyaltyCard => ({
  id: r.id as string,
  program: r.program as LoyaltyCard['program'],
  label: r.label as string,
  number: r.number as string,
  createdAt: r.created_at as string,
});

const toReceipt = (r: Row): Receipt => ({
  id: r.id as string,
  scannedAt: r.scanned_at as string,
  shop: (r.shop as string | null) ?? undefined,
  chain: (r.chain as Chain | null) ?? undefined,
  receiptDate: (r.receipt_date as string | null) ?? undefined,
  total: r.total === null || r.total === undefined ? undefined : Number(r.total),
  section: asSection(r.section),
  note: (r.note as string | null) ?? undefined,
  text: (r.text as string | null) ?? undefined,
  photo: (r.photo as string | null) ?? undefined,
  pages: parsePages(r.pages),
  pinned: Number(r.pinned) === 1,
});

function parsePages(v: unknown): string[] | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  try {
    const list = JSON.parse(v) as unknown;
    return Array.isArray(list) && list.length ? list.filter((x): x is string => typeof x === 'string') : undefined;
  } catch {
    return undefined;
  }
}

const toCategory = (r: Row): Category => ({ id: r.id as string, name: r.name as string, order: Number(r.ord), section: asSection(r.section) });

// ---------- insert statements ----------

export const insertProductOp = (p: Product, replace = false): SqlOp => ({
  sql: `INSERT ${replace ? 'OR REPLACE ' : ''}INTO products (id, chain, name, brand, size, barcode, store_product_id, image_url, qty, qty_unit, in_stock, stock_at, in_stock_2, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  params: [
    p.id,
    p.chain,
    p.name,
    n(p.brand),
    n(p.size),
    n(p.barcode),
    n(p.storeProductId),
    n(p.imageUrl),
    n(p.qty),
    n(p.qtyUnit),
    p.inStock === undefined ? null : b(p.inStock),
    n(p.stockAt),
    p.inStock2 === undefined ? null : b(p.inStock2),
    p.createdAt,
  ],
});

export const insertGroupOp = (g: Group, replace = false): SqlOp => ({
  sql: `INSERT ${replace ? 'OR REPLACE ' : ''}INTO items (id, name, category_id, usual_product_id, same_product_ids, alt_product_ids, threshold_pct, alert_level, allow_bulk, allow_multi, section, target_price, any_size, not_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  params: [
    g.id,
    g.name,
    n(g.categoryId),
    n(g.usualProductId),
    JSON.stringify(g.sameProductIds),
    JSON.stringify(g.altProductIds),
    n(g.alertPct),
    g.alertLevel,
    g.allowBulk === false ? 0 : 1,
    g.allowMulti === false ? 0 : 1,
    g.section ?? 'pantry',
    n(g.targetPrice),
    g.anySize ? 1 : 0,
    g.notAt?.length ? JSON.stringify(g.notAt) : null,
    g.createdAt,
  ],
});

export const insertReadingOp = (r: Omit<PriceReading, 'id'>): SqlOp => ({
  sql: `INSERT INTO prices (product_id, date, price, was_price, is_special, member_only, promo, source) VALUES (?,?,?,?,?,?,?,?)`,
  params: [r.productId, r.date, r.price, n(r.wasPrice), b(r.isSpecial), b(r.memberOnly), n(r.promo), r.source],
});

export const insertEntryOp = (e: ListEntry, replace = false): SqlOp => ({
  sql: `INSERT ${replace ? 'OR REPLACE ' : ''}INTO list_entries (id, text, item_id, chain, category_id, qty, price, section, product, checked, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  params: [
    e.id,
    e.text,
    n(e.groupId),
    n(e.chain),
    n(e.categoryId),
    Math.max(1, e.qty ?? 1),
    n(e.price),
    n(e.section),
    e.product ? JSON.stringify(e.product) : null,
    b(e.checked),
    e.createdAt,
  ],
});

const insertCardOp = (c: LoyaltyCard): SqlOp => ({
  sql: `INSERT INTO cards (id, program, label, number, created_at) VALUES (?,?,?,?,?)`,
  params: [c.id, c.program, c.label, c.number, c.createdAt],
});

export const insertReceiptOp = (r: Receipt): SqlOp => ({
  sql: `INSERT OR REPLACE INTO receipts (id, scanned_at, shop, chain, receipt_date, total, section, note, text, photo, pages, pinned) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  params: [
    r.id,
    r.scannedAt,
    n(r.shop),
    n(r.chain),
    n(r.receiptDate),
    n(r.total),
    r.section,
    n(r.note),
    n(r.text),
    n(r.photo),
    r.pages?.length ? JSON.stringify(r.pages) : null,
    b(r.pinned),
  ],
});

const insertCategoryOp = (c: Category): SqlOp => ({
  sql: `INSERT INTO categories (id, name, ord, section) VALUES (?,?,?,?)`,
  params: [c.id, c.name, c.order, c.section ?? 'pantry'],
});

/** Builds "UPDATE table SET a = ?, b = ? WHERE id = ?" from a patch, mapping field names to columns. */
function updateOp(table: string, id: string, patch: Record<string, unknown>, columns: Record<string, string>): SqlOp | undefined {
  const sets: string[] = [];
  const params: SqlValue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = columns[key];
    if (!col) continue;
    sets.push(`${col} = ?`);
    if (Array.isArray(value)) params.push(JSON.stringify(value));
    else if (typeof value === 'boolean') params.push(b(value));
    else params.push(value === undefined ? null : (value as SqlValue));
  }
  if (!sets.length) return undefined;
  return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, params: [...params, id] };
}

// ---------- key/value + settings ----------

export async function getKV<T>(key: string): Promise<T | undefined> {
  const [row] = await sql().query<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]);
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export async function putKV(key: string, value: unknown): Promise<void> {
  await write([{ sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', params: [key, JSON.stringify(value)] }]);
}

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    stores: { ...DEFAULT_SETTINGS.stores, ...(s.stores ?? {}) },
    alerts: { ...DEFAULT_SETTINGS.alerts, ...(s.alerts ?? {}) },
    sync: { ...DEFAULT_SETTINGS.sync, ...(s.sync ?? {}) },
    household: { ...DEFAULT_SETTINGS.household, ...(s.household ?? {}) },
    marketData: { ...DEFAULT_SETTINGS.marketData, ...(s.marketData ?? {}) },
    sections: { ...DEFAULT_SETTINGS.sections, ...(s.sections ?? {}) },
    look: { ...DEFAULT_SETTINGS.look, ...(s.look ?? {}) },
    a11y: { ...DEFAULT_SETTINGS.a11y, ...(s.a11y ?? {}) },
    setup: { ...DEFAULT_SETTINGS.setup, ...(s.setup ?? {}) },
    tour: { ...DEFAULT_SETTINGS.tour, ...(s.tour ?? {}) },
    receipts: { ...DEFAULT_SETTINGS.receipts, ...(s.receipts ?? {}) },
    recalls: { ...DEFAULT_SETTINGS.recalls, ...(s.recalls ?? {}) },
    autoBackup: { ...DEFAULT_SETTINGS.autoBackup, ...(s.autoBackup ?? {}) },
    cartPush: { ...DEFAULT_SETTINGS.cartPush, ...(s.cartPush ?? {}) },
    widgets: { ...DEFAULT_SETTINGS.widgets, ...(s.widgets ?? {}) },
    customShops: Array.isArray(s.customShops) ? s.customShops : [],
    seenHints: Array.isArray(s.seenHints) ? s.seenHints : DEFAULT_SETTINGS.seenHints,
  };
}

/** The settings as last read or saved, for wording that can't wait for the database (stock: "online" or "at Coles Kirwan"). */
let lastSettings: Settings | undefined;
export const cachedSettings = () => lastSettings;

export async function getSettings(): Promise<Settings> {
  const s = mergeSettings(await getKV<Partial<Settings>>('settings'));
  setCustomShops(s.customShops);
  lastSettings = s;
  return s;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = mergeSettings({ ...(await getSettings()), ...patch });
  setCustomShops(next.customShops);
  await putKV('settings', next);
  lastSettings = next;
  return next;
}

// ---------- seed ----------

export async function ensureDefaults(): Promise<void> {
  // Each tab gets its starting categories the first time (Pantry's on a new phone, Keg's and
  // Pharmacy's on the first open after updating).
  const have = await sql().query<{ section: string; c: number }>('SELECT section, COUNT(*) AS c FROM categories GROUP BY section');
  const ops: SqlOp[] = [];
  for (const section of SECTIONS) {
    if (have.some((h) => h.section === section && Number(h.c) > 0)) continue;
    const seeded = `categoriesSeeded:${section}`;
    if (section !== 'pantry' && (await getKV<boolean>(seeded))) continue;
    DEFAULT_SECTION_CATEGORIES[section].forEach((name, order) => ops.push(insertCategoryOp({ id: uid(), name, order, section })));
    if (section !== 'pantry') ops.push({ sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', params: [seeded, 'true'] });
  }
  if (ops.length) await write(ops);
}

// ---------- products ----------

const PRODUCT_COLS = {
  name: 'name',
  brand: 'brand',
  size: 'size',
  barcode: 'barcode',
  imageUrl: 'image_url',
  qty: 'qty',
  qtyUnit: 'qty_unit',
  inStock: 'in_stock',
  stockAt: 'stock_at',
  inStock2: 'in_stock_2',
};

export async function getProduct(id: string): Promise<Product | undefined> {
  const [r] = await sql().query('SELECT * FROM products WHERE id = ?', [id]);
  return r ? toProduct(r) : undefined;
}

export async function getProducts(ids: string[]): Promise<Product[]> {
  if (!ids.length) return [];
  const products = (await sql().query(`SELECT * FROM products WHERE id IN (${placeholders(ids.length)})`, ids)).map(toProduct);
  return attachMarket(products);
}

/** Adds shared price history to products that have it (see MarketSummary). */
async function attachMarket(products: Product[]): Promise<Product[]> {
  const keyed = products.filter((p) => p.storeProductId && p.chain !== 'other');
  if (!keyed.length) return products;
  const rows = await sql().query(
    `SELECT * FROM market WHERE store_product_id IN (${placeholders(keyed.length)})`,
    keyed.map((p) => p.storeProductId!),
  );
  if (!rows.length) return products;
  const byKey = new Map(rows.map((r) => [`${r.chain}:${r.store_product_id}`, r]));
  return products.map((p) => {
    const r = byKey.get(`${p.chain}:${p.storeProductId}`);
    if (!r) return p;
    const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
    return {
      ...p,
      market: {
        normal: Number(r.normal),
        sale: n(r.sale),
        saleShare: Number(r.sale_share),
        low: Number(r.low),
        cycleWeeks: n(r.cycle_weeks),
        latest: n(r.latest),
        days: Number(r.days),
        source: String(r.source),
        updatedAt: String(r.updated_at),
      },
    };
  });
}

/** How much shared price history is on the phone. */
export async function marketStatus(): Promise<{ count: number; updatedAt?: string; byChain: Record<string, number> }> {
  const rows = await sql().query<{ chain: string; n: number; u: string | null }>(
    'SELECT chain, COUNT(*) AS n, MAX(updated_at) AS u FROM market GROUP BY chain',
  );
  const byChain: Record<string, number> = {};
  let count = 0;
  let updatedAt: string | undefined;
  for (const r of rows) {
    byChain[r.chain] = Number(r.n);
    count += Number(r.n);
    if (r.u && (!updatedAt || r.u > updatedAt)) updatedAt = r.u;
  }
  return { count, updatedAt, byChain };
}

export async function clearMarket(): Promise<void> {
  await write([{ sql: 'DELETE FROM market' }]);
}

export async function allProducts(): Promise<Product[]> {
  return (await sql().query('SELECT * FROM products')).map(toProduct);
}

export async function findProductByStore(chain: Chain, storeProductId: string): Promise<Product | undefined> {
  const [r] = await sql().query('SELECT * FROM products WHERE chain = ? AND store_product_id = ? LIMIT 1', [chain, storeProductId]);
  return r ? toProduct(r) : undefined;
}

export async function findProductByBarcode(barcode: string): Promise<Product | undefined> {
  const [r] = await sql().query('SELECT * FROM products WHERE barcode = ? LIMIT 1', [barcode]);
  return r ? toProduct(r) : undefined;
}

export async function addProduct(p: Product): Promise<void> {
  await write([insertProductOp(p)]);
}

export async function updateProduct(id: string, patch: Partial<Product>): Promise<void> {
  const op = updateOp('products', id, patch, PRODUCT_COLS);
  if (op) await write([op]);
}

export async function deleteProducts(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const ph = placeholders(ids.length);
  await write([
    { sql: `DELETE FROM prices WHERE product_id IN (${ph})`, params: ids },
    { sql: `DELETE FROM products WHERE id IN (${ph})`, params: ids },
  ]);
}

// ---------- items (pantry groups) ----------

const GROUP_COLS = {
  name: 'name',
  categoryId: 'category_id',
  usualProductId: 'usual_product_id',
  sameProductIds: 'same_product_ids',
  altProductIds: 'alt_product_ids',
  alertPct: 'threshold_pct',
  alertLevel: 'alert_level',
  allowBulk: 'allow_bulk',
  allowMulti: 'allow_multi',
  section: 'section',
  targetPrice: 'target_price',
  anySize: 'any_size',
  notAt: 'not_at',
};

/** Product ids an item uses: yours, the same product at other shops, and alternatives. */
export function groupProductIds(g: Group): string[] {
  return [g.usualProductId, ...(g.sameProductIds ?? []), ...(g.altProductIds ?? [])].filter((x): x is string => !!x);
}

export async function getGroup(id: string): Promise<Group | undefined> {
  const [r] = await sql().query('SELECT * FROM items WHERE id = ?', [id]);
  return r ? toGroup(r) : undefined;
}

export async function allGroups(): Promise<Group[]> {
  return (await sql().query('SELECT * FROM items ORDER BY name COLLATE NOCASE')).map(toGroup);
}

export async function addGroup(g: Group): Promise<void> {
  await write([insertGroupOp(g)]);
}

export async function updateGroup(id: string, patch: Partial<Group>): Promise<void> {
  const op = updateOp('items', id, patch, GROUP_COLS);
  if (op) await write([op]);
}

/** Delete a pantry item and any of its products no other item uses. */
export async function deleteGroup(groupId: string): Promise<void> {
  const group = await getGroup(groupId);
  if (!group) return;
  const others = (await allGroups()).filter((g) => g.id !== groupId);
  const stillUsed = new Set(others.flatMap(groupProductIds));
  const orphans = groupProductIds(group).filter((id) => !stillUsed.has(id));
  const ops: SqlOp[] = [
    { sql: 'DELETE FROM items WHERE id = ?', params: [groupId] },
    { sql: 'UPDATE list_entries SET item_id = NULL WHERE item_id = ?', params: [groupId] },
  ];
  if (orphans.length) {
    const ph = placeholders(orphans.length);
    ops.push({ sql: `DELETE FROM prices WHERE product_id IN (${ph})`, params: orphans });
    ops.push({ sql: `DELETE FROM products WHERE id IN (${ph})`, params: orphans });
  }
  await write(ops);
}

/** Remove one product from an item; delete it if nothing else uses it. */
export async function removeProductFromGroup(group: Group, productId: string): Promise<void> {
  let { usualProductId } = group;
  let same = group.sameProductIds.filter((x) => x !== productId);
  let alts = group.altProductIds.filter((x) => x !== productId);
  if (usualProductId === productId) {
    // The next pick becomes the usual one. One you'd only also take never does (0.8.9).
    usualProductId = same[0];
    same = same.filter((x) => x !== usualProductId);
  }
  const ops: SqlOp[] = [updateOp('items', group.id, { usualProductId, sameProductIds: same, altProductIds: alts }, GROUP_COLS)!];
  const usedElsewhere = (await allGroups()).some((g) => g.id !== group.id && groupProductIds(g).includes(productId));
  if (!usedElsewhere) {
    ops.push({ sql: 'DELETE FROM prices WHERE product_id = ?', params: [productId] });
    ops.push({ sql: 'DELETE FROM products WHERE id = ?', params: [productId] });
  }
  await write(ops);
}

// ---------- prices ----------

export async function addReading(r: Omit<PriceReading, 'id'>): Promise<void> {
  await write([insertReadingOp(r)]);
}

export async function readingsFor(productIds: string[]): Promise<Map<string, PriceReading[]>> {
  const map = new Map<string, PriceReading[]>();
  if (!productIds.length) return map;
  const rows = await sql().query(`SELECT * FROM prices WHERE product_id IN (${placeholders(productIds.length)}) ORDER BY date`, productIds);
  for (const row of rows) {
    const r = toReading(row);
    const arr = map.get(r.productId) ?? [];
    arr.push(r);
    map.set(r.productId, arr);
  }
  return map;
}

// ---------- shopping list ----------

const ENTRY_COLS = {
  text: 'text',
  groupId: 'item_id',
  chain: 'chain',
  categoryId: 'category_id',
  qty: 'qty',
  price: 'price',
  section: 'section',
  checked: 'checked',
};

export async function allListEntries(): Promise<ListEntry[]> {
  return (await sql().query('SELECT * FROM list_entries ORDER BY created_at')).map(toEntry);
}

export async function addListEntry(e: ListEntry): Promise<void> {
  await write([insertEntryOp(e)]);
}

export async function updateListEntry(id: string, patch: Partial<ListEntry>): Promise<void> {
  const op = updateOp('list_entries', id, patch, ENTRY_COLS);
  if (op) await write([op]);
}

export async function deleteListEntries(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await write([{ sql: `DELETE FROM list_entries WHERE id IN (${placeholders(ids.length)})`, params: ids }]);
}

export async function openEntryForGroup(groupId: string): Promise<boolean> {
  const [{ c }] = await sql().query<{ c: number }>('SELECT COUNT(*) AS c FROM list_entries WHERE item_id = ? AND checked = 0', [groupId]);
  return Number(c) > 0;
}

// ---------- receipts ----------

export async function allReceipts(): Promise<Receipt[]> {
  return (await sql().query('SELECT * FROM receipts ORDER BY scanned_at DESC')).map(toReceipt);
}

export async function getReceipt(id: string): Promise<Receipt | undefined> {
  return (await sql().query('SELECT * FROM receipts WHERE id = ?', [id])).map(toReceipt)[0];
}

export async function saveReceipt(r: Receipt): Promise<void> {
  await write([insertReceiptOp(r)]);
}

export async function deleteReceipts(ids: string[]): Promise<void> {
  if (ids.length) await write(ids.map((id) => ({ sql: 'DELETE FROM receipts WHERE id = ?', params: [id] })));
}

// ---------- loyalty cards ----------

export async function allCards(): Promise<LoyaltyCard[]> {
  return (await sql().query('SELECT * FROM cards ORDER BY created_at')).map(toCard);
}

export async function addCard(c: LoyaltyCard): Promise<void> {
  await write([insertCardOp(c)]);
}

export async function deleteCard(id: string): Promise<void> {
  await write([{ sql: 'DELETE FROM cards WHERE id = ?', params: [id] }]);
}

/** Chains whose member prices count, based on the loyalty cards added. */
export async function cardChains(): Promise<Set<Chain>> {
  const set = new Set<Chain>();
  for (const c of await allCards()) {
    // Flybuys also covers Liquorland; Everyday Rewards also covers BWS.
    if (c.program === 'flybuys') ['coles', 'liquorland', 'liquorlandwarehouse', 'liquorlandcellars'].forEach((x) => set.add(x as Chain));
    if (c.program === 'everyday') ['woolworths', 'bws'].forEach((x) => set.add(x as Chain));
  }
  return set;
}

// ---------- categories ----------

export async function allCategories(): Promise<Category[]> {
  return (await sql().query('SELECT * FROM categories ORDER BY ord')).map(toCategory);
}

export async function addCategory(name: string, section: Section = 'pantry'): Promise<void> {
  const [{ m }] = await sql().query<{ m: number | null }>('SELECT MAX(ord) AS m FROM categories');
  await write([insertCategoryOp({ id: uid(), name, order: (Number(m) || 0) + 1, section })]);
}

export async function renameCategory(id: string, name: string): Promise<void> {
  await write([{ sql: 'UPDATE categories SET name = ? WHERE id = ?', params: [name, id] }]);
}

export async function swapCategories(a: Category, b: Category): Promise<void> {
  await write([
    { sql: 'UPDATE categories SET ord = ? WHERE id = ?', params: [b.order, a.id] },
    { sql: 'UPDATE categories SET ord = ? WHERE id = ?', params: [a.order, b.id] },
  ]);
}

export async function deleteCategory(id: string): Promise<void> {
  await write([
    { sql: 'DELETE FROM categories WHERE id = ?', params: [id] },
    { sql: 'UPDATE items SET category_id = NULL WHERE category_id = ?', params: [id] },
    { sql: 'UPDATE list_entries SET category_id = NULL WHERE category_id = ?', params: [id] },
  ]);
}

// ---------- undo ----------

/** A set of rows to remember before a change: `SELECT * FROM table WHERE where`. */
export interface RowSet {
  table: 'items' | 'products' | 'prices' | 'list_entries' | 'cards' | 'categories';
  where: string;
  params: SqlValue[];
}
export type SavedRows = (RowSet & { rows: Record<string, SqlValue>[] })[];

export async function saveRows(sets: RowSet[]): Promise<SavedRows> {
  const out: SavedRows = [];
  for (const s of sets) out.push({ ...s, rows: await sql().query<Record<string, SqlValue>>(`SELECT * FROM ${s.table} WHERE ${s.where}`, s.params) });
  return out;
}

/** Put remembered rows back exactly as they were. */
export async function putBackRows(saved: SavedRows): Promise<void> {
  const ops: SqlOp[] = [];
  for (const s of saved) {
    ops.push({ sql: `DELETE FROM ${s.table} WHERE ${s.where}`, params: s.params });
    for (const r of s.rows) {
      const cols = Object.keys(r);
      ops.push({
        sql: `INSERT OR REPLACE INTO ${s.table} (${cols.join(', ')}) VALUES (${placeholders(cols.length)})`,
        params: cols.map((c) => r[c]),
      });
    }
  }
  if (ops.length) await write(ops);
}

/** The rows deleting these pantry items touches: the items, their products, prices and list lines. */
export async function rowsForGroups(ids: string[]): Promise<RowSet[]> {
  if (!ids.length) return [];
  const groups = (await Promise.all(ids.map(getGroup))).filter((g): g is Group => !!g);
  const productIds = [...new Set(groups.flatMap(groupProductIds))];
  const sets: RowSet[] = [
    { table: 'items', where: `id IN (${placeholders(ids.length)})`, params: ids },
    { table: 'list_entries', where: `item_id IN (${placeholders(ids.length)})`, params: ids },
  ];
  if (productIds.length) {
    sets.push({ table: 'products', where: `id IN (${placeholders(productIds.length)})`, params: productIds });
    sets.push({ table: 'prices', where: `product_id IN (${placeholders(productIds.length)})`, params: productIds });
  }
  return sets;
}

// ---------- history ----------

/**
 * Deletes prices older than the history setting. Each product's latest price is always kept,
 * and so is the sample items' made-up history. Returns how many prices were removed.
 */
export async function pruneHistory(weeks: number, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - weeks * 7 * 86_400_000).toISOString();
  const where = `date < ? AND source <> 'demo' AND date < (SELECT MAX(q.date) FROM prices q WHERE q.product_id = prices.product_id)`;
  const [{ n }] = await sql().query<{ n: number }>(`SELECT COUNT(*) AS n FROM prices WHERE ${where}`, [cutoff]);
  if (Number(n) > 0) await write([{ sql: `DELETE FROM prices WHERE ${where}`, params: [cutoff] }]);
  return Number(n);
}

// ---------- bulk (sample data, backup) ----------

export async function runOps(ops: SqlOp[]): Promise<void> {
  await write(ops);
}

export interface Snapshot {
  products: Product[];
  groups: Group[];
  prices: PriceReading[];
  list: ListEntry[];
  cards: LoyaltyCard[];
  categories: Category[];
  kv: { key: string; value: unknown }[];
  /** Kept receipts (not in backups made before 0.6.0). Their photos travel separately, in the backup file. */
  receipts?: Receipt[];
}

export async function snapshot(): Promise<Snapshot> {
  const kvRows = await sql().query<{ key: string; value: string }>('SELECT key, value FROM kv');
  return {
    products: await allProducts(),
    groups: await allGroups(),
    prices: (await sql().query('SELECT * FROM prices ORDER BY id')).map(toReading),
    list: await allListEntries(),
    cards: await allCards(),
    categories: await allCategories(),
    kv: kvRows.map((r) => ({ key: r.key, value: JSON.parse(r.value) })),
    receipts: await allReceipts(),
  };
}

/**
 * An item from a backup. One from before 0.8.9 (it has no "Any size" setting) gets the same move to
 * My picks as an update does (picks.ts), so restoring an old backup gives the same results.
 */
function fromBackup(g: Group, s: Snapshot): Group {
  const full = { ...g, sameProductIds: g.sameProductIds ?? [], altProductIds: g.altProductIds ?? [] };
  if (g.anySize !== undefined) return full;
  const products = new Map(s.products.map((p) => [p.id, p]));
  return toPicks(
    full,
    (id) => products.get(id)?.chain,
    (id) => products.get(id),
  );
}

export async function restoreSnapshot(s: Snapshot): Promise<void> {
  const ops: SqlOp[] = ['prices', 'products', 'items', 'list_entries', 'cards', 'categories', 'kv', 'receipts'].map((t) => ({
    sql: `DELETE FROM ${t}`,
  }));
  (s.receipts ?? []).forEach((r) => ops.push(insertReceiptOp(r)));
  s.products.forEach((p) => ops.push(insertProductOp(p)));
  s.groups.forEach((g) => ops.push(insertGroupOp(fromBackup(g, s))));
  s.prices.forEach((r) => ops.push(insertReadingOp(r)));
  s.list.forEach((e) => ops.push(insertEntryOp(e)));
  s.cards.forEach((c) => ops.push(insertCardOp(c)));
  s.categories.forEach((c) => ops.push(insertCategoryOp(c)));
  s.kv.forEach((k) => ops.push({ sql: 'INSERT INTO kv (key, value) VALUES (?, ?)', params: [k.key, JSON.stringify(k.value)] }));
  await write(ops);
}

/** The parts of a backup that can be restored (or exported) on their own. */
export interface RestoreParts {
  /** Items, their products and price history, and categories, for the tabs in `sections`. */
  pantry: boolean;
  /** Which tabs' items (all three when not given). */
  sections?: Section[];
  /** The shopping lists. */
  list: boolean;
  cards: boolean;
  /** Settings and shops (and the app's other saved settings). */
  settings: boolean;
  /** Kept receipts (their details; photos are a separate choice when exporting). */
  receipts?: boolean;
  /**
   * Restoring only: your shops and stores (which shops, your branches, Keg and Pharmacy on or off,
   * shops you added). `settings` is then everything else: alerts, colours, price checks and so on.
   * Exporting always saves both under `settings`.
   */
  shops?: boolean;
  /** Restoring shops: only these tabs' shops are replaced (all three when not given). */
  shopSections?: Section[];
}

/** Settings that are about your shops. */
export const SHOP_SETTINGS = ['stores', 'enabledChains', 'sections', 'hiddenTabs', 'customShops', 'adultConfirmed', 'area'] as const;
/** Settings that belong to this phone, never taken from a backup. */
const DEVICE_SETTINGS = [
  'onboarded',
  'privacyAccepted',
  'setup',
  'tour',
  'lastCheck',
  'lastBackupAt',
  'backupNudgeAt',
  'demoLoaded',
  'marketData',
] as const;

/**
 * Settings after restoring part of a backup: the phone's own settings, with only the parts
 * picked taken from the backup. Things that belong to this phone (setup progress, the
 * downloaded receipt reader, the backup folder, the app icon actually showing) always stay.
 */
export function mergeRestoredSettings(
  current: Settings,
  incoming: Partial<Settings>,
  pick: { shops?: boolean; shopSections?: Section[]; other?: boolean },
): Settings {
  const from = mergeSettings(incoming);
  const out: Settings = { ...current };
  const shopKeys = new Set<string>(SHOP_SETTINGS);
  const deviceKeys = new Set<string>(DEVICE_SETTINGS);
  const o = out as unknown as Record<string, unknown>;
  const f = from as unknown as Record<string, unknown>;
  for (const k of Object.keys(f)) {
    if (deviceKeys.has(k) || shopKeys.has(k)) continue;
    if (pick.other) o[k] = f[k];
  }
  const tabs = pick.shops ? (pick.shopSections ?? SECTIONS) : [];
  if (tabs.length) Object.assign(out, mergeShopsFor(current, from, incoming, tabs));
  if (pick.other) {
    out.receipts = { ...from.receipts, installed: current.receipts.installed };
    out.recalls = { ...from.recalls, lastCheck: current.recalls.lastCheck };
    out.autoBackup = {
      ...from.autoBackup,
      folder: current.autoBackup.folder,
      folderName: current.autoBackup.folderName,
      lastAt: current.autoBackup.lastAt,
      lastError: undefined,
    };
    if (!out.autoBackup.folder) out.autoBackup.enabled = false;
    out.look = { ...from.look, icon: current.look.icon };
  }
  // A restored part counts as set up.
  const done = new Set(current.setup.done);
  tabs.forEach((t) => done.add(t));
  if (pick.other) ['history', 'look', 'a11y', 'recalls'].forEach((t) => done.add(t));
  out.setup = { ...current.setup, done: [...done], skipped: current.setup.skipped.filter((t) => !done.has(t)) };
  return out;
}

/**
 * Shops from a backup for some tabs only: the other tabs' shops, branches and on/off switches
 * stay exactly as they are on this phone. A shop the backup picked without a branch keeps the
 * branch this phone already has for it.
 */
export function mergeShopsFor(current: Settings, from: Settings, incoming: Partial<Settings>, tabs: Section[]): Partial<Settings> {
  const tabOf = (c: string) => shopDef(c)?.section ?? [...from.customShops, ...current.customShops].find((x) => x.id === c)?.section ?? 'pantry';
  const ours = (c: string) => tabs.includes(tabOf(c));
  const enabledChains = [...current.enabledChains.filter((c) => !ours(c)), ...from.enabledChains.filter((c) => ours(c))];
  const stores: Settings['stores'] = {};
  for (const [c, v] of Object.entries(current.stores)) if (!ours(c)) stores[c as keyof Settings['stores']] = v;
  for (const c of from.enabledChains.filter(ours)) {
    const key = c as keyof Settings['stores'];
    const theirs = from.stores[key];
    stores[key] = theirs && (theirs.primary || theirs.secondary) ? theirs : (current.stores[key] ?? theirs ?? {});
  }
  const sections = { ...current.sections };
  if (tabs.includes('keg')) sections.keg = from.sections.keg;
  if (tabs.includes('pharmacy')) sections.pharmacy = from.sections.pharmacy;
  const hiddenFrom = 'hiddenTabs' in incoming ? (from.hiddenTabs ?? []) : [];
  const hiddenTabs = [...(current.hiddenTabs ?? []).filter((t) => !tabs.includes(t)), ...hiddenFrom.filter((t) => tabs.includes(t))];
  return {
    enabledChains: [...new Set(enabledChains)],
    stores,
    sections,
    hiddenTabs: hiddenTabs.length ? hiddenTabs : undefined,
    customShops: [...current.customShops.filter((x) => !tabs.includes(x.section)), ...from.customShops.filter((x) => tabs.includes(x.section))],
    adultConfirmed: tabs.includes('keg') ? current.adultConfirmed || from.adultConfirmed : current.adultConfirmed,
    // Your area (for "near me") only comes back if this phone hasn't got one.
    area: current.area ?? from.area,
  };
}

/**
 * A backup snapshot of just the parts picked. Leaving out price history keeps items and their
 * products but drops their saved prices (a much smaller file).
 */
export function pickSnapshot(s: Snapshot, parts: RestoreParts, opts: { prices?: boolean } = {}): Snapshot {
  const secs = parts.sections ?? SECTIONS;
  const groups = parts.pantry ? s.groups.filter((g) => secs.includes(g.section ?? 'pantry')) : [];
  const ids = new Set(groups.flatMap(groupProductIds));
  return {
    groups,
    products: s.products.filter((p) => ids.has(p.id)),
    prices: opts.prices === false ? [] : s.prices.filter((r) => ids.has(r.productId)),
    categories: parts.pantry ? s.categories.filter((c) => secs.includes(c.section ?? 'pantry')) : [],
    list: parts.list ? s.list : [],
    cards: parts.cards ? s.cards : [],
    kv: parts.settings ? s.kv : [],
    receipts: parts.receipts ? (s.receipts ?? []) : [],
  };
}

/**
 * Restores only the parts picked, replacing those parts on this phone and leaving the rest as
 * it is. Items are replaced tab by tab: restoring Keg items leaves the Pantry alone. Shopping
 * list lines whose item isn't on the phone become plain lines.
 */
export async function restoreParts(s: Snapshot, parts: RestoreParts, renames: Map<string, string> = new Map()): Promise<void> {
  const ops: SqlOp[] = [];
  if (parts.pantry) {
    const secs = parts.sections ?? SECTIONS;
    const incoming = s.groups.filter((g) => secs.includes(g.section ?? 'pantry'));
    const incomingIds = new Set(incoming.flatMap(groupProductIds));
    // Take out this phone's items on those tabs, with their products and prices.
    const existing = (await allGroups()).filter((g) => secs.includes(g.section ?? 'pantry'));
    const keepIds = new Set((await allGroups()).filter((g) => !secs.includes(g.section ?? 'pantry')).flatMap(groupProductIds));
    const dropIds = [...new Set(existing.flatMap(groupProductIds))].filter((id) => !keepIds.has(id));
    for (const g of existing) ops.push({ sql: 'DELETE FROM items WHERE id = ?', params: [g.id] });
    for (const id of dropIds)
      ops.push({ sql: 'DELETE FROM prices WHERE product_id = ?', params: [id] }, { sql: 'DELETE FROM products WHERE id = ?', params: [id] });
    s.products.filter((p) => incomingIds.has(p.id)).forEach((p) => ops.push(insertProductOp(p, true)));
    incoming.forEach((g) =>
      ops.push(
        insertGroupOp(
          { ...fromBackup(g, s), name: renames.get(g.id) ?? g.name },
          true,
        ),
      ),
    );
    // Prices for products another tab still uses stay as they are, rather than doubling up.
    s.prices.filter((r) => incomingIds.has(r.productId) && !keepIds.has(r.productId)).forEach((r) => ops.push(insertReadingOp(r)));
    // Categories from the backup. First take out this phone's categories on those tabs that no
    // item or list line uses (a new phone's starting ones), or every category would be there twice.
    // Only for tabs the backup has categories for, so an old backup doesn't leave a tab with none.
    const cats = s.categories.filter((c) => secs.includes(c.section ?? 'pantry'));
    const catSecs = [...new Set(cats.map((c) => c.section ?? 'pantry'))];
    if (catSecs.length)
      ops.push({
        sql:
          `DELETE FROM categories WHERE section IN (${placeholders(catSecs.length)})` +
          ' AND id NOT IN (SELECT category_id FROM items WHERE category_id IS NOT NULL)' +
          ' AND id NOT IN (SELECT category_id FROM list_entries WHERE category_id IS NOT NULL)',
        params: catSecs,
      });
    cats.forEach((c) => ops.push({ ...insertCategoryOp(c), sql: insertCategoryOp(c).sql.replace('INSERT INTO', 'INSERT OR REPLACE INTO') }));
  }
  if (parts.list) {
    const groupIds = new Set([...(await allGroups()).map((g) => g.id), ...(parts.pantry ? s.groups.map((g) => g.id) : [])]);
    ops.push({ sql: 'DELETE FROM list_entries' });
    s.list.forEach((e) => {
      const keep = e.groupId && groupIds.has(e.groupId);
      const name = e.groupId ? (renames.get(e.groupId) ?? s.groups.find((g) => g.id === e.groupId)?.name ?? e.text) : e.text;
      ops.push(insertEntryOp(keep ? e : { ...e, groupId: undefined, text: name }));
    });
  }
  if (parts.cards) {
    ops.push({ sql: 'DELETE FROM cards' });
    s.cards.forEach((c) => ops.push(insertCardOp(c)));
  }
  if (parts.receipts) {
    ops.push({ sql: 'DELETE FROM receipts' });
    (s.receipts ?? []).forEach((r) => ops.push(insertReceiptOp(r)));
  }
  if (parts.settings || parts.shops) {
    // Only the settings picked change; nothing else saved on the phone is touched.
    const incoming = s.kv.find((k) => k.key === 'settings')?.value as Partial<Settings> | undefined;
    if (incoming) {
      const merged = mergeRestoredSettings(await getSettings(), incoming, {
        shops: parts.shops,
        shopSections: parts.shopSections,
        other: parts.settings,
      });
      ops.push({ sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', params: ['settings', JSON.stringify(merged)] });
    }
    if (parts.settings) {
      const dismissed = s.kv.find((k) => k.key === 'recallDismissed');
      if (dismissed)
        ops.push({ sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', params: [dismissed.key, JSON.stringify(dismissed.value)] });
    }
  }
  if (ops.length) await write(ops);
}

/** Read the same tables the Android worker writes (used after a background check). */
export function refresh(): void {
  changed();
}

/**
 * "Erase everything and start fresh" (0.8.2): every table emptied, so Restock opens on its first
 * screen again. Nothing is noted for sync (the household was left first), and this phone gets a
 * new sync identity.
 */
export async function eraseEverything(): Promise<void> {
  const tables = await sql().query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('sync_meta')",
  );
  const ops: SqlOp[] = [{ sql: "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')" }];
  for (const t of tables) ops.push({ sql: `DELETE FROM "${t.name}"` });
  ops.push({ sql: 'DELETE FROM sync_meta' });
  ops.push({ sql: "INSERT INTO sync_meta (key, value) VALUES ('device', lower(hex(randomblob(8))))" });
  await sql().batch(ops);
  changed();
}
