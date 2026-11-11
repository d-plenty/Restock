import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addProduct, addReading, deleteReading, ensureDefaults, getProductsByBarcode, initDb, readingsFor } from './db';
import { createSqlJsDriver } from './sql/sqljs';
import { act, clearUndo, undo } from './undo';

// 0.9.6: a price typed in by hand is stored as 'manual' (entered by hand), and can be undone or deleted (and the delete undone).

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
beforeEach(async () => {
  await initDb(await createSqlJsDriver({ load: async () => SQL }));
  await ensureDefaults();
  clearUndo();
  await addProduct({ id: 'costco1', chain: 'costco', name: 'Kirkland Coffee 1.58kg', barcode: '0096619900012', createdAt: '2026-11-10T00:00:00.000Z' } as never);
});

const manual = async () => ((await readingsFor(['costco1'])).get('costco1') ?? []).filter((r) => r.source === 'manual');

describe('prices entered by hand', () => {
  it('are saved with their day, marked as by hand, and can be undone', async () => {
    await act('Price $32.99 added', () =>
      addReading({ productId: 'costco1', date: '2026-11-09T12:00:00.000Z', price: 32.99, isSpecial: false, memberOnly: false, source: 'manual' }),
    );
    const got = await manual();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ price: 32.99, date: '2026-11-09T12:00:00.000Z', source: 'manual' });
    await undo();
    expect(await manual()).toHaveLength(0);
  });

  it('can be deleted, and the delete undone', async () => {
    await addReading({ productId: 'costco1', date: '2026-11-09T12:00:00.000Z', price: 32.99, isSpecial: false, memberOnly: false, source: 'manual' });
    const [r] = await manual();
    await act('Price $32.99 deleted', () => deleteReading(r.id!));
    expect(await manual()).toHaveLength(0);
    await undo();
    expect((await manual()).map((x) => x.price)).toEqual([32.99]);
  });
});

describe('finding the same barcode', () => {
  it('finds saved products by barcode', async () => {
    const found = await getProductsByBarcode(['0096619900012', '123']);
    expect(found.map((p) => p.id)).toEqual(['costco1']);
    expect(await getProductsByBarcode([])).toEqual([]);
  });
});
