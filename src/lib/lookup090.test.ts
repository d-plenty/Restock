import initSqlJs from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDefaults, initDb, updateSettings } from './db';
import { createSqlJsDriver } from './sql/sqljs';
import type { Settings } from '../types';

// 0.9.0: a barcode nobody else knows is only looked up at the supermarkets you've switched on.

const asked: string[] = [];
vi.mock('../stores', () => ({
  adapterFor: (chain: string) => ({
    chain,
    search: async (code: string) => {
      asked.push(chain);
      return [{ chain, name: `${chain} thing`, barcode: code, storeProductId: '1', isSpecial: false, memberOnly: false }];
    },
  }),
}));

beforeEach(async () => {
  asked.length = 0;
  await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
  await ensureDefaults();
  // None of the open databases know it.
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
});
afterEach(() => vi.unstubAllGlobals());

describe('barcode lookups at the supermarkets (0.9.0)', () => {
  it('never asks a supermarket that is switched off', async () => {
    const { identifyBarcode } = await import('./lookup');
    await updateSettings({ enabledChains: ['aldi', 'bws'] as Settings['enabledChains'] });
    expect(await identifyBarcode('9310692112198', 'pharmacy')).toEqual({ barcode: '9310692112198' });
    expect(asked).toEqual([]);
  });

  it('asks the ones that are on, Woolworths first', async () => {
    const { identifyBarcode } = await import('./lookup');
    await updateSettings({ enabledChains: ['coles'] as Settings['enabledChains'] });
    expect((await identifyBarcode('9310692112198', 'keg')).source).toBe('Coles');
    expect(asked).toEqual(['coles']);
    asked.length = 0;
    await updateSettings({ enabledChains: ['coles', 'woolworths'] as Settings['enabledChains'] });
    expect((await identifyBarcode('9310692112198', 'pantry')).source).toBe('Woolworths');
    expect(asked).toEqual(['woolworths']);
  });
});
