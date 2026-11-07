import type { SqlDriver } from './driver';

// The database layout. The Android background worker (PriceCheckWorker.java) reads and
// writes these same tables, so any change here must be mirrored there.
// Each entry is one migration; never edit a shipped one, only append.
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
];

export async function migrate(driver: SqlDriver): Promise<void> {
  const [{ user_version }] = await driver.query<{ user_version: number }>('PRAGMA user_version');
  for (let v = Number(user_version); v < MIGRATIONS.length; v++) {
    await driver.batch([...MIGRATIONS[v].map((sql) => ({ sql })), { sql: `PRAGMA user_version = ${v + 1}` }]);
  }
}
