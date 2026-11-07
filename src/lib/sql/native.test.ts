import initSqlJs from 'sql.js';
import { describe, expect, it, vi } from 'vitest';

// Stand-in for the Java plugin: same method names and argument shapes as
// RestockNativePlugin.java, backed by real SQLite (sql.js).
const calls: string[] = [];
const badValues: unknown[] = [];

vi.mock('@capacitor/core', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const checkValues = (values: unknown[]) => {
    for (const v of values) {
      const ok = v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
      if (!ok) badValues.push(v);
    }
  };
  const plugin = {
    async sqlQuery({ sql, values }: { sql: string; values: unknown[] }) {
      calls.push('query');
      checkValues(values);
      const st = db.prepare(sql);
      st.bind(values as never);
      const rows: Record<string, unknown>[] = [];
      while (st.step()) rows.push(st.getAsObject());
      st.free();
      // The bridge sends JSON: make sure rows survive a JSON round trip.
      return JSON.parse(JSON.stringify({ rows }));
    },
    async sqlRun({ sql, values }: { sql: string; values: unknown[] }) {
      calls.push('run');
      checkValues(values);
      db.run(sql, values as never);
      return { changes: db.getRowsModified(), lastId: 0 };
    },
    async sqlBatch({ ops }: { ops: { sql: string; values: unknown[] }[] }) {
      calls.push('batch');
      db.run('BEGIN');
      for (const op of ops) {
        checkValues(op.values);
        db.run(op.sql, op.values as never);
      }
      db.run('COMMIT');
    },
  };
  return { registerPlugin: () => plugin, Capacitor: { isNativePlatform: () => false } };
});

describe('native bridge contract', () => {
  it('runs migrations, sample data and verdicts through the plugin calls', async () => {
    const { createNativeDriver } = await import('./native');
    const { initDb, ensureDefaults, addCard, uid } = await import('../db');
    const { loadDemo } = await import('../demo');
    const { loadRecommendations } = await import('../recs');

    await initDb(createNativeDriver());
    await ensureDefaults();
    await loadDemo();
    await addCard({ id: uid(), program: 'flybuys', label: 'Flybuys', number: '6008940000000000', createdAt: '' });
    const recs = await loadRecommendations();

    expect(recs).toHaveLength(7);
    expect(Object.fromEntries(recs.map((r) => [r.group.name, r.action]))).toMatchObject({
      'A4 copy paper': 'buy',
      'Toilet paper': 'alt',
      'Ground coffee 1kg': 'wait',
      'Dishwasher tablets': 'skip',
      'Laundry liquid 2L': 'none',
      'Milk 2L': 'none',
      'Spaghetti 500g': 'small',
    });
    expect(calls).toContain('batch');
    expect(badValues).toEqual([]);
  });
});
