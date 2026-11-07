import { putBackRows, restoreSnapshot, rowsForGroups, saveRows, snapshot, type RowSet } from './db';

/**
 * Run a change that removes things, and return a function that puts them back exactly as they
 * were. Used for the Undo button on delete toasts instead of "Are you sure?" questions.
 * Pass the rows the change touches (see the helpers below) so only those are remembered;
 * without them the whole database is copied, which is slower.
 */
export async function undoable(change: () => Promise<void>, rows?: RowSet[] | Promise<RowSet[]>): Promise<() => Promise<void>> {
  const sets = rows ? await rows : undefined;
  if (!sets) {
    const before = await snapshot();
    await change();
    return () => restoreSnapshot(before);
  }
  const saved = await saveRows(sets);
  await change();
  return () => putBackRows(saved);
}

export const groupRows = (ids: string[]) => rowsForGroups(ids);

export const entryRows = (ids: string[]): RowSet[] =>
  ids.length ? [{ table: 'list_entries', where: `id IN (${ids.map(() => '?').join(',')})`, params: ids }] : [];

export const cardRows = (id: string): RowSet[] => [{ table: 'cards', where: 'id = ?', params: [id] }];

/** Removing one product from an item touches the item, that product and its prices. */
export const productRows = (groupId: string, productId: string): RowSet[] => [
  { table: 'items', where: 'id = ?', params: [groupId] },
  { table: 'products', where: 'id = ?', params: [productId] },
  { table: 'prices', where: 'product_id = ?', params: [productId] },
];
