// 0.9.6 (cards): a card's barcode drawn for the till: Code 128 and EAN with JsBarcode (bundled),
// QR codes with zxing's writer (bundled; on the web, a drawn QR is kept in this browser so it shows
// offline, as the web's offline files leave the QR maker out). Black on white, with a quiet zone,
// at a size a till's scanner reads. Nothing is sent anywhere.
import JsBarcode from 'jsbarcode';
import { useEffect, useRef, useState } from 'react';
import { barcodeProblem, eanFormat } from '../../lib/giftCards';
import type { CardStore } from '../../lib/cardStore';
import type { GiftBarcodeType } from '../../types';
import { LoadingBar } from '../components';

/** One square per module with the quiet zone scanners need (as Sync.tsx draws its QR code). */
function qrSvg(symbol: { data: ArrayLike<number>; width: number; height: number }): string {
  const q = 4;
  let d = '';
  for (let y = 0; y < symbol.height; y++) for (let x = 0; x < symbol.width; x++) if (symbol.data[y * symbol.width + x] < 128) d += `M${x + q} ${y + q}h1v1h-1z`;
  const w = symbol.width + q * 2;
  const h = symbol.height + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%" shape-rendering="crispEdges"><rect width="${w}" height="${h}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

const CANT = "This can't be drawn as a barcode. Show the number at the till.";

function QrCode({ value, cache }: { value: string; cache?: CardStore['codeCache'] }) {
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setSvg(undefined);
    setFailed(false);
    const key = `qr:${value}`;
    void (async () => {
      const kept = await cache?.get(key);
      if (kept) return alive && setSvg(kept);
      const [mod, { default: wasmUrl }] = await Promise.all([import('zxing-wasm/writer'), import('zxing-wasm/writer/zxing_writer.wasm?url')]);
      mod.prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } });
      const r = await mod.writeBarcode(value, { format: 'QRCode', options: 'ecLevel=M' });
      if (!r.symbol?.width) throw new Error('no symbol');
      const out = qrSvg(r.symbol);
      await cache?.set(key, out);
      if (alive) setSvg(out);
    })().catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [value, cache]);
  if (failed) return <p className="small">{cache ? "This QR code can't be drawn offline yet. Open Cards once with a connection, or show the number at the till." : CANT}</p>;
  return svg ? (
    <span className="cc-qr" role="img" aria-label="Card QR code" dangerouslySetInnerHTML={{ __html: svg }} />
  ) : (
    <LoadingBar seconds={2} />
  );
}

function LineCode({ value, type }: { value: string; type: Exclude<GiftBarcodeType, 'QR'> }) {
  const ref = useRef<SVGSVGElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, value, {
        format: type === 'EAN' ? eanFormat(value) : 'CODE128',
        displayValue: false,
        height: 90,
        margin: 10,
        width: value.length > 24 ? 1.6 : 2.2,
        background: '#ffffff',
        lineColor: '#000000',
      });
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [value, type]);
  return failed ? <p className="small">{CANT}</p> : <svg ref={ref} role="img" aria-label="Card barcode" />;
}

/** The barcode for the till. */
export function CardCode({ value, type, cache }: { value: string; type: GiftBarcodeType; cache?: CardStore['codeCache'] }) {
  if (barcodeProblem(value, type)) return <p className="small">{CANT}</p>;
  return type === 'QR' ? <QrCode value={value} cache={cache} /> : <LineCode value={value} type={type} />;
}
