import type { SqlDriver } from './driver';

// The database layout. The Android background worker (PriceCheckWorker.java) reads and
// writes these same tables, so any change here must be mirrored there.
// Each entry is one migration; never edit a shipped one, only append.
// ---------- 0.8.0: phone-to-phone sync ----------
//
// sync_log has one row per synced record: when it last changed (stamp, in milliseconds), which
// phone changed it (device), whether it's been deleted, and seq, this phone's own running number
// for the change, so a paired phone can ask for "everything since number N".
// Prices are only ever added (each phone tidies its own old prices), keyed by product and date.

/** Synced tables and how each record is named in sync_log. Mirrored in SyncEngine.java. */
export const SYNCED: { table: string; key: string; deletes: boolean }[] = [
  { table: 'categories', key: 'id', deletes: true },
  { table: 'products', key: 'id', deletes: true },
  { table: 'items', key: 'id', deletes: true },
  { table: 'list_entries', key: 'id', deletes: true },
  { table: 'cards', key: 'id', deletes: true },
  { table: 'prices', key: "product_id || '|' || date", deletes: false },
];

const STAMP = `MAX(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), COALESCE((SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'clock'), 0))`;
const DEVICE = `COALESCE((SELECT value FROM sync_meta WHERE key = 'device'), '')`;
const NEXT_SEQ = `COALESCE((SELECT MAX(seq) FROM sync_log), 0) + 1`;
const NOT_APPLYING = `NOT EXISTS (SELECT 1 FROM sync_meta WHERE key = 'applying')`;

function syncTriggers(t: { table: string; key: string; deletes: boolean }): string[] {
  const key = (row: 'NEW' | 'OLD') => t.key.replace(/\b(id|product_id|date)\b/g, `${row}.$1`);
  const log = (row: 'NEW' | 'OLD', deleted: 0 | 1) =>
    `INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq) VALUES ('${t.table}', ${key(row)}, ${STAMP}, ${DEVICE}, ${deleted}, ${NEXT_SEQ});`;
  const out = [`CREATE TRIGGER sync_${t.table}_ins AFTER INSERT ON ${t.table} WHEN ${NOT_APPLYING} BEGIN ${log('NEW', 0)} END`];
  if (t.deletes) {
    out.push(`CREATE TRIGGER sync_${t.table}_upd AFTER UPDATE ON ${t.table} WHEN ${NOT_APPLYING} BEGIN ${log('NEW', 0)} END`);
    out.push(`CREATE TRIGGER sync_${t.table}_del AFTER DELETE ON ${t.table} WHEN ${NOT_APPLYING} BEGIN ${log('OLD', 1)} END`);
  }
  return out;
}

const SYNC_MIGRATION: string[] = [
  `CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('device', lower(hex(randomblob(8))))`,
  `CREATE TABLE sync_log (
    tbl TEXT NOT NULL,
    pk TEXT NOT NULL,
    stamp INTEGER NOT NULL,
    device TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    seq INTEGER NOT NULL,
    PRIMARY KEY (tbl, pk)
  )`,
  `CREATE INDEX sync_log_seq ON sync_log(seq)`,
  `CREATE TABLE sync_peers (
    device TEXT PRIMARY KEY,
    name TEXT,
    got INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT,
    host TEXT,
    port INTEGER
  )`,
  // Everything already here counts as changed now, by this phone.
  ...SYNCED.map(
    (t) =>
      `INSERT OR IGNORE INTO sync_log (tbl, pk, stamp, device, deleted, seq)
       SELECT '${t.table}', ${t.key}, ${STAMP}, ${DEVICE}, 0, (SELECT COALESCE(MAX(seq), 0) FROM sync_log) + rowid FROM ${t.table}`,
  ),
  ...SYNCED.flatMap(syncTriggers),
];

