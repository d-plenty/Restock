// A tiny SQL interface the app talks to. On Android it's backed by the phone's own
// SQLite (through the native RestockNative plugin); in the browser preview and in tests
// it's backed by sql.js (SQLite compiled to WebAssembly).

export type SqlValue = string | number | null;

export interface RunResult {
  changes: number;
  lastId: number;
}

export interface SqlOp {
  sql: string;
  params?: SqlValue[];
}

export interface SqlDriver {
  /** Read rows. Column names come back exactly as written in the SQL. */
  query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** One write statement. */
  run(sql: string, params?: SqlValue[]): Promise<RunResult>;
  /** Several writes in one transaction: all or nothing. */
  batch(ops: SqlOp[]): Promise<void>;
}
