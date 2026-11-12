import { toPicks } from '../picks';
import type { SqlDriver, SqlOp } from './driver';

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
  // 0.8.2: the household itself (its name, owner phone and members), as key/value rows.
  { table: 'household', key: 'k', deletes: true },
];

const STAMP = `MAX(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), COALESCE((SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'clock'), 0))`;
const DEVICE = `COALESCE((SELECT value FROM sync_meta WHERE key = 'device'), '')`;
const NEXT_SEQ = `COALESCE((SELECT MAX(seq) FROM sync_log), 0) + 1`;
const NOT_APPLYING = `NOT EXISTS (SELECT 1 FROM sync_meta WHERE key = 'applying')`;

function syncTriggers(t: { table: string; key: string; deletes: boolean }): string[] {
  const key = (row: 'NEW' | 'OLD') => t.key.replace(/\b(id|product_id|date|k)\b/g, `${row}.$1`);
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
  ...SYNCED.filter((t) => t.table !== 'household').map(
    (t) =>
      `INSERT OR IGNORE INTO sync_log (tbl, pk, stamp, device, deleted, seq)
       SELECT '${t.table}', ${t.key}, ${STAMP}, ${DEVICE}, 0, (SELECT COALESCE(MAX(seq), 0) FROM sync_log) + rowid FROM ${t.table}`,
  ),
  ...SYNCED.filter((t) => t.table !== 'household').flatMap(syncTriggers),
];

/**
 * 0.8.5: a change is always stamped at least a millisecond after the newest one this phone has
 * taken in, so two phones can never disagree over a tie.
 */
const STAMP_AFTER = `MAX(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), COALESCE((SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'clock'), 0) + 1)`;

/**
 * Products' stock (in stock at your branch, and when it was checked) belongs to each phone: it
 * depends on the phone's own store, so changing only those doesn't count as a change to sync.
 * New product columns that should sync go in this list too.
 */
export const PRODUCT_SYNCED_COLUMNS = ['chain', 'name', 'brand', 'size', 'barcode', 'store_product_id', 'image_url', 'qty', 'qty_unit', 'created_at'];

/** 0.8.5: every sync trigger again, with STAMP_AFTER, and products' update trigger leaving stock out. */
const SYNC_TRIGGERS_085: string[] = SYNCED.flatMap((t) => {
  const names = [`sync_${t.table}_ins`, ...(t.deletes ? [`sync_${t.table}_upd`, `sync_${t.table}_del`] : [])];
  const fresh = syncTriggers(t).map((sql) =>
    sql
      .split(STAMP)
      .join(STAMP_AFTER)
      .replace(/AFTER UPDATE ON products /, `AFTER UPDATE OF ${PRODUCT_SYNCED_COLUMNS.join(', ')} ON products `),
  );
  return [...names.map((n) => `DROP TRIGGER IF EXISTS ${n}`), ...fresh];
});

