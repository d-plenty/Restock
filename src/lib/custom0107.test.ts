import { describe, expect, it } from 'vitest';
import { applyCustomSections, checkCustomDef, customDef, LIST_NAMES, SECTION_NAMES, shareTab } from '../shops';
import { applyRows, checkValue, keysFor, settingTab } from './sharedSettings';
import { checkSettings } from './settingsCheck';

describe('0.10.7 custom sections', () => {
  it('a name, a colour and an icon (a pack icon or an emoji), checked', () => {
    expect(checkCustomDef({ name: '  Car  stuff ', colour: 'slate', icon: 'pack:car' })).toEqual({ name: 'Car stuff', colour: 'slate', icon: 'pack:car' });
    expect(checkCustomDef({ name: 'Bub', colour: 'pink', icon: '🍼' })).toEqual({ name: 'Bub', colour: 'pink', icon: '🍼' });
    expect(checkCustomDef({ name: 'X', colour: 'pink', icon: 'abc' })).toBeUndefined();
    expect(checkCustomDef({ name: 'X', colour: 'rainbow', icon: 'pack:car' })).toBeUndefined();
    expect(checkCustomDef({ name: '', colour: 'pink', icon: 'pack:car' })).toBeUndefined();
    expect(checkCustomDef({ name: '<b>', colour: 'pink', icon: 'pack:car' })).toBeUndefined();
    expect(checkCustomDef({ name: 'x'.repeat(31), colour: 'pink', icon: 'pack:car' })).toBeUndefined();
  });

  it('Baby and Pets keep their look until changed; names follow settings', () => {
    expect(customDef(undefined, 'baby')).toEqual({ name: 'Baby', colour: 'pink', icon: 'pack:bottle' });
    applyCustomSections({ customSections: { c1: { name: 'Car stuff', colour: 'slate', icon: 'pack:car' } } });
    expect(SECTION_NAMES.c1).toBe('Car stuff');
    expect(LIST_NAMES.c1).toBe('Car stuff');
    applyCustomSections(undefined);
  });

  it('shared with Groceries, like Baby and Pets', () => {
    expect(shareTab('c3')).toBe('pantry');
    expect(settingTab('tab:c2', 'true')).toBe('pantry');
    expect(settingTab('custom:c2', '{}')).toBe('pantry');
    expect(checkValue('tab:c2', true)).toBe(true);
    expect(checkValue('tab:c9', true)).toBeUndefined();
    expect(checkValue('custom:c2', { name: 'Tools', colour: 'orange', icon: 'pack:tools' })).toEqual({ name: 'Tools', colour: 'orange', icon: 'pack:tools' });
    expect(checkValue('custom:pantry', { name: 'Tools', colour: 'orange', icon: 'pack:tools' })).toBeUndefined();
  });

  it('household rows switch it on and give it its name, on every phone', () => {
    const s: Record<string, unknown> = { sections: { keg: false, pharmacy: false } };
    const changed = applyRows(
      s,
      [
        { k: 'tab:c1', v: 'true' },
        { k: 'custom:c1', v: JSON.stringify({ name: 'Tools', colour: 'orange', icon: 'pack:tools' }) },
      ],
      new Set(['pantry']),
    );
    expect(changed).toBe(true);
    expect(s.sections).toEqual({ keg: false, pharmacy: false, c1: true });
    expect(s.customSections).toEqual({ c1: { name: 'Tools', colour: 'orange', icon: 'pack:tools' } });
    expect(keysFor(s, new Set(['pantry']))).toEqual(expect.arrayContaining(['tab:c1', 'custom:c1']));
  });

  it('kept in settings', () => {
    const s = checkSettings({ sections: { c2: true, baby: true, c9: true }, customSections: { c2: { name: 'Office', colour: 'purple', icon: 'pack:office' }, c3: { name: 'x', colour: 'nope', icon: 'x' } } });
    expect(s.sections).toEqual({ keg: false, pharmacy: false, baby: true, c2: true });
    expect(s.customSections).toEqual({ c2: { name: 'Office', colour: 'purple', icon: 'pack:office' } });
  });
});
