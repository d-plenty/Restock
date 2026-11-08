import initSqlJs from 'sql.js';
import { expect, it } from 'vitest';
import { createSqlJsDriver } from './sql/sqljs';
import { allGroups, ensureDefaults, eraseEverything, getSettings, initDb, updateSettings } from './db';
import { loadDemo } from './demo';

it('erase everything leaves an empty Restock, with nothing noted for sync (0.8.2)', async () => {
  const SQL = await initSqlJs();
  await initDb(await createSqlJsDriver({ load: async () => SQL, restore: async () => undefined, persist: async () => undefined }));
  await ensureDefaults();
  await updateSettings({ onboarded: true });
  await loadDemo();
  expect((await allGroups()).length).toBeGreaterThan(0);
  await eraseEverything();
  expect(await allGroups()).toEqual([]);
  expect((await getSettings()).onboarded).toBe(false);
});
