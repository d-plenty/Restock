import { describe, expect, it } from 'vitest';
import { ACCENTS, ICON_COLOURS, nearestIcon } from './looks';
import { accentVars, contrast, textOn } from './theme';

describe('colours people can pick', () => {
  it('keeps every accent readable, in light and dark', () => {
    for (const a of ACCENTS) {
      for (const dark of [false, true]) {
        const v = accentVars(a.hex, dark);
        // Links and labels in the accent colour against the page.
        expect(contrast(v['--green'], dark ? '#111b30' : '#ffffff'), `${a.name} ${dark ? 'dark' : 'light'}`).toBeGreaterThanOrEqual(4.5);
        // Button text on the accent colour.
        expect(contrast(v['--on-accent'], v['--green-solid']), a.name).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('puts black text on gold and white text on navy', () => {
    expect(textOn('#ffcd00')).toBe('#111111');
    expect(textOn('#012169')).toBe('#ffffff');
  });

  it('matches an accent to the nearest built-in icon colour', () => {
    expect(nearestIcon('#00843d').id).toBe('green');
    expect(nearestIcon('#c8102e').id).toBe('red');
    expect(nearestIcon('#ffd000').id).toBe('gold');
    expect(new Set(ICON_COLOURS.map((c) => c.id)).size).toBe(16);
  });
});
