import { useRef, useState } from 'react';
import { readText } from '../lib/receiptReader';
import { packName } from '../lib/receipts';
import { Icon, LoadingBar } from './components';

/**
 * For a barcode Restock doesn't know: take a photo of the front of the pack and use its biggest
 * words as the search. Uses the receipt reader, so it only shows once that's downloaded.
 */
export function PackReader({ onName }: { onName: (name: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();
  const go = async (file?: File) => {
    if (!file) return;
    setNote(undefined);
    setBusy('Reading the pack…');
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k);
      c.height = Math.round(bmp.height * k);
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      const out = await readText(c, setBusy);
      const name = packName(out.lines);
      if (name) onName(name);
      else setNote("Couldn't make out the name. Try closer, with the name filling most of the photo, or type it in.");
    } catch (e) {
      setNote(`Couldn't read it: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void go(e.target.files?.[0])} />
      <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => input.current?.click()}>
        <Icon name="camera" size={16} /> Read the front of the pack
      </button>
      {busy && (
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="small" role="status">
            {busy}
          </span>
          <LoadingBar seconds={8} />
        </div>
      )}
      {note && <p className="small">{note}</p>}
    </>
  );
}
