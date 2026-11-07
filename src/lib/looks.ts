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