/** 0.8.2: the synced household record (owner, members), with its own change notes. */
const HOUSEHOLD_MIGRATION: string[] = [
  `CREATE TABLE household (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  ...syncTriggers(SYNCED.find((t) => t.table === 'household')!),
];

/**
 * 0.9.0: sync, made sturdier.
 * - Each change is stamped after the record's own last change too, so a second edit to the same
 *   line always counts as newer (before, a phone that had seen a clock ahead of its own stamped
 *   both edits the same, and the second one never went anywhere).
 * - `created`: when the record was last made (or made again, like a restore). A delete beats an
 *   edit made without knowing about it; only something made again after the delete brings it back.
 * - `sig`: the household's signed changes (owner changes are signed by the owner's key).
 * - Prices: an index for the sync's look-ups by "product|date", and a deleted (tidied) price takes
 *   its change note with it, so the log doesn't keep growing.
 * - List lines: when the tick and the quantity last changed, so a tick in the shop and a quantity
 *   change at home both survive.
 */
const STAMP_090 = (t: { table: string; key: string }, row: 'NEW' | 'OLD') => {
  const key = t.key.replace(/\b(id|product_id|date|k)\b/g, `${row}.$1`);
  return `MAX(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), COALESCE((SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'clock'), 0) + 1, COALESCE((SELECT stamp FROM sync_log WHERE tbl = '${t.table}' AND pk = ${key}), 0) + 1)`;
};
/** One table's 0.9.0 sync triggers (0.9.1: also used for receipts). */
function syncTriggers090(t: { table: string; key: string; deletes: boolean }): string[] {
  const key = (row: 'NEW' | 'OLD') => t.key.replace(/\b(id|product_id|date|k)\b/g, `${row}.$1`);
  const names = [`sync_${t.table}_ins`, `sync_${t.table}_upd`, `sync_${t.table}_del`];
  const keep = (row: 'NEW' | 'OLD') => `COALESCE((SELECT created FROM sync_log WHERE tbl = '${t.table}' AND pk = ${key(row)}), 0)`;
  const log = (row: 'NEW' | 'OLD', deleted: 0 | 1, created: string) =>
    `INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq, sig, created) VALUES ('${t.table}', ${key(row)}, ${STAMP_090(t, row)}, ${DEVICE}, ${deleted}, ${NEXT_SEQ}, NULL, ${created});`;
  const out = [
    ...names.map((n) => `DROP TRIGGER IF EXISTS ${n}`),
    `CREATE TRIGGER sync_${t.table}_ins AFTER INSERT ON ${t.table} WHEN ${NOT_APPLYING} BEGIN ${log('NEW', 0, STAMP_090(t, 'NEW'))} END`,
  ];
  if (t.deletes) {
    const cols = t.table === 'products' ? `OF ${PRODUCT_SYNCED_COLUMNS.join(', ')} ` : '';
    out.push(`CREATE TRIGGER sync_${t.table}_upd AFTER UPDATE ${cols}ON ${t.table} WHEN ${NOT_APPLYING} BEGIN ${log('NEW', 0, keep('NEW'))} END`);
    out.push(`CREATE TRIGGER sync_${t.table}_del AFTER DELETE ON ${t.table} WHEN ${NOT_APPLYING} BEGIN ${log('OLD', 1, keep('OLD'))} END`);
  } else {
    // Prices are only added; a tidied-away price takes its note with it (whoever deleted it).
    out.push(`CREATE TRIGGER sync_${t.table}_del AFTER DELETE ON ${t.table} BEGIN DELETE FROM sync_log WHERE tbl = '${t.table}' AND pk = ${key('OLD')}; END`);
  }
  return out;
}
const SYNC_TRIGGERS_090: string[] = SYNCED.flatMap(syncTriggers090);
const SYNC_090: string[] = [
  'ALTER TABLE sync_log ADD COLUMN sig TEXT',
  'ALTER TABLE sync_log ADD COLUMN created INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE list_entries ADD COLUMN checked_at INTEGER',
  'ALTER TABLE list_entries ADD COLUMN qty_at INTEGER',
  `CREATE INDEX IF NOT EXISTS prices_sync_key ON prices(product_id || '|' || date)`,
  `DELETE FROM sync_log WHERE tbl = 'prices' AND NOT EXISTS (SELECT 1 FROM prices WHERE product_id || '|' || date = sync_log.pk)`,
  ...SYNC_TRIGGERS_090,
];

/**
 * 0.9.1:
 * - Receipts are noted for sync like everything else (they only go to the other phones when the
 *   household shares them: SyncEngine checks the household's "receipts" setting). The ones already
 *   here count as made now, by this phone. Photos travel separately, over the Wi-Fi only.
 * - sync_peers.seen: how far each other phone has got through this phone's own changes, so old
 *   deletes everyone has seen can be tidied away (SyncEngine.compact).
 */
export const RECEIPTS_SYNCED = { table: 'receipts', key: 'id', deletes: true };
/** Every synced table from 0.9.1 on (SYNCED, then receipts). Mirrored in SyncEngine.java's TABLES. */
export const SYNCED_091 = [...SYNCED, RECEIPTS_SYNCED];
const STAMP_NOW = `MAX(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), COALESCE((SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'clock'), 0) + 1)`;
const SYNC_091: string[] = [
  'ALTER TABLE sync_peers ADD COLUMN seen INTEGER NOT NULL DEFAULT 0',
  `INSERT OR IGNORE INTO sync_log (tbl, pk, stamp, device, deleted, seq, sig, created)
   SELECT 'receipts', id, ${STAMP_NOW}, ${DEVICE}, 0, (SELECT COALESCE(MAX(seq), 0) FROM sync_log) + rowid, NULL, ${STAMP_NOW} FROM receipts`,
  // Receipts are saved with INSERT OR REPLACE (db.ts saveReceipt), so an edit looks like an insert:
  // it keeps when the receipt was made, unless it was deleted here first, so a delete on another
  // phone still beats an edit made without knowing about it.
  ...syncTriggers090(RECEIPTS_SYNCED).map((sql) =>
    sql.startsWith('CREATE TRIGGER sync_receipts_ins')
      ? sql.replace(
          `NULL, ${STAMP_090(RECEIPTS_SYNCED, 'NEW')});`,
          `NULL, CASE WHEN (SELECT deleted FROM sync_log WHERE tbl = 'receipts' AND pk = NEW.id) = 0 THEN (SELECT created FROM sync_log WHERE tbl = 'receipts' AND pk = NEW.id) ELSE ${STAMP_090(RECEIPTS_SYNCED, 'NEW')} END);`,
        )
      : sql,
  ),
];

/**
 * 0.9.3: household-wide settings (src/lib/sharedSettings.ts): one row per setting, key/value like
 * the household table, but any phone in the household (or the web app) may change one, and the
 * later change wins per row. SyncEngine (and the web's engine) apply them to the settings.
 * A phone that was on 0.9.2 or older passed over other phones' household settings (an unknown
 * table): it reads everything again once, so they come across.
 */
export const HOUSEHOLD_SETTINGS_SYNCED = { table: 'household_settings', key: 'k', deletes: true };
/** Every synced table from 0.9.3 on. Mirrored in SyncEngine.java's TABLES. */
export const SYNCED_093 = [...SYNCED_091, HOUSEHOLD_SETTINGS_SYNCED];
const SYNC_093: string[] = [
  `CREATE TABLE household_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  ...syncTriggers090(HOUSEHOLD_SETTINGS_SYNCED),
  'UPDATE sync_peers SET got = 0',
  "DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'folder_ver:%' OR key LIKE 'server_seen:%' OR key LIKE 'server_ver:%'",
];

