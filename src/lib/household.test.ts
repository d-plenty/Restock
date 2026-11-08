import { describe, expect, it } from 'vitest';
import { householdSettingsFor } from './household';
import { mergeSettings } from './db';
import type { Settings } from '../types';

const owner: Partial<Settings> = {
  enabledChains: ['coles', 'woolworths', 'bws', 'chemistwarehouse'] as Settings['enabledChains'],
  stores: { coles: { primary: 'Coles Townsville', storeId: '1' }, bws: { primary: 'BWS Bohle' } } as Settings['stores'],
  sections: { keg: true, pharmacy: true },
  historyWeeks: 26,
  checkIntervalHours: 24,
  alerts: { ...mergeSettings({}).alerts, daily: true },
  look: { style: 'plain', icon: 'blue' },
  household: { name: 'Declan and Sarah' },
};

describe('joining a household (0.8.5)', () => {
  it('takes the shared settings but not the personal ones', () => {
    const mine = mergeSettings({ look: { style: 'australia', icon: 'green' } });
    const out = householdSettingsFor(mine, owner, { tabs: ['pantry'], replace: true });
    expect(out.historyWeeks).toBe(26);
    expect(out.checkIntervalHours).toBe(24);
    expect(out.household.name).toBe('Declan and Sarah');
    expect(out.look.style).toBe('australia');
    expect(out.alerts.daily).toBe(mine.alerts.daily);
  });

  it('turns on only the tabs this phone shares', () => {
    const out = householdSettingsFor(mergeSettings({}), owner, { tabs: ['pantry', 'pharmacy'], replace: true });
    expect(out.sections.pharmacy).toBe(true);
    expect(out.sections.keg).toBe(false);
    expect(out.enabledChains).toContain('chemistwarehouse');
    expect(out.enabledChains).not.toContain('bws');
    expect(out.stores.coles?.primary).toBe('Coles Townsville');
  });

  it('Keg comes on (and counts as 18+) when shared', () => {
    const out = householdSettingsFor(mergeSettings({}), owner, { tabs: ['pantry', 'keg'], replace: true });
    expect(out.sections.keg).toBe(true);
    expect(out.adultConfirmed).toBe(true);
  });

  it("combine keeps this phone's shops and branches and adds the household's", () => {
    const mine = mergeSettings({
      enabledChains: ['coles', 'aldi'] as Settings['enabledChains'],
      stores: { coles: { primary: 'Coles Aitkenvale' } } as Settings['stores'],
    });
    const out = householdSettingsFor(mine, owner, { tabs: ['pantry', 'keg'], replace: false });
    expect(out.enabledChains).toEqual(expect.arrayContaining(['coles', 'aldi', 'woolworths', 'bws']));
    expect(out.stores.coles?.primary).toBe('Coles Aitkenvale');
    expect(out.stores.bws?.primary).toBe('BWS Bohle');
    expect(out.sections.keg).toBe(true);
  });

  it('marks the tiles the household covered as set up', () => {
    const mine = mergeSettings({ setup: { done: [], skipped: ['history', 'look'] } });
    const out = householdSettingsFor(mine, owner, { tabs: ['pantry'], replace: true });
    for (const t of ['pantry', 'history', 'checks', 'recalls', 'household', 'sync']) expect(out.setup.done).toContain(t);
    expect(out.setup.done).not.toContain('look');
    expect(out.setup.skipped).toEqual(['look']);
  });
});
