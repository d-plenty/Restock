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
  onSearch,
}: {
  /** The barcode this is for, so a name shared back from Google Lens can be matched to it. */
  barcode?: string;
  /** search: true to search straight away (the first read); false to just fill the box. */
  onName: (name: string, search: boolean) => void;
  label?: string;
  primary?: boolean;
  /**
   * 0.10.8: in a sheet, a "Search for …" button instead of searching straight away: the sheet
   * closes and the search runs when it's tapped.
   */
  onSearch?: (name: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();
  const [photo, setPhoto] = useState<File>();
  const [photoUrl, setPhotoUrl] = useState<string>();
  const [lines, setLines] = useState<ReadLine[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [lensSaid, setLensSaid] = useState<string>();
  const [allWords, setAllWords] = useState(false);

  useEffect(() => () => void (photoUrl && URL.revokeObjectURL(photoUrl)), [photoUrl]);

  const go = async (file?: File) => {
    if (!file) return;
    setNote(undefined);
    setLensSaid(undefined);
    setLines([]);
    setChosen([]);
    setAllWords(false);
    setPhoto(file);
    setPhotoUrl(URL.createObjectURL(file));
    setBusy('Reading the pack…');
    try {
      const out = await readText(file, setBusy);
      // The words worth showing: real words (the buttons show the best few, 0.10.8).
      const shown = out.lines.filter((l) => /[A-Za-z]{2}/.test(l.text) && l.confidence > 40).slice(0, 40);
      setLines(shown);
      const pick = packPick(shown);
      if (pick) {
        setChosen(pick.used);
        onName(pick.name, !onSearch);
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

  // 0.10.8: the words worth a button: the ones picked, then the biggest short ones (a name, not a
  // sentence from the back of the pack), eight at most; the rest behind "More words".
  const words = (s: string) => s.trim().split(/\s+/).length;
  const order = lines
    .map((l, i) => ({ i, l }))
    .sort(
      (a, b) =>
        Number(chosen.includes(b.i)) - Number(chosen.includes(a.i)) ||
        Number(words(a.l.text) > 5) - Number(words(b.l.text) > 5) ||
        b.l.height - a.l.height,
    )
    .map((x) => x.i);
  const LIMIT = 8;
  const shown = allWords ? order : order.slice(0, LIMIT);
  const hidden = order.length - shown.length;
  const name = chosen
    .map((x) => lines[x]?.text)
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void go(e.target.files?.[0])} />
      {/* 0.10.8: once there's a photo, taking another is the quiet option */}
      <button type="button" className={`btn ${primary && !photo ? 'primary' : ''}`} disabled={!!busy} onClick={() => input.current?.click()}>
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
              Words Restock read. Tap to add or take away.
            </span>
            <div className="chips" role="group" aria-labelledby="pack-words-label">
              {shown.map((i) => (
                <button
                  key={i}
                  type="button"
                  className={`chip${chosen.includes(i) ? ' on' : ''}`}
                  aria-pressed={chosen.includes(i)}
                  onClick={() => toggle(i)}
                >
                  {lines[i].text}
                </button>
              ))}
              {hidden > 0 && (
                <button type="button" className="chip chip-more" onClick={() => setAllWords(true)}>
                  {hidden} more
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {onSearch && lines.length > 0 && !busy && (
        <button type="button" className="btn primary" disabled={!name} onClick={() => onSearch(name)}>
          <Icon name="search" size={18} /> {name ? `Search for “${name.length > 32 ? `${name.slice(0, 30)}…` : name}”` : 'Pick a word to search'}
        </button>
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
