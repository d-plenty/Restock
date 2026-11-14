import { useEffect, useRef, useState } from 'react';
import { searchWithLens } from '../lib/lens';
import { readText, type ReadLine } from '../lib/receiptReader';
import { packPick } from '../lib/receipts';
import { Icon, LoadingBar } from './components';

/**
 * 0.10.7: find a product from a photo of its pack (a barcode Restock doesn't know, or something
 * with no barcode). Restock reads the words on the photo itself, on the phone, and searches with
 * the biggest ones; the words it found show as buttons to add or take away. If that's not it,
 * "Search with Google Lens" sends the same photo to Google, only when tapped.
 */
export function PackReader({
  barcode,
  onName,
  label = 'Take a photo',
  primary = true,
}: {
  /** The barcode this is for, so a name shared back from Google Lens can be matched to it. */
  barcode?: string;
  /** search: true to search straight away (the first read); false to just fill the box. */
  onName: (name: string, search: boolean) => void;
  label?: string;
  primary?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();
  const [photo, setPhoto] = useState<File>();
  const [photoUrl, setPhotoUrl] = useState<string>();
  const [lines, setLines] = useState<ReadLine[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [lensSaid, setLensSaid] = useState<string>();

  useEffect(() => () => void (photoUrl && URL.revokeObjectURL(photoUrl)), [photoUrl]);

  const go = async (file?: File) => {
    if (!file) return;
    setNote(undefined);
    setLensSaid(undefined);
    setLines([]);
    setChosen([]);
    setPhoto(file);
    setPhotoUrl(URL.createObjectURL(file));
    setBusy('Reading the pack…');
    try {
      const out = await readText(file, setBusy);
      // The words worth showing: real words, biggest first, at most a dozen.
      const shown = out.lines.filter((l) => /[A-Za-z]{2}/.test(l.text) && l.confidence > 40).slice(0, 12);
      setLines(shown);
      const pick = packPick(shown);
      if (pick) {
        setChosen(pick.used);
        onName(pick.name, true);
      } else setNote("Couldn't make out the name. Try again closer, with the name filling most of the photo, or type it in.");
    } catch (e) {
      setNote(`Couldn't read it: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(undefined);
    }
  };

  const toggle = (i: number) => {
    const next = chosen.includes(i) ? chosen.filter((x) => x !== i) : [...chosen, i].sort((a, b) => a - b);
    setChosen(next);
    onName(next.map((x) => lines[x].text).join(' '), false);
  };

  const lens = async () => {
    if (!photo) return;
    try {
      const how = await searchWithLens(photo, barcode);
      setLensSaid(
        how === 'web'
          ? 'Google Lens opened in your browser. Add the photo there. When it finds the product, copy its name into the box above.'
          : "When Google finds it, share the product's name to Restock (Share, then Restock: Search shops), or copy it into the box above.",
      );
    } catch (e) {
      setLensSaid(`Couldn't open Google Lens: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <>
      <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void go(e.target.files?.[0])} />
      <button type="button" className={`btn ${primary ? 'primary' : ''}`} disabled={!!busy} onClick={() => input.current?.click()}>
        <Icon name="camera" size={18} /> {photo ? 'Take another photo' : label}
      </button>
      {busy && (
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="small" role="status">
            {busy}
          </span>
          <LoadingBar seconds={8} />
        </div>
      )}
      {note && (
        <p className="small" role="status">
          {note}
        </p>
      )}
      {lines.length > 0 && !busy && (
        <div className="pack-words">
          {photoUrl && <img src={photoUrl} alt="Your photo of the pack" className="pack-photo" />}
          <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
            <span className="small" id="pack-words-label">
              Words on the pack. Tap to add or take away, then Search.
            </span>
            <div className="chips" role="group" aria-labelledby="pack-words-label">
              {lines.map((l, i) => (
                <button key={i} type="button" className={`chip${chosen.includes(i) ? ' on' : ''}`} aria-pressed={chosen.includes(i)} onClick={() => toggle(i)}>
                  {l.text}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {photo && !busy && (
        <div style={{ display: 'grid', gap: 4 }}>
          <button type="button" className="btn" onClick={() => void lens()}>
            <Icon name="external" size={18} /> Not right? Search with Google Lens
          </button>
          <span className="small">This sends this photo to Google. Restock's own reading stays on your phone.</span>
          {lensSaid && (
            <p className="small" role="status" style={{ margin: 0 }}>
              {lensSaid}
            </p>
          )}
        </div>
      )}
    </>
  );
}
