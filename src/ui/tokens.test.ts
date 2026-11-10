// 0.9.5 (look): one set of tokens for the phone and the web (tokens.css). These keep it that way:
// readable text in every theme, and no colours, corners or text sizes outside the tokens.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast } from '../lib/theme';
import { axisCents, moneyAxis } from '../server-mode/ui/dataCharts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const TOKENS = read('./tokens.css');
const SHEETS = ['./styles.css', '../server-mode/desk.css', '../server-mode/server.css', '../server-mode/pwa/pwa.css'];

/** The custom properties each selector block sets (blocks inside @media merge with the same selector). */
function blocks(css: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].replace(/@media[^{]*$/, '').trim().replace(/\s+/g, ' ');
    const vars = out.get(sel) ?? {};
    for (const v of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[v[1]] = v[2].trim();
    out.set(sel, vars);
  }
  return out;
}
const B = blocks(TOKENS);
const DARK = ":root[data-theme='dark']";
const PLAIN = ":root[data-style='plain']";
const PLAIN_DARK = ":root[data-style='plain'][data-theme='dark']";
const BLACK = ":root[data-black='1'][data-theme][data-style]";
const THEMES: Record<string, string[]> = {
  light: [':root'],
  dark: [':root', DARK],
  'true black': [':root', DARK, BLACK],
  plain: [':root', PLAIN],
  'plain dark': [':root', DARK, PLAIN, PLAIN_DARK],
  'plain true black': [':root', DARK, PLAIN, PLAIN_DARK, BLACK],
};
function theme(name: string): (v: string) => string {
  const vars: Record<string, string> = {};
  for (const sel of THEMES[name]) Object.assign(vars, B.get(sel));
  const get = (v: string, depth = 0): string => {
    const x = vars[v];
    if (x === undefined) throw new Error(`${name}: ${v} is not set`);
    const ref = x.match(/^var\((--[\w-]+)\)$/);
    return ref && depth < 8 ? get(ref[1], depth + 1) : x;
  };
  return get;
}

describe('tokens: text contrast is at least 4.5:1 in every theme', () => {
  const TEXT = ['--ink', '--ink-2', '--muted', '--green', '--green-ink', '--blue', '--amber-ink', '--red-ink', '--good-ink'];
  const GROUNDS = ['--bg', '--surface', '--sunken'];
  const PAIRS: [string, string][] = [
    // Tags and badges (GREAT DEAL, WAIT, FAKE SALE, SWAP & SAVE, USUAL PRICE).
    ['--good-ink', '--good-bg'],
    ['--green-ink', '--green-bg'],
    ['--amber-ink', '--amber-bg'],
    ['--red-ink', '--red-bg'],
    ['--blue', '--blue-bg'],
    ['--ink-2', '--sunken'],
    // Buttons and bars.
    ['--on-accent', '--green-solid'],
    ['--white', '--danger-solid'],
    ['--white', '--flybuys'],
    ['--fixed-ink', '--everyday'],
    ['--tab-ink', '--tabbar-bg'],
    ['--tab-on', '--tabbar-bg'],
    ['--on-navy', '--chrome-bg'],
    ['--on-navy-muted', '--chrome-bg'],
    ['--gold', '--navy'],
    ['--on-navy', '--navy'],
  ];
  for (const name of Object.keys(THEMES)) {
    it(name, () => {
      const t = theme(name);
      const low: string[] = [];
      for (const a of TEXT) for (const g of GROUNDS) if (contrast(t(a), t(g)) < 4.5) low.push(`${a} on ${g}`);
      for (const [a, g] of PAIRS) if (contrast(t(a), t(g)) < 4.5) low.push(`${a} on ${g}`);
      expect(low).toEqual([]);
    });
  }
  it('keeps the brand colours', () => {
    const t = theme('light');
    expect([t('--navy'), t('--gold'), t('--green'), t('--bg')]).toEqual(['#012169', '#ffcd00', '#007a38', '#f6f4ea']);
  });
});

describe('tokens: the phone and web style sheets only use the tokens', () => {
  for (const p of SHEETS) {
    const css = read(p);
    it(`${p}: no colours of its own`, () => {
      // Colours inside data: URLs (icons drawn in the CSS) are part of the picture, not the page.
      expect(css.replace(/url\([^)]*\)/g, '').match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    });
    it(`${p}: corners and text sizes from the scales`, () => {
      const radii = [...css.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
      expect(radii.filter((r) => /\d+px/.test(r.replace(/var\([^)]*\)/g, '')) && !/^0$/.test(r))).toEqual([]);
      const sizes = [...css.matchAll(/font-size\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
      expect(sizes.filter((s) => /\d+px/.test(s))).toEqual([]);
    });
  }
});

describe('chart axes (web Data tab)', () => {
  it('shows cents on every label when any line has them', () => {
    const ticks = [2.5, 3, 3.5, 4, 4.5];
    expect(axisCents(ticks)).toBe(true);
    expect(ticks.map((t) => moneyAxis(t, axisCents(ticks)))).toEqual(['$2.50', '$3.00', '$3.50', '$4.00', '$4.50']);
  });
  it('keeps whole dollars when every line is whole', () => {
    const ticks = [0, 200, 400, 600, 800];
    expect(axisCents(ticks)).toBe(false);
    expect(ticks.map((t) => moneyAxis(t, axisCents(ticks)))).toEqual(['$0', '$200', '$400', '$600', '$800']);
    expect(moneyAxis(1500, true)).toBe('$1.5k');
  });
});