export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE products (
      id TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT,
      size TEXT,
      barcode TEXT,
      store_product_id TEXT,
      image_url TEXT,
      qty REAL,
      qty_unit TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX products_barcode ON products(barcode)`,
    `CREATE INDEX products_store ON products(chain, store_product_id)`,
    `CREATE TABLE items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category_id TEXT,
      usual_product_id TEXT,
      same_product_ids TEXT NOT NULL DEFAULT '[]',
      alt_product_ids TEXT NOT NULL DEFAULT '[]',
      threshold_pct REAL,
      alert_level TEXT NOT NULL DEFAULT 'good',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      date TEXT NOT NULL,
      price REAL NOT NULL,
      was_price REAL,
      is_special INTEGER NOT NULL DEFAULT 0,
      member_only INTEGER NOT NULL DEFAULT 0,
      promo TEXT,
      source TEXT NOT NULL
    )`,
    `CREATE INDEX prices_product_date ON prices(product_id, date)`,
    `CREATE TABLE list_entries (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      item_id TEXT,
      chain TEXT,
      category_id TEXT,
      checked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE cards (
      id TEXT PRIMARY KEY,
      program TEXT NOT NULL,
      label TEXT NOT NULL,
      number TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ord INTEGER NOT NULL
    )`,
    `CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ],
  // 0.3.2: online stock per product (1 in stock, 0 out, NULL unknown) and when it was seen.
  ['ALTER TABLE products ADD COLUMN in_stock INTEGER', 'ALTER TABLE products ADD COLUMN stock_at TEXT'],
  // 0.3.4: Aldi's "not for sale" flag was wrongly read as out of stock.
  ["UPDATE products SET in_stock = NULL, stock_at = NULL WHERE chain = 'aldi'"],
  // 0.4.0: how many of each thing on the shopping list.
  ['ALTER TABLE list_entries ADD COLUMN qty INTEGER NOT NULL DEFAULT 1'],
  // 0.4.2: shared price history, one summary row per store product (written by MarketData.java).
  [
    `CREATE TABLE market (
      chain TEXT NOT NULL,
      store_product_id TEXT NOT NULL,
      normal REAL NOT NULL,
      sale REAL,
      sale_share REAL NOT NULL,
      low REAL NOT NULL,
      cycle_weeks INTEGER,
      days INTEGER NOT NULL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chain, store_product_id)
    )`,
  ],
  // 0.4.5: the shared history's latest price (to match it to local prices), and whether each
  // pantry item may be swapped for a bigger pack. Existing items keep allowing it.
  ['ALTER TABLE market ADD COLUMN latest REAL', 'ALTER TABLE items ADD COLUMN allow_bulk INTEGER NOT NULL DEFAULT 1'],
  // 0.5.0: the Keg and Pharmacy tabs. Items, unlinked list lines and categories each belong to
  // one tab; everything already here is Pantry.
  [
    "ALTER TABLE items ADD COLUMN section TEXT NOT NULL DEFAULT 'pantry'",
    'ALTER TABLE list_entries ADD COLUMN section TEXT',
    "ALTER TABLE categories ADD COLUMN section TEXT NOT NULL DEFAULT 'pantry'",
  ],
  // 0.5.5: the price of a one-off buy on the shopping list.
  ['ALTER TABLE list_entries ADD COLUMN price REAL'],
  // 0.6.0: "alert me under $X" target prices, and kept receipts.
  [
    'ALTER TABLE items ADD COLUMN target_price REAL',
    `CREATE TABLE receipts (
      id TEXT PRIMARY KEY,
      scanned_at TEXT NOT NULL,
      shop TEXT,
      chain TEXT,
      receipt_date TEXT,
      total REAL,
      section TEXT NOT NULL DEFAULT 'pantry',
      note TEXT,
      text TEXT,
      photo TEXT,
      pinned INTEGER NOT NULL DEFAULT 0
    )`,
  ],
  // 0.6.4: a long receipt can be several photos; the extra ones are listed here.
  ['ALTER TABLE receipts ADD COLUMN pages TEXT'],
  // 0.6.8: whether multi-buy deals ("2 for $12") count for an item. Existing items keep counting them.
  ['ALTER TABLE items ADD COLUMN allow_multi INTEGER NOT NULL DEFAULT 1'],
  // 0.6.11: Coles prices saved as "on special" only because Coles tagged them (its everyday price,
  // a collectables promotion) weren't sales. Keep the ones with a "was" price or a multi-buy.
  // And stock at your second Coles, for "out at your store, in at the other one".
  [
    `UPDATE prices SET is_special = 0
      WHERE is_special = 1
        AND (was_price IS NULL OR was_price <= price)
        AND (promo IS NULL OR promo NOT LIKE '%for%$%')
        AND product_id IN (SELECT id FROM products WHERE chain = 'coles')`,
    'ALTER TABLE products ADD COLUMN in_stock_2 INTEGER',
  ],
  // 0.7.3: a one-off buy found at a shop keeps what it is (photo, size, brand) for the list.
  ['ALTER TABLE list_entries ADD COLUMN product TEXT'],
  // 0.8.0: phone-to-phone sync (SyncEngine.java). Every change to a synced table is noted in
  // sync_log by triggers, whether the screens or the background price check made it.
  SYNC_MIGRATION,
];

/** The database version before sync was added, for "back up before updating" (0.8.0). */
export const SYNC_VERSION = MIGRATIONS.indexOf(SYNC_MIGRATION);

export async function migrate(driver: SqlDriver): Promise<void> {
  const [{ user_version }] = await driver.query<{ user_version: number }>('PRAGMA user_version');
  for (let v = Number(user_version); v < MIGRATIONS.length; v++) {
    await driver.batch([...MIGRATIONS[v].map((sql) => ({ sql })), { sql: `PRAGMA user_version = ${v + 1}` }]);
  }
}
