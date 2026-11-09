// 0.9.0: the list widget shows the lines from tabs that are switched on, in the list's own A to Z order.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, CapacitorHttp: {}, registerPlugin: () => ({}) }));

describe('widget list', () => {
  it('leaves out switched-off tabs and sorts A to Z, groceries first', async () => {
    const { widgetList } = await import('./widgets');
    const { DEFAULT_SETTINGS } = await import('../types');
    const groups = [
      { id: 'g1', name: 'weet-bix', section: undefined },
      { id: 'g2', name: 'Beer', section: 'keg' as const },
      { id: 'g3', name: 'Panadol', section: 'pharmacy' as const },
    ];
    const e = (id: string, text: string, extra: object = {}) => ({ id, text, checked: false, createdAt: id, ...extra });
    const entries = [
      e('1', 'Weet-Bix', { groupId: 'g1' }),
      e('2', 'Beer', { groupId: 'g2' }),
      e('3', 'apples'),
      e('4', 'Ice', { section: 'keg' }),
      e('5', 'Panadol', { groupId: 'g3' }),
      e('6', 'Bananas', { checked: true }),
    ];
    const settings = { ...DEFAULT_SETTINGS, sections: { keg: true, pharmacy: false }, enabledChains: [...DEFAULT_SETTINGS.enabledChains, 'bws' as const] };
    const { open, label } = widgetList(entries, groups, settings);
    expect(open.map(label)).toEqual(['apples', 'weet-bix', 'Beer', 'Ice']);
  });
});
