// 0.16.0: every app icon and splash from one drawing of the logo (the basket with the falling price
// line, a soft shine, the basket's weave and the gold price tag). Run after changing the logo:
//
//   node tools/icons/make-icons.cjs
//
// It writes:
//   android/app/src/main/res/drawable/ic_launcher_{background,foreground}[_colour].xml (the 16 icon colours)
//   android/app/src/main/res/mipmap-*/ic_launcher{,_round}.png
//   android/app/src/main/res/drawable*/splash.png (the logo on navy, at each size there was)
//   ios/App/App/Assets.xcassets/AppIcon.appiconset and Icon-<colour>.appiconset (1024 px)
//   ios/App/App/Assets.xcassets/Splash.imageset
//   src/server-mode/pwa/icons/* (the server's web app), assets/icon*.{svg,png}, assets/splash*.png,
//   docs/icon-512.png, fastlane/metadata/android/en-US/images/icon.png
//
// The in-app logo (src/ui/components.tsx Logo) and the opening animation (src/ui/Opening.tsx) are
// the same drawing, written there by hand.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RES = path.join(ROOT, 'android/app/src/main/res');

// ---------- the drawing (108 × 108, Android's adaptive-icon size; the tile is 18…90) ----------

/** The 16 icon colours: the tile's two colours, and what's drawn on it. */
const CREAM = { basket: '#F6F1E4', rim: '#DCD2BA', weave: '#E8E0CB' };
const DARK = { basket: '#0F1D3D', rim: '#2A3A63', weave: '#1C2B4F' };
const COLOURS = {
  '': { bg: ['#24935C', '#0E4A2B'], ...CREAM, line: '#156B42' },
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

const HANDLE = 'M38.5,47 C38.5,27.5 69.5,27.5 69.5,47';
const BASKET = 'M25.6,45 H82.4 Q86.6,45 85.6,49.1 L78.7,75.4 Q77.7,79.4 73.6,79.4 H34.4 Q30.3,79.4 29.3,75.4 L22.4,49.1 Q21.4,45 25.6,45 Z';
const RIM = 'M24.6,52.6 H83.4';
const WEAVE = 'M38,56 L40,76 M49.3,56 L49.8,76 M58.7,56 L58.2,76 M70,56 L68,76';
const LINE = 'M35,58.5 L45.5,68 L54.5,61.2 L68,72.6';
const ARROW = 'M58.6,73.2 H68.6 V63.2';
const STRING = 'M66,32 L70.5,34.6';
const TAG = 'M70.5,34.5 H82 Q84,34.5 84,36.5 V41.5 Q84,43.5 82,43.5 H70.5 L67,39 Z';
const HOLE = 'M69.8,39 a1.2,1.2 0 1,0 2.4,0 a1.2,1.2 0 1,0 -2.4,0';
// A dollar sign drawn with lines (an icon has no fonts): the S, and the bar through it.
const DOLLAR_S = 'M80.3,37 C79.7,36.3 79,36.1 78.3,36.1 C77.1,36.1 76.5,36.8 76.6,37.6 C76.7,38.4 77.5,38.7 78.5,39 C79.6,39.3 80.4,39.8 80.4,40.8 C80.4,41.8 79.5,42.4 78.4,42.4 C77.6,42.4 76.9,42.1 76.4,41.4';
const DOLLAR_BAR = 'M78.45,35 V43.5';

const parts = (c) => {
  const tag = c.tag || '#FFCD00';
  return [
    { d: HANDLE, stroke: c.basket, width: 7, cap: 'round' },
    { d: BASKET, fill: c.basket },
    { d: RIM, stroke: c.rim, width: 2.4 },
    { d: WEAVE, stroke: c.weave, width: 2, cap: 'round' },
    { d: LINE, stroke: c.line, width: 5.8, cap: 'round', join: 'round' },
    { d: ARROW, stroke: c.line, width: 5.8, cap: 'round', join: 'round' },
    { d: STRING, stroke: c.basket, width: 1.4 },
    {
      rotate: [28, 76, 39],
      items: [
        { d: TAG, fill: tag },
        { d: HOLE, fill: c.bg[1] },
        { d: DOLLAR_S, stroke: '#012169', width: 1.35, cap: 'round' },
        { d: DOLLAR_BAR, stroke: '#012169', width: 1.1, cap: 'round' },
      ],
    },
  ];
};

// ---------- Android ----------

const xmlPath = (p, pad) =>
  `${pad}<path\n${pad}    android:pathData="${p.d}"` +
  (p.fill ? `\n${pad}    android:fillColor="${p.fill}"` : '') +
  (p.stroke ? `\n${pad}    android:strokeColor="${p.stroke}"\n${pad}    android:strokeWidth="${p.width}"` : '') +
  (p.cap ? `\n${pad}    android:strokeLineCap="${p.cap}"` : '') +
  (p.join ? `\n${pad}    android:strokeLineJoin="${p.join}"` : '') +
  ' />';

function androidForeground(id, c) {
  const body = parts(c)
    .map((p) =>
      p.items
        ? `        <group android:rotation="${p.rotate[0]}" android:pivotX="${p.rotate[1]}" android:pivotY="${p.rotate[2]}">\n${p.items.map((q) => xmlPath(q, '            ')).join('\n')}\n        </group>`
        : xmlPath(p, '        '),
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- App icon foreground${id ? ` for the ${id} icon` : ''} (made by tools/icons/make-icons.cjs: change it there). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group android:pivotX="54" android:pivotY="53.5" android:scaleX="0.8" android:scaleY="0.8" android:translateY="1">
${body}
    </group>
</vector>
`;
}

function androidBackground(id, c) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- App icon background${id ? ` for the ${id} icon` : ''}, with a soft shine at the top (made by tools/icons/make-icons.cjs). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="0"
                android:startY="0"
                android:endX="108"
                android:endY="108"
                android:startColor="${c.bg[0]}"
                android:endColor="${c.bg[1]}" />
        </aapt:attr>
    </path>
    <path android:pathData="M0,0h108v54h-108z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="0"
                android:startY="18"
                android:endX="0"
                android:endY="54"
                android:startColor="#38FFFFFF"
                android:endColor="#00FFFFFF" />
        </aapt:attr>
    </path>
</vector>
`;
}

// ---------- SVG (for the pictures) ----------

const svgPath = (p) =>
  `<path d="${p.d}" fill="${p.fill || 'none'}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.width}"` : ''}${p.cap ? ` stroke-linecap="${p.cap}"` : ''}${p.join ? ` stroke-linejoin="${p.join}"` : ''}/>`;

/** The whole icon as SVG: `tile` round-cornered (the logo) or square (an iOS icon: iOS rounds it). */
function svg(c, { size, tile = 'round', viewBox = '18 18 72 72', bg = true } = {}) {
  const fg = parts(c)
    .map((p) => (p.items ? `<g transform="rotate(${p.rotate.join(' ')})">${p.items.map(svgPath).join('')}</g>` : svgPath(p)))
    .join('');
  const shape = tile === 'round' ? `<rect x="18" y="18" width="72" height="72" rx="16" fill="url(#t)"/>` : `<rect x="0" y="0" width="108" height="108" fill="url(#t)"/>`;
  const shine = tile === 'round' ? `<rect x="19.5" y="19.5" width="69" height="30" rx="14.5" fill="url(#s)"/>` : `<rect x="0" y="0" width="108" height="54" fill="url(#s2)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg"${size ? ` width="${size}" height="${size}"` : ''} viewBox="${viewBox}"><defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.bg[0]}"/><stop offset="1" stop-color="${c.bg[1]}"/></linearGradient><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><linearGradient id="s2" gradientUnits="userSpaceOnUse" x1="0" y1="18" x2="0" y2="54"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>${bg ? shape + shine : ''}<g transform="translate(54 54.5) scale(0.8) translate(-54 -53.5)">${fg}</g></svg>`;
}

