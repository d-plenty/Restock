// Server mode: a QR code drawn in the page (zxing's writer, bundled; nothing is sent anywhere).
import { useEffect, useState } from 'react';
import { LoadingBar } from '../../ui/components';

/** One square per module with the quiet zone scanners need, scaling to any size (as Sync.tsx draws it). */
export function qrSvg(symbol: { data: ArrayLike<number>; width: number; height: number }): string {
  const q = 4;
  let d = '';
  for (let y = 0; y < symbol.height; y++) for (let x = 0; x < symbol.width; x++) if (symbol.data[y * symbol.width + x] < 128) d += `M${x + q} ${y + q}h1v1h-1z`;
  const w = symbol.width + q * 2;
  const h = symbol.height + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%" shape-rendering="crispEdges"><rect width="${w}" height="${h}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

export function Qr({ text, label }: { text: string; label: string }) {
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setSvg(undefined);
    void (async () => {
      const [mod, { default: wasmUrl }] = await Promise.all([import('zxing-wasm/writer'), import('zxing-wasm/writer/zxing_writer.wasm?url')]);
      mod.prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } });
      const r = await mod.writeBarcode(text, { format: 'QRCode', options: 'ecLevel=M' });
      if (alive && r.symbol?.width) setSvg(qrSvg(r.symbol));
      else if (alive) setFailed(true);
    })().catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [text]);
  return (
    <div className="sync-qr server-qr" role="img" aria-label={label} data-code={text}>
      {svg ? <span dangerouslySetInnerHTML={{ __html: svg }} /> : failed ? <p className="small">Couldn't draw the code. Use the text below.</p> : <LoadingBar seconds={3} />}
    </div>
  );
}
