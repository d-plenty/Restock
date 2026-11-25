import initSqlJs from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDefaults, initDb, updateSettings } from './db';
import { createSqlJsDriver } from './sql/sqljs';
import type { Settings } from '../types';

// 0.9.0: a barcode nobody else knows is only looked up at the supermarkets you've switched on.

const asked: string[] = [];
/** 0.9.1: the usual search and the hidden browser (which carry the browser's cookies, and any sign-in). */
const signedInSearches: string[] = [];
const jars: string[] = [];
/** 0.9.1: shops whose anonymous request is turned away (as Coles' bot check often does). */
const blocked = new Set<string>();
const thing = (chain: string, code: string) => [
  { chain, name: `${chain} thing`, barcode: code, storeProductId: '1', isSpecial: false, memberOnly: false },
];
vi.mock('../stores', () => ({
  // Like the real adapters: Woolworths has a hidden-browser search of its own; Coles' usual search
  // on the phone is the hidden browser.
  adapterFor: (chain: string) => ({
    chain,
    search: async (code: string) => {
      signedInSearches.push(`${chain} search`);
      return thing(chain, code);
    },
    ...(chain === 'woolworths'
      ? {
          searchBrowser: async (code: string) => {
            signedInSearches.push(`${chain} browser`);
            return thing(chain, code);
          },
        }
      : {}),
    searchAnonymous: async (code: string, jar: string) => {
      asked.push(chain);
      jars.push(jar);
      if (blocked.has(chain)) throw new Error(`${chain} blocked the price check`);
      return thing(chain, code);
    },
  }),
}));

beforeEach(async () => {
  asked.length = 0;
  signedInSearches.length = 0;
  jars.length = 0;
  blocked.clear();
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

  it('0.9.1: asks anonymously first, on the lookup cookie jar', async () => {
    const { identifyBarcode, LOOKUP_JAR } = await import('./lookup');
    await updateSettings({
      enabledChains: ['woolworths', 'coles'] as Settings['enabledChains'],
      accounts: { woolworths: { signedIn: true, checkedAt: new Date().toISOString() } },
    });
    expect((await identifyBarcode('9310692112198', 'pantry')).source).toBe('Woolworths');
    expect(signedInSearches).toEqual([]);
    expect(jars).toEqual([LOOKUP_JAR]);
    expect(LOOKUP_JAR).toBe('lookup');
  });
});

describe('barcode lookups never go with your shop account (0.9.1)', () => {
  const at = new Date().toISOString();
  const CODE = '9310692112198';

  it('Woolworths, signed in: turned away anonymously, it never falls back to the hidden browser', async () => {
    const { searchForBarcode } = await import('./lookup');
    await updateSettings({ accounts: { woolworths: { signedIn: true, checkedAt: at } } });
    blocked.add('woolworths');
    await expect(searchForBarcode('woolworths', CODE)).rejects.toThrow(/blocked/);
    expect(asked).toEqual(['woolworths']);
    expect(signedInSearches).toEqual([]);
  });

  it('Woolworths, not signed in: turned away anonymously, the hidden browser as in 0.9.0', async () => {
    const { searchForBarcode } = await import('./lookup');
    await updateSettings({ accounts: { woolworths: { signedIn: false, checkedAt: at } } });
    blocked.add('woolworths');
    expect((await searchForBarcode('woolworths', CODE))[0].barcode).toBe(CODE);
    expect(asked).toEqual(['woolworths']);
    expect(signedInSearches).toEqual(['woolworths browser']);
  });

  it('Coles, signed in: turned away anonymously, Coles just isn\'t asked (and the lookup carries on)', async () => {
    const { identifyBarcode, searchForBarcode } = await import('./lookup');
    await updateSettings({ enabledChains: ['coles'] as Settings['enabledChains'], accounts: { coles: { signedIn: true, checkedAt: at } } });
    blocked.add('coles');
    await expect(searchForBarcode('coles', CODE)).rejects.toThrow(/blocked/);
    expect(await identifyBarcode(CODE, 'pantry')).toEqual({ barcode: CODE });
    expect(signedInSearches).toEqual([]);
  });

  it('Coles, not signed in: turned away anonymously, the usual Coles search (its hidden browser) as in 0.9.0', async () => {
    const { identifyBarcode } = await import('./lookup');
    await updateSettings({ enabledChains: ['coles'] as Settings['enabledChains'] });
    blocked.add('coles');
    expect((await identifyBarcode(CODE, 'pantry')).source).toBe('Coles');
    expect(asked).toEqual(['coles']);
    expect(signedInSearches).toEqual(['coles search']);
  });

  it("signed in to one shop doesn't stop the other's backup", async () => {
    const { identifyBarcode } = await import('./lookup');
    await updateSettings({
      enabledChains: ['woolworths', 'coles'] as Settings['enabledChains'],
      accounts: { woolworths: { signedIn: true, checkedAt: at } },
    });
    blocked.add('woolworths');
    blocked.add('coles');
    expect((await identifyBarcode(CODE, 'pantry')).source).toBe('Coles');
    expect(asked).toEqual(['woolworths', 'coles']);
    expect(signedInSearches).toEqual(['coles search']);
  });

  it('not blocked: the anonymous answer is used, never the browser, signed in or not', async () => {
    const { searchForBarcode } = await import('./lookup');
    await updateSettings({ accounts: {} });
    expect((await searchForBarcode('coles', CODE))[0].barcode).toBe(CODE);
    expect((await searchForBarcode('woolworths', CODE))[0].barcode).toBe(CODE);
    expect(signedInSearches).toEqual([]);
  });
});