// ---------- write ----------

async function main() {
  const write = (rel, text) => {
    const p = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  for (const [id, c] of Object.entries(COLOURS)) {
    const sfx = id ? '_' + id : '';
    write(`android/app/src/main/res/drawable/ic_launcher_foreground${sfx}.xml`, androidForeground(id, c));
    write(`android/app/src/main/res/drawable/ic_launcher_background${sfx}.xml`, androidBackground(id, c));
  }
  const green = COLOURS[''];
  write('assets/icon.svg', svg(green, { size: 1024 }) + '\n');
  // The web pages' tab icon (index.html), the same drawing.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const fav = 'data:image/svg+xml,' + encodeURIComponent(svg(green)).replace(/'/g, '%27');
  write('index.html', html.replace(/(<link rel="icon" type="image\/svg\+xml" href=")[^"]*(")/, `$1${fav}$2`));

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const written = [];
  const shot = async (html, w, h, out, transparent = false) => {
    written.push(out);
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${transparent ? 'transparent' : '#000'}">${html}</body></html>`);
    const p = path.join(ROOT, out);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    await page.screenshot({ path: p, omitBackground: transparent });
  };
  // iPhone and iPad: square, full bleed (iOS rounds the corners), no transparency.
  for (const [id, c] of Object.entries(COLOURS)) {
    const out = id ? `ios/App/App/Assets.xcassets/Icon-${id}.appiconset/Icon-${id}.png` : 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png';
    await shot(svg(c, { size: 1024, tile: 'square', viewBox: '18 18 72 72' }), 1024, 1024, out);
  }
  // Android's older-style icons (only used by very old launchers): the round-cornered tile.
  const mip = { ldpi: 36, mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, px] of Object.entries(mip)) {
    if (!fs.existsSync(path.join(RES, `mipmap-${d}`))) continue;
    await shot(svg(green, { size: px }), px, px, `android/app/src/main/res/mipmap-${d}/ic_launcher.png`, true);
    await shot(`<div style="width:${px}px;height:${px}px;border-radius:50%;overflow:hidden">${svg(green, { size: px, tile: 'square' })}</div>`, px, px, `android/app/src/main/res/mipmap-${d}/ic_launcher_round.png`, true);
  }
  // The server's web app, the stores and GitHub.
  await shot(svg(green, { size: 192 }), 192, 192, 'src/server-mode/pwa/icons/icon-192.png', true);
  await shot(svg(green, { size: 512 }), 512, 512, 'src/server-mode/pwa/icons/icon-512.png', true);
  await shot(svg(green, { size: 192, tile: 'square', viewBox: '0 0 108 108' }), 192, 192, 'src/server-mode/pwa/icons/icon-maskable-192.png');
  await shot(svg(green, { size: 512, tile: 'square', viewBox: '0 0 108 108' }), 512, 512, 'src/server-mode/pwa/icons/icon-maskable-512.png');
  await shot(svg(green, { size: 180, tile: 'square' }), 180, 180, 'src/server-mode/pwa/icons/apple-touch-icon.png');
  await shot(svg(green, { size: 512 }), 512, 512, 'docs/icon-512.png', true);
  await shot(svg(green, { size: 512, tile: 'square' }), 512, 512, 'fastlane/metadata/android/en-US/images/icon.png');
  await shot(svg(green, { size: 1024 }), 1024, 1024, 'assets/icon-only.png', true);
  await shot(svg(green, { size: 1024, tile: 'square', viewBox: '0 0 108 108', bg: false }), 1024, 1024, 'assets/icon-foreground.png', true);
  await shot(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 108 108"><defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${green.bg[0]}"/><stop offset="1" stop-color="${green.bg[1]}"/></linearGradient></defs><rect width="108" height="108" fill="url(#t)"/></svg>`, 1024, 1024, 'assets/icon-background.png');
  // Splash screens: the logo on navy, as the opening animation starts (each at the size it was).
  const sizeOf = (p) => {
    const b = fs.readFileSync(p);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };
  const splash = (w, h) => {
    const s = Math.round(Math.min(w, h) * 0.22);
    return `<div style="width:${w}px;height:${h}px;background:radial-gradient(ellipse at 50% 42%, #0a3291 0%, #012169 62%);display:flex;align-items:center;justify-content:center">${svg(green, { size: s })}</div>`;
  };
  const splashes = [];
  for (const d of fs.readdirSync(RES)) if (d.startsWith('drawable') && fs.existsSync(path.join(RES, d, 'splash.png'))) splashes.push(`android/app/src/main/res/${d}/splash.png`);
  for (const f of fs.readdirSync(path.join(ROOT, 'ios/App/App/Assets.xcassets/Splash.imageset'))) if (f.endsWith('.png')) splashes.push(`ios/App/App/Assets.xcassets/Splash.imageset/${f}`);
  for (const f of ['assets/splash.png', 'assets/splash-dark.png']) if (fs.existsSync(path.join(ROOT, f))) splashes.push(f);
  for (const f of splashes) {
    const [w, h] = sizeOf(path.join(ROOT, f));
    await shot(splash(w, h), w, h, f);
  }
  await browser.close();
  // Squeezed with pngquant when it's installed (the splash screens' soft gradient is ~40 MB otherwise).
  const made = [...new Set(written)];
  try {
    require('child_process').execFileSync('pngquant', ['--quality=70-95', '--speed', '1', '--skip-if-larger', '--force', '--ext', '.png', ...made.map((f) => path.join(ROOT, f))], { stdio: 'ignore' });
  } catch (e) {
    if (e.code === 'ENOENT') console.log('pngquant is not installed: the PNGs are not squeezed');
  }
  console.log(`icons: ${Object.keys(COLOURS).length} colours, ${splashes.length} splash screens`);
}

module.exports = { COLOURS, svg, parts, androidForeground };
if (require.main === module) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
