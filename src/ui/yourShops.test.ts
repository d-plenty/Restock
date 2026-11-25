// 0.15.1: Home's shop buttons and More → Your shops show the shops you still use. A shop taken off
// its tab keeps its saved branch (for if it's picked again), but that no longer brings it back.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../types';
import { yourShops } from './screens/Catalogues';

const settings = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over }) as Settings;

describe('0.15.1: your shops', () => {
  it('are the shops picked for your tabs', () => {
    const s = settings({ enabledChains: ['coles', 'woolworths', 'aldi'], stores: { coles: { primary: 'Coles Town' }, woolworths: {}, aldi: {} } });
    expect(yourShops(s)).toEqual(['coles', 'woolworths', 'aldi']);
  });
  it('a removed shop with a branch still saved stays off Home', () => {
    const s = settings({
      enabledChains: ['coles', 'woolworths', 'aldi'],
      stores: { coles: { primary: 'Coles Town' }, woolworths: {}, aldi: {}, iga: { primary: 'IGA Town' } },
    });
    expect(yourShops(s)).not.toContain('iga');
  });
  it('the same shop picked again comes back, with its branch', () => {
    const s = settings({ enabledChains: ['coles', 'iga'], stores: { coles: {}, iga: { primary: 'IGA Town' } } });
    expect(yourShops(s)).toContain('iga');
  });
});
