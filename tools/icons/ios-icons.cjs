// Draws the iPhone app icons from Android's own icon drawings (background + foreground), 1024 px, no transparency.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const RES = process.argv[2], OUT = process.argv[3], VB = process.argv[4] || '18 18 72 72';
const attr = (s, n) => (s.match(new RegExp('android:' + n + '="([^"]*)"')) || [])[1];
function toSvg(xml, idp) {
  let defs = '', out = '';
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const g = body.match(/<group([^>]*)>/);
  let open = '', close = '';
  if (g) {
    const px = +attr(g[1], 'pivotX') || 0, py = +attr(g[1], 'pivotY') || 0, sx = +attr(g[1], 'scaleX') || 1, sy = +attr(g[1], 'scaleY') || 1, tx = +attr(g[1], 'translateX') || 0, ty = +attr(g[1], 'translateY') || 0;
    open = `<g transform="translate(${tx + px} ${ty + py}) scale(${sx} ${sy}) translate(${-px} ${-py})">`; close = '</g>';
  }
  const re = /<path([^>]*?)(\/>|>([\s\S]*?)<\/path>)/g; let m, i = 0;
  while ((m = re.exec(body))) {
    const a = m[1], inner = m[3] || '';
    let fill = attr(a, 'fillColor') || 'none';
    const gr = inner.match(/<gradient([\s\S]*?)\/>/);
    if (gr) { const id = idp + 'g' + i++; defs += `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${attr(gr[1], 'startX')}" y1="${attr(gr[1], 'startY')}" x2="${attr(gr[1], 'endX')}" y2="${attr(gr[1], 'endY')}"><stop offset="0" stop-color="${attr(gr[1], 'startColor')}"/><stop offset="1" stop-color="${attr(gr[1], 'endColor')}"/></linearGradient>`; fill = `url(#${id})`; }
    const stroke = attr(a, 'strokeColor');
    out += `<path d="${attr(a, 'pathData')}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${attr(a, 'strokeWidth') || 1}" stroke-linecap="${attr(a, 'strokeLineCap') || 'butt'}" stroke-linejoin="${attr(a, 'strokeLineJoin') || 'miter'}"` : ''}/>`;
  }
  return { defs, out: open + out + close };
}
(async () => {
  const ids = ['', 'gold', 'navy', 'red', 'forest', 'teal', 'sky', 'indigo', 'purple', 'pink', 'orange', 'amber', 'brown', 'slate', 'black', 'white'];
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  fs.mkdirSync(OUT, { recursive: true });
  for (const id of ids) {
    const sfx = id ? '_' + id : '';
    const bg = toSvg(fs.readFileSync(path.join(RES, `ic_launcher_background${sfx}.xml`), 'utf8'), 'b');
    const fg = toSvg(fs.readFileSync(path.join(RES, `ic_launcher_foreground${sfx}.xml`), 'utf8'), 'f');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="${VB}"><defs>${bg.defs}${fg.defs}</defs>${bg.out}${fg.out}</svg>`;
    await p.setContent(`<html><body style="margin:0;background:#000">${svg}</body></html>`);
    await p.screenshot({ path: path.join(OUT, `${id || 'green'}.png`), omitBackground: false });
  }
  await b.close();
})();
