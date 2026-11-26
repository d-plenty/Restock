// Colours people can pick: accent colours for the app, and the app icon's colour. The first of
// each is the default (Australian green). Icon colours are built into the app (Android can't
// recolour an installed icon), so this list matches the icons in android/app/src/main/res.

export interface Swatch {
  id: string;
  name: string;
  hex: string;
}

export const AUS_GREEN = '#00843d';

export const ACCENTS: Swatch[] = [
  { id: 'green', name: 'Australian green', hex: AUS_GREEN },
  { id: 'gold', name: 'Gold', hex: '#ffcd00' },
  { id: 'navy', name: 'Navy', hex: '#012169' },
  { id: 'red', name: 'Red', hex: '#c8102e' },
  { id: 'forest', name: 'Forest', hex: '#2e7d32' },
  { id: 'lime', name: 'Lime', hex: '#7cb342' },
  { id: 'olive', name: 'Olive', hex: '#6b8e23' },
  { id: 'teal', name: 'Teal', hex: '#00897b' },
  { id: 'mint', name: 'Mint', hex: '#26a69a' },
  { id: 'sky', name: 'Sky', hex: '#0277bd' },
  { id: 'blue', name: 'Blue', hex: '#1f6fb2' },
  { id: 'indigo', name: 'Indigo', hex: '#3949ab' },
  { id: 'purple', name: 'Purple', hex: '#6b3fa0' },
  { id: 'plum', name: 'Plum', hex: '#8e24aa' },
  { id: 'pink', name: 'Pink', hex: '#d81b60' },
  { id: 'magenta', name: 'Magenta', hex: '#ad1457' },
  { id: 'coral', name: 'Coral', hex: '#e5533d' },
  { id: 'orange', name: 'Orange', hex: '#e65100' },
  { id: 'amber', name: 'Amber', hex: '#f2a900' },
  { id: 'sand', name: 'Sand', hex: '#b08d57' },
  { id: 'brown', name: 'Brown', hex: '#6d4c41' },
  { id: 'slate', name: 'Slate', hex: '#455a64' },
  { id: 'charcoal', name: 'Charcoal', hex: '#37474f' },
  { id: 'black', name: 'Black', hex: '#1b1b1b' },
];

export const ICON_COLOURS: Swatch[] = [
  { id: 'green', name: 'Australian green', hex: '#1f8352' },
  { id: 'gold', name: 'Gold', hex: '#ffcd00' },
  { id: 'navy', name: 'Navy', hex: '#012169' },
  { id: 'red', name: 'Red', hex: '#c8102e' },
  { id: 'forest', name: 'Forest', hex: '#2e7d32' },
  { id: 'teal', name: 'Teal', hex: '#00897b' },
  { id: 'sky', name: 'Sky', hex: '#0277bd' },
  { id: 'indigo', name: 'Indigo', hex: '#3949ab' },
  { id: 'purple', name: 'Purple', hex: '#6b3fa0' },
  { id: 'pink', name: 'Pink', hex: '#d81b60' },
  { id: 'orange', name: 'Orange', hex: '#e65100' },
  { id: 'amber', name: 'Amber', hex: '#f2a900' },
  { id: 'brown', name: 'Brown', hex: '#6d4c41' },
  { id: 'slate', name: 'Slate', hex: '#455a64' },
  { id: 'black', name: 'Black', hex: '#1b1b1b' },
  { id: 'white', name: 'White', hex: '#f4f1e8' },
];

/**
 * 0.17.0: the colours offered in Settings: 11 that look good (6 and 5), and the colour wheel for
 * anything else. A colour picked before that isn't among them still shows as chosen.
 */
export const SHOWN_ACCENTS = ['green', 'navy', 'gold', 'red', 'teal', 'sky', 'purple', 'pink', 'orange', 'slate', 'black'];
export const SHOWN_ICONS = ['green', 'navy', 'gold', 'red', 'teal', 'sky', 'purple', 'pink', 'orange', 'slate', 'black'];

/** How each app icon is painted (the same as tools/icons/make-icons.cjs draws them), for its picture in Settings. */
export interface IconPaint {
  bg: [string, string];
  basket: string;
  rim: string;
  weave: string;
  line: string;
  tag?: string;
}
const CREAM = { basket: '#F6F1E4', rim: '#DCD2BA', weave: '#E8E0CB' };
const DARK = { basket: '#0F1D3D', rim: '#2A3A63', weave: '#1C2B4F' };
export const ICON_PAINT: Record<string, IconPaint> = {
  green: { bg: ['#24935C', '#0E4A2B'], ...CREAM, line: '#156B42' },
  gold: { bg: ['#FFCD00', '#D1A800'], ...DARK, line: '#FFCD00', tag: '#F6F1E4' },
  navy: { bg: ['#0A2B7E', '#01123A'], ...CREAM, line: '#011C59' },
  red: { bg: ['#C8102E', '#6E0919'], ...CREAM, line: '#AA0E27' },
  forest: { bg: ['#2E7D32', '#19451C'], ...CREAM, line: '#276A2A' },
  teal: { bg: ['#00897B', '#004B44'], ...CREAM, line: '#007469' },
  sky: { bg: ['#0277BD', '#014168'], ...CREAM, line: '#0265A1' },
  indigo: { bg: ['#3949AB', '#1F285E'], ...CREAM, line: '#303E91' },
  purple: { bg: ['#6B3FA0', '#3B2358'], ...CREAM, line: '#5B3688' },
  pink: { bg: ['#D81B60', '#770F35'], ...CREAM, line: '#B81752' },
  orange: { bg: ['#E65100', '#7F2D00'], ...CREAM, line: '#C44500' },
  amber: { bg: ['#F2A900', '#C68B00'], ...DARK, line: '#F2A900', tag: '#F6F1E4' },
  brown: { bg: ['#6D4C41', '#3C2A24'], ...CREAM, line: '#5D4137' },
  slate: { bg: ['#455A64', '#263237'], ...CREAM, line: '#3B4C55' },
  black: { bg: ['#1B1B1B', '#0F0F0F'], ...CREAM, line: '#00843D' },
  white: { bg: ['#F4F1E8', '#C8C6BE'], ...DARK, line: '#00843D' },
};

const rgb = (h: string) => {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** The built-in icon colour closest to an accent colour, for "Match my accent colour". */
export function nearestIcon(hex: string): Swatch {
  const [r, g, b] = rgb(hex);
  let best = ICON_COLOURS[0];
  let bestD = Infinity;
  for (const s of ICON_COLOURS) {
    const [R, G, B] = rgb(s.hex);
    // Weighted distance, closer to how eyes judge colour than plain RGB.
    const d = 2 * (R - r) ** 2 + 4 * (G - g) ** 2 + 3 * (B - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
