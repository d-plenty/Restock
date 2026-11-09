import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import type { Settings } from '../types';
import { RestockNative } from './sql/native';

// Light, dark, or follow the phone; the Australian or Plain style; an accent colour; and the
// accessibility options. The CSS reads <html data-theme data-style data-text …>; an accent colour
// is set as CSS variables here, worked out for light and dark so it stays readable. The status
// bar icons are set to match the colours behind them.

const darkQuery = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : undefined);

export function isDark(theme: Settings['theme']): boolean {
  return theme === 'dark' || (theme === 'system' && !!darkQuery()?.matches);
}

type Look = Pick<Settings, 'theme' | 'look' | 'a11y'>;
let current: Look = { theme: 'system', look: { style: 'australia', icon: 'green' }, a11y: { text: 1, contrast: false, motion: false, big: false } };
let listening = false;

// ---------- colour maths ----------

// 0.9.0: anything that isn't a "#rrggbb" colour (a number, nothing, a damaged setting) is the
// default Australian green, never an error.
const hex = (h: unknown) => {
  const m = typeof h === 'string' ? h.replace('#', '').match(/^([0-9a-f]{6})$/i) : null;
  const n = m ? parseInt(m[1], 16) : 0x00843d;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (rgb: number[]) =>
  '#' +
  rgb
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(h: string): number {
  const c = hex(h).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** White or black text, whichever reads better on this colour. */
export const textOn = (bg: string) => (contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#ffffff' : '#111111');

/** Darken (towards black) or lighten (towards white) a colour until it reaches `target` contrast against `against`. */
function untilReadable(c: string, against: string, target: number, towards: 'black' | 'white'): string {
  let rgb = hex(c);
  const end = towards === 'black' ? [0, 0, 0] : [255, 255, 255];
  for (let i = 0; i < 20 && contrast(toHex(rgb), against) < target; i++) rgb = mix(rgb, end, 0.12);
  return toHex(rgb);
}

/** The CSS variables for an accent colour, in light or dark mode. Exported for the tests. */
export function accentVars(accent: string, dark: boolean, black = false): Record<string, string> {
  const base = toHex(hex(accent));
  const surface = black ? '#0a0a0a' : dark ? '#111b30' : '#ffffff';
  const bg = black ? '#000000' : dark ? '#0a1120' : '#f6f4ea';
  // Text-coloured uses (links, labels, active tab) need 4.5:1 against cards and the page.
  const ink = untilReadable(untilReadable(base, surface, 4.5, dark ? 'white' : 'black'), bg, 4.5, dark ? 'white' : 'black');
  return {
    '--green': ink,
    '--green-solid': base,
    '--on-accent': textOn(base),
    '--green-ink': dark ? toHex(mix(hex(ink), [255, 255, 255], 0.35)) : toHex(mix(hex(ink), [0, 0, 0], 0.3)),
    '--green-bg': toHex(mix(hex(bg), hex(base), dark ? 0.22 : 0.16)),
    '--small-bg': toHex(mix(hex(bg), hex(base), dark ? 0.14 : 0.1)),
    '--small-line': toHex(mix(hex(bg), hex(base), dark ? 0.45 : 0.4)),
  };
}

const ACCENT_KEYS = ['--green', '--green-solid', '--on-accent', '--green-ink', '--green-bg', '--small-bg', '--small-line'];

function paint() {
  const root = document.documentElement;
  const { theme, look, a11y } = current;
  root.dataset.theme = theme;
  root.dataset.style = look.style;
  const dark = isDark(theme);
  // True black (0.8.9): only while dark, so "System" still goes light in the day.
  // On unless turned off (0.9.0: true black is the default).
  const black = dark && look.black !== false;
  if (black) root.dataset.black = '1';
  else delete root.dataset.black;
  for (const k of ACCENT_KEYS) root.style.removeProperty(k);
  if (look.accent) for (const [k, v] of Object.entries(accentVars(look.accent, dark, black))) root.style.setProperty(k, v);
  // Accessibility.
  if (a11y.text && a11y.text !== 1) {
    root.dataset.text = String(a11y.text);
    root.style.setProperty('--text-zoom', String(a11y.text));
  } else {
    delete root.dataset.text;
    root.style.removeProperty('--text-zoom');
  }
  if (a11y.contrast) root.dataset.contrast = 'high';
  else delete root.dataset.contrast;
  if (a11y.motion) root.dataset.motion = 'reduce';
  else delete root.dataset.motion;
  if (a11y.big) root.dataset.big = '1';
  else delete root.dataset.big;
  if (Capacitor.isNativePlatform()) {
    // The Australian style has a navy strip behind the clock, so its icons are always light.
    const lightIcons = dark || look.style !== 'plain';
    SystemBars.setStyle({ style: lightIcons ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => undefined);
  }
}

export function applyTheme(s: Look) {
  current = { theme: s.theme, look: s.look, a11y: s.a11y };
  paint();
  if (!listening) {
    listening = true;
    darkQuery()?.addEventListener?.('change', () => current.theme === 'system' && paint());
  }
}

/** Backstop for the status-bar gap: Android's own numbers, used when they're bigger than the WebView's. */
export async function syncInsets(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const r = await RestockNative.getInsets();
    const root = document.documentElement.style;
    root.setProperty('--native-top', `${Math.round(r.top)}px`);
    root.setProperty('--native-bottom', `${Math.round(r.bottom)}px`);
  } catch {
    // Older app build without the method: rely on the WebView's values.
  }
}
