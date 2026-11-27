import { describe, expect, it } from 'vitest';
import { mergeSettings } from './db';
import { checkSettings } from './settingsCheck';
import { leaveSimple, pickSimple } from './simple';
import { accentVars, bandColour, barVars, contrast } from './theme';
import { widgetAppColours } from './widgets';
import { hexToHsv, hsvToHex } from '../ui/ColourWheel';
import { chunkSections } from '../ui/useChunks';

describe('0.18.1: the Simple design', () => {
  it('turns the animations off and Less motion on, and going back puts them back as they were', () => {
    const s = mergeSettings({});
    const simple = pickSimple({ look: { ...s.look, opening: true, holidays: false }, a11y: { ...s.a11y, motion: false } });
    expect(simple.look).toMatchObject({ style: 'simple', opening: false, holidays: false, simpleWas: { opening: true, holidays: false, motion: false } });
    expect(simple.a11y.motion).toBe(true);
    const back = leaveSimple(simple);
    expect(back.look).toMatchObject({ style: 'australia', opening: true, holidays: false });
    expect(back.look.simpleWas).toBeUndefined();
    expect(back.a11y.motion).toBe(false);
    // Turned back on while in Simple, then back to the default theme: as they were before Simple.
    expect(leaveSimple({ ...simple, look: { ...simple.look, opening: true } }).look.opening).toBe(true);
  });

  it('reads an old Plain as Simple', () => {
    expect(checkSettings({ look: { style: 'plain', icon: 'match' } }).look.style).toBe('simple');
    expect(checkSettings({ look: { style: 'neon', icon: 'match' } }).look.style).toBe('australia');
  });

  it('has the accent as its band, and plain black in dark mode unless the band is kept', () => {
    const look = { style: 'simple' as const, icon: 'match' };
    expect(bandColour(look, false)).toBe('#00843d');
    expect(bandColour({ ...look, accent: '#6b3fa0' }, false)).toBe('#6b3fa0');
    expect(bandColour({ ...look, accent: '#6b3fa0', bar: '#123456' }, false)).toBe('#123456');
    expect(bandColour({ ...look, accent: '#6b3fa0' }, true)).toBe('#000000');
    expect(bandColour({ ...look, accent: '#6b3fa0', band: true }, true)).toBe('#6b3fa0');
    // The default theme: navy (nothing set) unless a theme colour is picked.
    expect(bandColour({ style: 'australia', icon: 'match' }, false)).toBeUndefined();
    expect(bandColour({ style: 'australia', icon: 'match', bar: '#c8102e' }, false)).toBe('#c8102e');
  });

  it('keeps text readable on any theme colour, and gold only where gold reads', () => {
    for (const c of ['#ffcd00', '#ffffff', '#012169', '#00843d', '#c8102e', '#000000', '#f4f1e8']) {
      for (const dark of [false, true]) {
        const { vars } = barVars(c, { dark, simple: false });
        expect(contrast(vars['--on-navy'], vars['--more-top'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(vars['--tab-pill'], vars['--tabbar-bg'])).toBeGreaterThanOrEqual(1.5);
      }
    }
    expect(barVars('#012169', { dark: false, simple: false }).plain).toBe(false);
    expect(barVars('#ffcd00', { dark: false, simple: false }).plain).toBe(true);
    expect(barVars('#012169', { dark: false, simple: true }).plain).toBe(true);
    // Simple's accent on white and on black reads as text.
    for (const a of ['#ffcd00', '#00843d', '#1b1b1b']) {
      expect(contrast(accentVars(a, false, false, true)['--green'], '#ffffff')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accentVars(a, true, false, true)['--green'], '#000000')).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('gives the widgets the theme colour, the accent and the icon colour, where they read', () => {
    const navy = widgetAppColours({ style: 'australia', icon: 'match' }, false);
    expect(navy.bg).toBe('#012169');
    expect(contrast(navy.title, navy.bg)).toBeGreaterThanOrEqual(3);
    const gold = widgetAppColours({ style: 'australia', icon: 'gold', accent: '#ffcd00', bar: '#ffcd00' }, false);
    expect(gold.bg).toBe('#ffcd00');
    expect(gold.title).toBe('#0f1d3d');
    expect(gold.icon).toBe('#0f1d3d');
  });

  it('cuts long lists into parts', () => {
    const s = [{ items: [1, 2, 3] }, { items: [4, 5] }, { items: [6] }];
    expect(chunkSections(s, Infinity)).toBe(s);
    expect(chunkSections(s, 4).map((x) => x.items)).toEqual([[1, 2, 3], [4]]);
    expect(chunkSections(s, 3).map((x) => x.items)).toEqual([[1, 2, 3]]);
  });

  it("the colour wheel's colours go there and back", () => {
    for (const h of ['#00843d', '#ffcd00', '#012169', '#ffffff', '#000000', '#6b3fa0', '#c8102e']) expect(hsvToHex(hexToHsv(h))).toBe(h);
    expect(hexToHsv('nonsense')).toEqual(hexToHsv('#00843d'));
  });
});