/**
 * 0.9.4: who made each record (`origin`, a device id; null: not known), so "Also take what this
 * phone shared off the server" takes back only what that phone added, never what other people
 * added (docs/server-protocol.md "v3"). It's set when a record is made (or made again, like a
 * restore: the same moments `created` is set) and kept through edits and deletes; a change taken
 * in from another device carries it (SyncEngine.apply, engine.ts apply). Records from before:
 * only those whose last change was the one that made them (stamp = created) are known (their
 * device made them); the rest stay unknown, so they're never taken back.
 */
function syncTriggers094(t: { table: string; key: string; deletes: boolean }): string[] {
  const key = (row: 'NEW' | 'OLD') => t.key.replace(/\b(id|product_id|date|k)\b/g, `${row}.$1`);
  const names = [`sync_${t.table}_ins`, `sync_${t.table}_upd`, `sync_${t.table}_del`];
  const had = (col: string, row: 'NEW' | 'OLD') => `(SELECT ${col} FROM sync_log WHERE tbl = '${t.table}' AND pk = ${key(row)})`;
  const keepCreated = (row: 'NEW' | 'OLD') => `COALESCE(${had('created', row)}, 0)`;
  const log = (row: 'NEW' | 'OLD', deleted: 0 | 1, created: string, origin: string) =>
    `INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq, sig, created, origin) VALUES ('${t.table}', ${key(row)}, ${STAMP_090(t, row)}, ${DEVICE}, ${deleted}, ${NEXT_SEQ}, NULL, ${created}, ${origin});`;
  // Receipts are saved with INSERT OR REPLACE (an edit looks like an insert): a live one keeps when
  // it was made, and who made it (SYNC_091).
  const live = `${had('deleted', 'NEW')} = 0`;
  const insCreated = t.table === 'receipts' ? `CASE WHEN ${live} THEN ${had('created', 'NEW')} ELSE ${STAMP_090(t, 'NEW')} END` : STAMP_090(t, 'NEW');
  const insOrigin = t.table === 'receipts' ? `CASE WHEN ${live} THEN ${had('origin', 'NEW')} ELSE ${DEVICE} END` : DEVICE;
  const out = [
    ...names.map((n) => `DROP TRIGGER IF EXISTS ${n}`),
    `CREATE TRIGGER sync_${t.table}_ins AFTER INSERT ON ${t.table} WHEN ${NOT_APPLYING} BEGIN ${log('NEW', 0, insCreated, insOrigin)} END`,
  ];
  if (t.deletes) {
    const cols = t.table === 'products' ? `OF ${PRODUCT_SYNCED_COLUMNS.join(', ')} ` : '';
    out.push(`CREATE TRIGGER sync_${t.table}_upd AFTER UPDATE ${cols}ON ${t.table} WHEN ${NOT_APPLYING} BEGIN ${log('NEW', 0, keepCreated('NEW'), had('origin', 'NEW'))} END`);
    out.push(`CREATE TRIGGER sync_${t.table}_del AFTER DELETE ON ${t.table} WHEN ${NOT_APPLYING} BEGIN ${log('OLD', 1, keepCreated('OLD'), had('origin', 'OLD'))} END`);
  } else {
    out.push(`CREATE TRIGGER sync_${t.table}_del AFTER DELETE ON ${t.table} BEGIN DELETE FROM sync_log WHERE tbl = '${t.table}' AND pk = ${key('OLD')}; END`);
  }
  return out;
}
const SYNC_094: string[] = [
  'ALTER TABLE sync_log ADD COLUMN origin TEXT',
  `UPDATE sync_log SET origin = device WHERE deleted = 0 AND created > 0 AND stamp = created AND device <> '' AND tbl <> '_seq'`,
  // 0.9.4 review: a plain delete of a record here on a tab this device doesn't sync is held (its
  // entry, as it came), not taken in, until the device syncs that tab again (SyncEngine.releaseHeld):
  // by then the others may have tidied the delete away (compact, after 90 days), and this copy,
  // offered again, would bring the record back everywhere.
  'CREATE TABLE IF NOT EXISTS sync_held (tbl TEXT NOT NULL, pk TEXT NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (tbl, pk))',
  ...SYNCED_093.flatMap(syncTriggers094),
];

