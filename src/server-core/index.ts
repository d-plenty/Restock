// 0.9.4: the Restock core for the Restock server (protocol v3, docs/server-protocol.md). One ES
// module with everything bundled and nothing imported but node:* (npm run build:server-core →
// server/core/restock-core.mjs, or SERVER_CORE_OUT). The server runs the same merge, crypto, household
// settings and Home Assistant code as the web app and (ported) the phones, on a node:sqlite database
// with Restock's own schema (MIGRATIONS, applied by migrate()).
//
// Nothing here may touch a browser API at import time: the server imports it in plain Node 22.

import { migrate as migrateDriver, MIGRATIONS } from '../lib/sql/schema';
import type { SqlDriver, SqlValue } from '../lib/sql/driver';
import type { Row, SyncDb } from '../server-mode/engine';

export const CORE = { version: __APP_VERSION__, protocol: 3 } as const;

// ---------- the merge (engine.ts) ----------
export {
  WebSyncEngine,
  ownerOnly,
  fileDevice,
  isSyncFile,
  stripCard,
  newer,
  parseTabs,
  joinTabs,
  allowedName,
  allowedNameV3,
  serverFileName,
  webFileName,
  keepCutoff,
  parseServerRow,
  parseShares,
  TABLES,
  ALL_TABS,
  KEEP_MONTHS,
  MONTH_MS,
  SERVER_PRICES_MS,
  OLD_DELETE_MS,
  COMPACT_AFTER_MS,
} from '../server-mode/engine';
export type { Row, SyncDb, Entry, SyncFileMessage, Shares, EngineOptions, ServerRow, SigCheck } from '../server-mode/engine';

// ---------- crypto (crypto.ts) ----------
export {
  // bytes
  b64u,
  unb64,
  hex,
  random,
  sha256hex,
  // RSF1 and serverKeys
  openRsf1,
  sealRsf1,
  openWithAny,
  serverKeyOf,
  // P-256 keys
  spkiOf,
  pointOf,
  newEcdhKey,
  publicOf,
  pkcs8Of,
  privOfPkcs8,
  newJavaKeyPair,
  // v2 link (Sign in with a phone in v2 mode, webkeys/ for 0.9.3 browsers)
  linkKey,
  sealLink,
  openLink,
  openGift,
  sealGift,
  openWebKeys,
  sealWebKeys,
  // household signatures
  signedText,
  signText,
  signWithPkcs8,
  verifySig,
  // v3
  ecdh,
  hkdf32,
  sealJson,
  openJson,
  joinKey,
  sealJoin,
  openJoin,
  memberJoinText,
  keysFileKey,
  sealKeysFile,
  openKeysFile,
  handoverKey,
  sealHandover,
  openHandover,
  haKey,
  sealHa,
  openHa,
  loginKeyOf,
  loginProof,
  sessionKeyOf,
  requestText,
  requestMac,
  macOk,
  webAuthorization,
  parseAuthorization,
  // the recovery key
  base32,
  unbase32,
  formatRecovery,
  recoveryKeyOf,
  sealRecovery,
  openRecovery,
  RECOVERY_BYTES,
  RSJ3,
  RSE3,
  RSH3,
  RSA3,
  SERVER_KEY_INFO,
} from '../server-mode/crypto';
export type { JoinGift, RecoveryCopy, LinkGift } from '../server-mode/crypto';

// ---------- household settings (sharedSettings.ts) ----------
export { applyRows, settingChangeOk, checkListRow, settingTab, isListRow, decode, HA_PHONE, ALIAS_PREFIX, KEEP_PREFIX } from '../lib/sharedSettings';
export { cleanSummary } from '../lib/phoneSummary';

// ---------- Home Assistant (haSync.ts, haMatch.ts) ----------
export { syncRound, syncRound as haSyncRound, restApi, haLists, haProblem, tooOld, haLineId, emptyState, summaryOf, HaError, MIN_HA_VERSION, EMPTY_HOLD_MS, EMPTY_GAP_MS, TOKEN_REFUSED } from '../lib/haSync';
export type { HaItem, HaApi, Transport, HaState, HaPair, Line, Store, RoundResult } from '../lib/haSync';
export { matchKey, parseLine, lineSummary, candidates, matchOne } from '../lib/haMatch';
export type { NamedItem } from '../lib/haMatch';

// ---------- the database ----------
export { MIGRATIONS };

/** What the core needs of a node:sqlite DatabaseSync (structurally, so the core imports nothing). */
export interface NodeSqlite {
  exec(sql: string): void;
  prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } };
}

/** A value node:sqlite can bind: null, numbers, strings, bytes (booleans as 1/0, the rest as text). */
function bindable(args: readonly unknown[] | undefined): (string | number | bigint | null | Uint8Array)[] {
  return (args ?? []).map((a) =>
    a === undefined || a === null
      ? null
      : typeof a === 'boolean'
        ? a
          ? 1
          : 0
        : typeof a === 'number' || typeof a === 'string' || typeof a === 'bigint' || a instanceof Uint8Array
          ? a
          : String(a),
  );
}

/**
 * The engine's database (SyncDb) on a node:sqlite DatabaseSync, synchronously: query = prepare().all(),
 * exec = prepare().run(), transaction = BEGIN/COMMIT, nested ones joining the outer one (as sqldb.ts).
 */
export function syncDbOfNode(db: NodeSqlite): SyncDb {
  let depth = 0;
  return {
    query(sql, args) {
      return db.prepare(sql).all(...bindable(args)).map((r) => ({ ...(r as Row) }));
    },
    exec(sql, args) {
      db.prepare(sql).run(...bindable(args));
    },
    transaction(body) {
      if (depth++ === 0) db.exec('BEGIN');
      try {
        body();
        if (depth === 1) db.exec('COMMIT');
      } catch (e) {
        if (depth === 1) db.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
  };
}

/** The app's SqlDriver on a node:sqlite DatabaseSync (for migrate, and anything written for the app's driver). */
export function sqlDriverOfNode(db: NodeSqlite): SqlDriver {
  const run = (sql: string, params?: SqlValue[]) => {
    const r = db.prepare(sql).run(...bindable(params));
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  };
  return {
    async query<T>(sql: string, params?: SqlValue[]) {
      return db.prepare(sql).all(...bindable(params)).map((r) => ({ ...(r as object) })) as T[];
    },
    async run(sql, params) {
      return run(sql, params);
    },
    async batch(ops) {
      db.exec('BEGIN');
      try {
        for (const op of ops) run(op.sql, op.params);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/**
 * Brings a node:sqlite database up to Restock's schema: MIGRATIONS in order, each with its data
 * step, exactly as the app's initDb does (PRAGMA user_version counts them). Safe to run every start.
 * The caller sets `PRAGMA journal_mode=WAL` and sync_meta device/name itself.
 */
export async function migrate(db: NodeSqlite): Promise<void> {
  await migrateDriver(sqlDriverOfNode(db));
}
