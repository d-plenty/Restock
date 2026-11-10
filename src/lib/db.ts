import {
  HISTORY_WEEKS,
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
import { asListSection, DEFAULT_SECTION_CATEGORIES, SECTIONS, setCustomShops, shopDef, type ListSection, type Section } from '../shops';
import type { SqlDriver, SqlOp, SqlValue } from './sql/driver';
import { migrate } from './sql/schema';
import { toPicks } from './picks';
import { checkSettings } from './settingsCheck';
import { isPhotoPath } from './receiptPaths';
import { HA_CONFIG, HA_STATE, LOCAL_ONLY_KV, resetHaPairing } from './haKeys';
import { applyRows, changedRows, syncedTabs } from './sharedSettings';

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

// 0.9.5 (undo): while an undoable action runs, undo.ts sees each write first, to remember the rows
// it touches as they were (so one Undo puts the whole action back, with the same ids).
let watchWrites: ((ops: SqlOp[]) => Promise<void>) | undefined;
export function setWriteWatcher(fn: typeof watchWrites): void {
  watchWrites = fn;
}
// 0.9.5 (undo): erasing or restoring starts again from nothing to undo (undo.ts clearUndo).
let resetWatcher: (() => void) | undefined;
export function setResetWatcher(fn: typeof resetWatcher): void {
  resetWatcher = fn;
}

async function write(ops: SqlOp[]): Promise<void> {
  if (!ops.length) return;
  if (watchWrites) await watchWrites(ops);
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
  section: r.section === null || r.section === undefined ? undefined : asListSection(r.section),
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
  sql: `INSERT ${replace ? 'OR REPLACE ' : ''}INTO list_entries (id, text, item_id, chain, category_id, qty, price, section, product, checked, created_at, checked_at, qty_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    // When the tick and the amount were set (see updateEntryOp).
    Date.now(),
    Date.now(),
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

/**
 * Saved (or sent) settings filled in with the defaults. 0.9.0: every setting is checked first
 * (settingsCheck.ts), so a damaged or made-up value can't stop Restock opening or do something
 * odd: the wrong kind of value gets the default. `strict` is for settings from a backup or
 * another phone.
 */
export function mergeSettings(stored: Partial<Settings> | undefined, opts: { strict?: boolean } = {}): Settings {
  return checkSettings(stored, opts);
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

/**
 * Saves a change to the settings. 0.9.3: a household setting changed here (sharedSettings.ts: the
 * shops of a tab this phone syncs, Shop around, alert level, recalls, the list's cheapest, the
 * order of products) is also written to the synced household_settings table, so every phone in
 * the household follows. `local`: this phone only (settings taken from the household, or fitted to
 * it), never written there. What another phone changed arrives in the stored settings already
 * (SyncEngine applies it), so it's never sent back out from here.
 */
export async function updateSettings(patch: Partial<Settings>, opts: { local?: boolean } = {}): Promise<Settings> {
  const before = await getSettings();
  const next = mergeSettings({ ...before, ...patch });
  setCustomShops(next.customShops);
  const ops: SqlOp[] = [{ sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', params: ['settings', JSON.stringify(next)] }];
  if (!opts.local) ops.push(...(await householdSettingOps(before, next)));
  await write(ops);
  lastSettings = next;
  return next;
}

/** The household fields of the settings, to tell quickly whether any changed. */
const sharedPart = (s: Settings) =>
  JSON.stringify([s.shopAroundMin, s.defaultThresholdPct, s.listCompare, s.productOrder, s.recalls.enabled, s.enabledChains, s.sections, s.customShops]);

/**
 * 0.9.3: the household this phone (or the web app) is in, for household settings: the tabs it
 * syncs and the rows there are. Null when it isn't in one (or the database is older).
 */
export async function householdContext(): Promise<{ tabs: Set<Section>; rows: Map<string, string> } | null> {
  try {
    const [owner] = await sql().query<{ v: string }>("SELECT v FROM household WHERE k = 'owner'");
    if (!owner) return null;
    const [mine] = await sql().query<{ value: string }>("SELECT value FROM sync_meta WHERE key = 'tabs'");
    const [theirs] = await sql().query<{ v: string }>("SELECT v FROM household WHERE k = 'tabs'");
    const rows = await sql().query<{ k: string; v: string }>('SELECT k, v FROM household_settings');
    return { tabs: syncedTabs(mine?.value ?? null, theirs?.v ?? null), rows: new Map(rows.map((r) => [r.k, r.v])) };
  } catch {
    return null;
  }
}

async function householdSettingOps(before: Settings, next: Settings): Promise<SqlOp[]> {
  if (sharedPart(before) === sharedPart(next)) return [];
  const ctx = await householdContext();
  if (!ctx) return [];
  return changedRows(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, ctx.tabs, ctx.rows).map(([k, v]) => ({
    sql: 'INSERT OR REPLACE INTO household_settings (k, v) VALUES (?, ?)',
    params: [k, v],
  }));
}

/**
 * 0.9.3: this device's settings brought in line with the household's rows (here only: nothing is
 * written to the household). After joining, sharing another tab, a restore, a reset, at start-up,
 * and on the web after fitting its shops. SyncEngine does the same as rows arrive; this covers
 * settings saved here meanwhile. True when they changed.
 */
export async function reapplyHouseholdSettings(): Promise<boolean> {
  const ctx = await householdContext();
  if (!ctx || !ctx.rows.size) return false;
  const s = structuredClone(await getSettings());
  if (!applyRows(s as unknown as Record<string, unknown>, [...ctx.rows].map(([k, v]) => ({ k, v })), ctx.tabs)) return false;
  await updateSettings(s, { local: true });
  return true;
}

/** 0.9.3: a read-only query, for householdSettings.ts. */
export async function queryRows<T>(text: string, params: SqlValue[] = []): Promise<T[]> {
  return sql().query<T>(text, params);
}

/**
 * 0.9.0: "Reset settings" on the something-went-wrong screen. Only the settings go back to how a
 * new phone has them; items, lists, prices, cards and receipts stay. Restock still counts as set
 * up (so it opens on your things, not on its first screen), and keeps which setup steps are done.
 */
export async function resetSettings(): Promise<Settings> {
  let kept: Partial<Settings> = {};
  try {
    const [row] = await sql().query<{ value: string }>('SELECT value FROM kv WHERE key = ?', ['settings']);
    const old = checkSettings(row ? JSON.parse(row.value) : undefined);
    kept = { onboarded: old.onboarded, privacyAccepted: old.privacyAccepted, setup: old.setup };
  } catch {
    // The saved settings can't even be read: start from the defaults.
  }
  const next = checkSettings(kept);
  setCustomShops(next.customShops);
  await putKV('settings', next);
  lastSettings = next;
  // 0.9.3: the household's settings stay the household's.
  if (await reapplyHouseholdSettings().catch(() => false)) return getSettings();
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

/**
 * 0.9.0: a tick or a new amount also records when it changed (checked_at, qty_at), so when two
 * phones change the same line, sync keeps the newer tick and the newer amount separately.
 */
export function updateEntryOp(id: string, patch: Partial<ListEntry>, now = Date.now()): SqlOp | undefined {
  const op = updateOp('list_entries', id, patch, ENTRY_COLS);
  if (!op) return undefined;
  const extra: string[] = [];
  if ('checked' in patch) extra.push('checked_at = ' + now);
  if ('qty' in patch) extra.push('qty_at = ' + now);
  if (!extra.length) return op;
  return { sql: op.sql.replace(' WHERE id = ?', `, ${extra.join(', ')} WHERE id = ?`), params: op.params };
}

export async function updateListEntry(id: string, patch: Partial<ListEntry>): Promise<void> {
  const op = updateEntryOp(id, patch);
  if (op) await write([op]);
}

/** Ticks several lines at once (with the time, as updateEntryOp). */
export const checkEntriesOp = (ids: string[], now = Date.now()): SqlOp => ({
  sql: `UPDATE list_entries SET checked = 1, checked_at = ? WHERE id IN (${placeholders(ids.length)})`,
  params: [now, ...ids],
});

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
 * 0.9.2: not with a Restock server: the phone moves older prices there itself (ServerOffload.java)
 * and deletes its own copy only once the server has them, so nothing is deleted here.
 */
export async function pruneHistory(weeks: number, now = Date.now()): Promise<number> {
  // 0.9.0: only ever one of the real choices (1 to 12 months since 0.9.1). A nonsense number (from
  // a damaged setting) deletes nothing, rather than every price but the latest.
  if (!HISTORY_WEEKS.includes(weeks) || !Number.isFinite(now)) return 0;
  if (await serverKeepsHistory()) return 0;
  const cutoff = new Date(now - weeks * 7 * 86_400_000).toISOString();
  const where = `date < ? AND source <> 'demo' AND date < (SELECT MAX(q.date) FROM prices q WHERE q.product_id = prices.product_id)`;
  const [{ n }] = await sql().query<{ n: number }>(`SELECT COUNT(*) AS n FROM prices WHERE ${where}`, [cutoff]);
  if (Number(n) > 0) await write([{ sql: `DELETE FROM prices WHERE ${where}`, params: [cutoff] }]);
  return Number(n);
}

/** 0.9.2: whether this phone uses a Restock server (it then keeps older prices there, see pruneHistory). */
export async function serverKeepsHistory(): Promise<boolean> {
  try {
    const [{ n }] = await sql().query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sync_meta WHERE key IN ('server_home', 'server_away') AND EXISTS (SELECT 1 FROM sync_meta WHERE key = 'server_dev_priv')",
    );
    return Number(n) > 0;
  } catch {
    return false;
  }
}

/**
 * 0.9.2: which of these receipt photos are kept on the Restock server rather than on this phone
 * (moved there because they're older than "Keep price history for").
 */
export async function photosOnServer(paths: string[]): Promise<string[]> {
  const real = paths.filter(isPhotoPath);
  if (!real.length) return [];
  try {
    const rows = await sql().query<{ key: string }>(
      `SELECT key FROM sync_meta WHERE key IN (${placeholders(real.length)})`,
      real.map((p) => 'photo_off:' + p),
    );
    return rows.map((r) => r.key.slice('photo_off:'.length));
  } catch {
    return [];
  }
}

/**
 * 0.9.1: how many prices this phone keeps and the date of the oldest (not counting the sample items'
 * made-up history), so the backup screens can say what's in a backup.
 */
export async function priceHistorySpan(): Promise<{ count: number; oldest?: string }> {
  const [row] = await sql().query<{ n: number; oldest: string | null }>(
    `SELECT COUNT(*) AS n, MIN(date) AS oldest FROM prices WHERE source <> 'demo'`,
  );
  return { count: Number(row?.n ?? 0), oldest: row?.oldest ?? undefined };
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

/**
 * 0.9.0: a receipt from a backup keeps only photo paths a receipt really has (receiptPaths.ts).
 * Any other path is left out, so a backup can't point Restock at another of its files.
 */
export function withSafePhotos(r: Receipt): Receipt {
  const photo = isPhotoPath(r.photo) ? r.photo : undefined;
  const pages = Array.isArray(r.pages) ? r.pages.filter(isPhotoPath) : [];
  return { ...r, photo, pages: pages.length ? pages : undefined };
}

/** Which list a shopping list line is on: its item's tab, or the tab it was added from (List.tsx entrySection). */
const lineTab = (e: ListEntry, itemTabs: Map<string, Section>): ListSection =>
  (e.groupId ? itemTabs.get(e.groupId) : undefined) ?? (e.section ? asListSection(e.section) : 'pantry');

export async function restoreSnapshot(s: Snapshot): Promise<void> {
  resetWatcher?.(); // 0.9.5 (undo)
  // 0.9.0: this phone's automatic-backup password (never in a backup) and its app version stay.
  // 0.9.3: and its Home Assistant settings; which line is which item there starts afresh (the
  // next round pairs them by their words, so nothing is removed from either list).
  const here = new Map(
    (await sql().query<{ key: string; value: string }>('SELECT key, value FROM kv WHERE key IN (?, ?, ?)', ['settings', 'appVersion', HA_CONFIG])).map((r) => [
      r.key,
      r.value,
    ]),
  );
  const password = (() => {
    try {
      return (JSON.parse(here.get('settings') ?? '{}') as Partial<Settings>).autoBackup?.password;
    } catch {
      return undefined;
    }
  })();
  const kv = s.kv
    .filter((k) => k.key !== 'appVersion' && !LOCAL_ONLY_KV.includes(k.key))
    .map((k) => {
      if (k.key !== 'settings') return k;
      // 0.9.0: settings are checked on the way in (settingsCheck.ts).
      const checked = mergeSettings(k.value as Partial<Settings>);
      return { key: k.key, value: password ? { ...checked, autoBackup: { ...checked.autoBackup, password } } : checked };
    });
  if (here.has('appVersion')) kv.push({ key: 'appVersion', value: JSON.parse(here.get('appVersion')!) });
  if (here.has(HA_CONFIG)) kv.push({ key: HA_CONFIG, value: JSON.parse(here.get(HA_CONFIG)!) });
  const ops: SqlOp[] = ['prices', 'products', 'items', 'list_entries', 'cards', 'categories', 'kv', 'receipts'].map((t) => ({
    sql: `DELETE FROM ${t}`,
  }));
  (s.receipts ?? []).forEach((r) => ops.push(insertReceiptOp(withSafePhotos(r))));
  s.products.forEach((p) => ops.push(insertProductOp(p)));
  s.groups.forEach((g) => ops.push(insertGroupOp(fromBackup(g, s))));
  s.prices.forEach((r) => ops.push(insertReadingOp(r)));
  s.list.forEach((e) => ops.push(insertEntryOp(e)));
  s.cards.forEach((c) => ops.push(insertCardOp(c)));
  s.categories.forEach((c) => ops.push(insertCategoryOp(c)));
  kv.forEach((k) => ops.push({ sql: 'INSERT INTO kv (key, value) VALUES (?, ?)', params: [k.key, JSON.stringify(k.value)] }));
  // 0.9.3: Home Assistant's pairing starts afresh (it isn't kept), even for a round under way now.
  resetHaPairing();
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
  // 0.9.0: whether you're signed in to a shop is about this phone's own sign-in, not the backup's.
  'accounts',
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
  // 0.9.0: checked strictly, as it comes from a file (settingsCheck.ts).
  const from = mergeSettings(incoming, { strict: true });
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
      // 0.9.0: the password is this phone's own (backups never have it).
      password: current.autoBackup.password,
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
 *
 * 0.9.0: shopping lists are replaced tab by tab too: the tabs the backup has lines for, and the
 * tabs whose items are being restored. Another tab's list stays as it is. `household` ("Restore
 * for the household"): loyalty cards are added from the backup (a card already here with the same
 * id is replaced) and no card is deleted, because the cards on a phone in a household can be other
 * people's, and deleting them here would delete them on their phones too.
 */
export async function restoreParts(
  s: Snapshot,
  parts: RestoreParts,
  renames: Map<string, string> = new Map(),
  opts: { household?: boolean } = {},
): Promise<void> {
  resetWatcher?.(); // 0.9.5 (undo)
  const ops: SqlOp[] = [];
  const before = await allGroups();
  if (parts.pantry) {
    const secs = parts.sections ?? SECTIONS;
    const incoming = s.groups.filter((g) => secs.includes(g.section ?? 'pantry'));
    const incomingIds = new Set(incoming.flatMap(groupProductIds));
    // Take out this phone's items on those tabs, with their products and prices.
    const existing = before.filter((g) => secs.includes(g.section ?? 'pantry'));
    const keepIds = new Set(before.filter((g) => !secs.includes(g.section ?? 'pantry')).flatMap(groupProductIds));
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
    const secs = parts.pantry ? (parts.sections ?? SECTIONS) : [];
    // The items there will be afterwards: this phone's on tabs that aren't being restored, and the backup's on those that are.
    const items = [...before.filter((g) => !secs.includes(g.section ?? 'pantry')), ...s.groups.filter((g) => secs.includes(g.section ?? 'pantry'))];
    const groupIds = new Set(items.map((g) => g.id));
    const backupTabs = new Map(s.groups.map((g) => [g.id, asSection(g.section)]));
    const hereTabs = new Map(before.map((g) => [g.id, asSection(g.section)]));
    const tabs = new Set<ListSection>([...secs, ...s.list.map((e) => lineTab(e, backupTabs))]);
    // 0.9.5: General goes with the grocery list.
    if (tabs.has('pantry')) tabs.add('general');
    for (const e of await allListEntries()) if (tabs.has(lineTab(e, hereTabs))) ops.push({ sql: 'DELETE FROM list_entries WHERE id = ?', params: [e.id] });
    s.list.forEach((e) => {
      const keep = e.groupId && groupIds.has(e.groupId);
      const name = e.groupId ? (renames.get(e.groupId) ?? s.groups.find((g) => g.id === e.groupId)?.name ?? e.text) : e.text;
      // A line whose item doesn't come back keeps its tab, so it stays on the same list.
      const section = e.section ?? (e.groupId ? backupTabs.get(e.groupId) : undefined);
      ops.push(insertEntryOp(keep ? e : { ...e, groupId: undefined, text: name, section }, true));
    });
    // 0.9.3: Home Assistant pairs the list afresh by its words, so a restored list takes nothing off its list.
    ops.push({ sql: 'DELETE FROM kv WHERE key = ?', params: [HA_STATE] });
    resetHaPairing();
  }
  if (parts.cards) {
    if (!opts.household) ops.push({ sql: 'DELETE FROM cards' });
    s.cards.forEach((c) => ops.push(opts.household ? { ...insertCardOp(c), sql: insertCardOp(c).sql.replace('INSERT INTO', 'INSERT OR REPLACE INTO') } : insertCardOp(c)));
  }
  if (parts.receipts) {
    ops.push({ sql: 'DELETE FROM receipts' });
    (s.receipts ?? []).forEach((r) => ops.push(insertReceiptOp(withSafePhotos(r))));
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
  // 0.9.3: restored shops and settings on a household's tabs give way to the household's.
  if (parts.settings || parts.shops) await reapplyHouseholdSettings().catch(() => false);
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
  resetWatcher?.(); // 0.9.5 (undo)
  const tables = await sql().query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('sync_meta')",
  );
  const ops: SqlOp[] = [{ sql: "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')" }];
  for (const t of tables) ops.push({ sql: `DELETE FROM "${t.name}"` });
  ops.push({ sql: 'DELETE FROM sync_meta' });
  ops.push({ sql: "INSERT INTO sync_meta (key, value) VALUES ('device', lower(hex(randomblob(8))))" });
  resetHaPairing();
  await sql().batch(ops);
  // 0.9.0: and what the app keeps outside the database: the settings it remembers, and the
  // browser storage it uses for small things (recent searches, the Pantry's sort, the deal shops
  // on Home). Shop sign-ins, cookies and exported files are cleared on the Android side (eraseNative).
  lastSettings = undefined;
  setCustomShops([]);
  for (const store of ['localStorage', 'sessionStorage'] as const) {
    try {
      globalThis[store]?.clear();
    } catch {
      // Not available here (tests), or blocked: nothing kept there.
    }
  }
  changed();
}