/**
 * 0.9.6 (cards): gift cards, beside loyalty cards on the Cards screen. Kept on this phone only: not
 * in SYNCED (no sync triggers, so no sync_log rows), so they never go to the household's other
 * phones, a sync folder or a Restock server, and an older phone never sees one. `data` is the card
 * as JSON (types.ts GiftCard, checked by giftCards.ts cleanGiftCard when read). The Java side never
 * reads it.
 *
 * Not a MIGRATIONS entry on purpose: a Restock server builds its household.db from MIGRATIONS
 * (server-core), and it should have no gift card table at all. db.ts initDb makes it on phones (and
 * in the web page's own copy, where it stays empty: the web keeps cards in this browser's own
 * storage, server-mode/cardStore.ts). IF NOT EXISTS, so it's safe to run every time.
 */
export const GIFT_CARDS_TABLE = `CREATE TABLE IF NOT EXISTS gift_cards (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  used_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/**
 * 0.9.14: Settings → Your data without a Restock server: each tick of a list line, priced, as the
 * server's srv_spend (spending.ts). This phone's own record: not in SYNCED, not in backups, not a
 * MIGRATIONS entry (a Restock server keeps its own, srv_spend). Erase everything empties it.
 */
export const SPEND_TABLE = `CREATE TABLE IF NOT EXISTS spend_log (
  entry_id TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  at TEXT NOT NULL,
  chain TEXT,
  section TEXT,
  item_id TEXT,
  product_id TEXT,
  text TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL,
  total REAL,
  usual REAL,
  special INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, checked_at)
)`;

/** 0.8.9: "Any size" and "Not at this shop" (picks.ts); the move to My picks is in DATA_STEPS. */
const PICKS_089 = ['ALTER TABLE items ADD COLUMN any_size INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE items ADD COLUMN not_at TEXT'];

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
  // 0.8.2: owner phone and members, one-time pairing codes (SyncHousehold.java).
  HOUSEHOLD_MIGRATION,
  // 0.8.5: no ties between phones' changes, and products' stock stays on each phone.
  SYNC_TRIGGERS_085,
  // 0.8.9: My picks and Would also take, "Any size" and "Not at this shop" (picks.ts). The data
  // part is in DATA_STEPS.
  PICKS_089,
  // 0.9.0: sturdier sync (stamps, deletes, signed household changes, prices, ticks).
  SYNC_090,
  // 0.9.1: receipts sync (when the household shares them), and tidying old deletes.
  SYNC_091,
  // 0.9.3: household-wide settings.
  SYNC_093,
  // 0.9.4: who made each record (sync_log.origin).
  SYNC_094,
];

/**
 * Data changes that go with a migration, worked out in code and written in the same transaction,
 * by its place in MIGRATIONS.
 */
const DATA_STEPS: Record<number, (d: SqlDriver) => Promise<SqlOp[]>> = {
  // 0.8.9: an alternative that was an item's only product at a shop becomes one of its picks there,
  // so every store comparison comes out as it did before. Each phone does this itself, so it isn't
  // noted for sync ('applying'): a paired phone's newer edit to the same item still wins.
  [MIGRATIONS.indexOf(PICKS_089)]: async (d) => {
    type P = { id: string; chain: string; name: string; size: string | null; qty: number | null; qty_unit: string | null };
    const products = new Map((await d.query<P>('SELECT id, chain, name, size, qty, qty_unit FROM products')).map((p) => [p.id, p]));
    const rows = await d.query<{
      id: string;
      usual_product_id: string | null;
      same_product_ids: string | null;
      alt_product_ids: string | null;
      allow_bulk: number | null;
    }>('SELECT id, usual_product_id, same_product_ids, alt_product_ids, allow_bulk FROM items');
    const ops: SqlOp[] = [];
    for (const r of rows) {
      const before = {
        usualProductId: r.usual_product_id ?? undefined,
        sameProductIds: JSON.parse(r.same_product_ids || '[]') as string[],
        altProductIds: JSON.parse(r.alt_product_ids || '[]') as string[],
        allowBulk: r.allow_bulk === null ? undefined : Number(r.allow_bulk) === 1,
      };
      const after = toPicks(
        before,
        (id) => products.get(id)?.chain,
        (id) => {
          const p = products.get(id);
          return p && { name: p.name, size: p.size ?? undefined, qty: p.qty ?? undefined, qtyUnit: (p.qty_unit ?? undefined) as never };
        },
      );
      if (after === before) continue;
      ops.push({
        sql: 'UPDATE items SET usual_product_id = ?, same_product_ids = ?, alt_product_ids = ? WHERE id = ?',
        params: [after.usualProductId ?? null, JSON.stringify(after.sameProductIds), JSON.stringify(after.altProductIds), r.id],
      });
    }
    return ops.length
      ? [
          { sql: "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')" },
          ...ops,
          { sql: "DELETE FROM sync_meta WHERE key = 'applying'" },
        ]
      : [];
  },
};

/** The database version before sync was added, for "back up before updating" (0.8.0). */
export const SYNC_VERSION = MIGRATIONS.indexOf(SYNC_MIGRATION);

export async function migrate(driver: SqlDriver): Promise<void> {
  const [{ user_version }] = await driver.query<{ user_version: number }>('PRAGMA user_version');
  for (let v = Number(user_version); v < MIGRATIONS.length; v++) {
    const data = DATA_STEPS[v] ? await DATA_STEPS[v](driver) : [];
    await driver.batch([...MIGRATIONS[v].map((sql) => ({ sql })), ...data, { sql: `PRAGMA user_version = ${v + 1}` }]);
  }
}
