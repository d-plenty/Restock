import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { confirmAction } from '../../lib/confirm';
import { allReceipts, getReceipt, getSettings, nowIso, photosOnServer, saveReceipt, uid, updateSettings } from '../../lib/db';
import { serverPhoto } from '../../lib/sync';
import { dataUrl, photoPath, photosSize, readPhoto, writePhoto } from '../../lib/receiptFiles';
import { readerInstalled, readText, removeOldDownload } from '../../lib/receiptReader';
import { deleteOn, expired, itemLines, joinPages, KEEP_MONTHS, keepLabel, parseReceipt, removeReceipts, removeReceiptsUndoable } from '../../lib/receipts';
import { act } from '../../lib/undo'; // 0.9.5 (undo)
import * as draft from '../../lib/settingsDraft'; // 0.9.5 (save)
import { blackAndWhite, findPaper, fullQuad, greyscale, rotate, shrink, warp, type Img, type Quad } from '../../lib/scan';
import { money } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { activeSections, chainName, SECTION_NAMES, SHOPS, type Section, type StoreChain } from '../../shops';
import type { Receipt, Settings } from '../../types';
import { ChainDot, Icon, LoadingBar, TopBar } from '../components';
import { useNav } from '../nav';

// Receipts (an add-on, off until switched on): scan a receipt, straighten it, read the shop,
// date and total, and keep it for as long as the person chose. Photos stay in Restock's own
// storage, never in the phone's gallery.

const megabytes = (b: number) => (b < 1_000_000 ? `${Math.max(1, Math.round(b / 1000))} KB` : `${(b / 1_000_000).toFixed(1)} MB`);
const dayText = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: new Date(d).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });

/** The receipt reader is built in since 0.7.4: switching on just marks it ready (and clears any old download). */
function useReader() {
  const install = async () => {
    await removeOldDownload();
    const s = await getSettings();
    await updateSettings({ receipts: { ...s.receipts, installed: true } });
    return true;
  };
  return { installed: true as boolean | undefined, progress: undefined as number | undefined, error: undefined as string | undefined, install };
}

/** Settings → Receipts (and the Receipts setup tile). */
export function ReceiptsSettings({ settings, inSetup }: { settings: Settings; inSetup?: boolean }) {
  const nav = useNav();
  const r = settings.receipts;
  const reader = useReader();
  const receipts = useLive(allReceipts, []);
  const [size, setSize] = useState<number>();
  useEffect(() => {
    void photosSize().then(setSize);
  }, [receipts?.length]);

  const turnOn = async (on: boolean) => {
    // 0.9.5 (save): on a settings screen, held until Save settings.
    if (on && !reader.installed) {
      await draft.updateSettings({ receipts: { ...r, enabled: true } });
      await reader.install();
      return;
    }
    await draft.updateSettings({ receipts: { ...r, enabled: on } });
  };

  const setKeep = async (months: number) => {
    const going = expired(receipts ?? [], months);
    if (going.length) {
      const ok = await confirmAction(`Delete ${going.length} receipt${going.length === 1 ? '' : 's'} now?`, {
        detail: `Keeping receipts for ${keepLabel(months).toLowerCase()} means ${
          going.length === 1 ? 'one you already have is' : `${going.length} you already have are`
        } older than that. Pinned receipts stay.`,
        action: 'Delete them',
        danger: true,
      });
      if (!ok) return;
    }
    await draft.updateSettings({ receipts: { ...r, keepMonths: months } });
    // 0.9.5 (save): the older ones go once it's saved (what's older by then).
    await draft.afterSave('receipts-keep', async (s) => {
      const gone = expired(await allReceipts(), s.receipts.keepMonths);
      if (!gone.length) return;
      await removeReceipts(gone);
      nav.toast(`Deleted ${gone.length} older receipt${gone.length === 1 ? '' : 's'}`);
    });
  };

  return (
    <>
      {inSetup && (
        <ul className="ticks">
          <li>
            <Icon name="camera" size={16} />
            <span>Take a photo: Restock finds the receipt's edges, straightens it and makes it easy to read.</span>
          </li>
          <li>
            <Icon name="receipt" size={16} />
            <span>It reads the shop, date and total for you, and you can fix anything it gets wrong.</span>
          </li>
          <li>
            <Icon name="alert" size={16} />
            <span>Recall alerts also check what's on your kept receipts.</span>
          </li>
          <li>
            <Icon name="download" size={16} />
            <span>The reader is built into Restock and works offline. Reading happens on your phone; receipts are never sent anywhere.</span>
          </li>
        </ul>
      )}
      <div className="card flush">
        <label className="check">
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Receipts
            </span>
            <span className="small">Scan and keep receipts.</span>
          </span>
          <input type="checkbox" className="switch" checked={r.enabled} disabled={reader.progress !== undefined} onChange={(e) => void turnOn(e.target.checked)} />
        </label>
        {reader.error && (
          <div style={{ padding: '0 14px 12px', display: 'grid', gap: 8 }}>
            <div className="banner amber">Couldn't download the reader: {reader.error}</div>
            <button className="btn small" style={{ justifySelf: 'start' }} onClick={() => void reader.install()}>
              Try again
            </button>
          </div>
        )}
        <label className="check">
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Keep receipts for
            </span>
            <span className="small">Counted from the day you scan each one. Pin a receipt to keep it longer.</span>
          </span>
          <select
            className="input"
            style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
            value={r.keepMonths}
            aria-label="Keep receipts for"
            onChange={(e) => void setKeep(parseInt(e.target.value, 10))}
          >
            {KEEP_MONTHS.map((m) => (
              <option key={m} value={m}>
                {keepLabel(m)}
                {m === 3 ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
        {!inSetup && (
          <>
            <button className="row" onClick={() => nav.push({ name: 'receipts' })} disabled={!r.enabled}>
              <span className="grow">
                <span className="title">Your receipts</span>
                <span className="small">
                  {receipts?.length ? `${receipts.length} kept` : 'None yet'}
                  {size ? ` · photos use ${megabytes(size)}` : ''}
                </span>
              </span>
              <Icon name="chevron" size={18} />
            </button>
          </>
        )}
      </div>
      {!inSetup && (
        <p className="small">
          Receipt photos are Restock's own copies, kept inside the app, not in your phone's photo gallery. Backups include them unless you untick
          them.
        </p>
      )}
    </>
  );
}

/** Home → Receipts: the kept receipts, newest first. */
export function ReceiptsScreen() {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const receipts = useLive(allReceipts, []);
  if (!settings || !receipts) return <div className="screen" />;
  const keep = settings.receipts.keepMonths;

  if (!settings.receipts.enabled) {
    return (
      <div className="screen">
        <TopBar title="Receipts" />
        <ReceiptsSettings settings={settings} inSetup />
      </div>
    );
  }

  const months = new Map<string, Receipt[]>();
  for (const r of receipts) {
    const key = new Date(r.receiptDate ?? r.scannedAt).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
    months.set(key, [...(months.get(key) ?? []), r]);
  }

  return (
    <div className="screen">
      <TopBar title="Receipts" />
      <button className="btn primary block" onClick={() => nav.push({ name: 'receipt' })}>
        <Icon name="camera" size={18} /> Add a receipt
      </button>
      <p className="small">
        Kept {keep ? `for ${keepLabel(keep).toLowerCase()} from scanning` : 'until you delete them'}. Pinned ones stay.{' '}
        <button className="linkish" onClick={() => nav.push({ name: 'settings', page: 'shopping' })}>
          Change
        </button>
      </p>
      {!receipts.length && (
        <div className="card">
          <p className="small" style={{ margin: 0 }}>
            No receipts yet. Tap Add a receipt and take a photo of one, flat on a table with some space around it.
          </p>
        </div>
      )}
      {[...months].map(([month, list]) => (
        <section key={month} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="eyebrow" style={{ display: 'flex' }}>
            {month}
            <span className="small" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }}>
              {money(list.reduce((n, r) => n + (r.total ?? 0), 0))}
            </span>
          </div>
          <div className="card flush">
            {list.map((r) => {
              const on = deleteOn(r, keep);
              return (
                <button key={r.id} className="row" onClick={() => nav.push({ name: 'receipt', id: r.id })}>
                  {r.chain ? <ChainDot chain={r.chain} /> : <Icon name="receipt" size={18} />}
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>
                      {r.shop || (r.chain ? chainName(r.chain) : 'Receipt')}
                    </span>
                    <span className="small">
                      {dayText(r.receiptDate ?? r.scannedAt)}
                      {r.pinned ? ' · pinned' : on ? ` · deleted ${dayText(on)}` : ''}
                    </span>
                  </span>
                  {r.total !== undefined && <strong className="num">{money(r.total)}</strong>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---------- pictures ----------

function canvasOf(img: Img): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

async function loadPhoto(file: Blob, maxSide = 2400): Promise<Img> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: d.width, height: d.height };
}

function detect(img: Img): { quad: Quad; found: boolean } {
  const small = shrink(img, 420);
  const q = findPaper(small.img);
  if (!q) return { quad: fullQuad(img.width, img.height), found: false };
  // Pull the corners in a touch, so the table's edge doesn't show as a dark line.
  const cx = q.reduce((n, p) => n + p.x, 0) / 4;
  const cy = q.reduce((n, p) => n + p.y, 0) / 4;
  const pull = (p: { x: number; y: number }) => ({ x: (p.x + (cx - p.x) * 0.012) / small.scale, y: (p.y + (cy - p.y) * 0.012) / small.scale });
  return { quad: q.map(pull) as Quad, found: true };
}

type Look = 'bw' | 'grey' | 'colour';
const LOOKS: { id: Look; label: string }[] = [
  { id: 'bw', label: 'Black and white' },
  { id: 'grey', label: 'Grey' },
  { id: 'colour', label: 'Colour' },
];

function finish(src: Img, quad: Quad, look: Look): Img {
  const flat = warp(src, quad);
  return look === 'bw' ? blackAndWhite(flat) : look === 'grey' ? greyscale(flat) : flat;
}

/** Drag the four corners onto the receipt's corners. */
function CornerEditor({ img, quad, onChange }: { img: Img; quad: Quad; onChange: (q: Quad) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number>();
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  }, [img]);
  const toImg = (e: RPointerEvent) => {
    const b = wrap.current!.getBoundingClientRect();
    return {
      x: Math.min(img.width, Math.max(0, ((e.clientX - b.left) / b.width) * img.width)),
      y: Math.min(img.height, Math.max(0, ((e.clientY - b.top) / b.height) * img.height)),
    };
  };
  const r = Math.max(img.width, img.height) / 30;
  const names = ['top left', 'top right', 'bottom right', 'bottom left'];
  return (
    <div
      ref={wrap}
      className="crop"
      style={{ aspectRatio: `${img.width} / ${img.height}`, width: `min(100%, calc(62vh * ${(img.width / img.height).toFixed(4)}))` }}
    >
      <canvas ref={ref} aria-hidden="true" />
      <svg
        viewBox={`0 0 ${img.width} ${img.height}`}
        onPointerMove={(e) => {
          if (drag === undefined) return;
          const q = [...quad] as Quad;
          q[drag] = toImg(e);
          onChange(q);
        }}
        onPointerUp={() => setDrag(undefined)}
        onPointerCancel={() => setDrag(undefined)}
      >
        <polygon points={quad.map((p) => `${p.x},${p.y}`).join(' ')} className="crop-edge" style={{ strokeWidth: r / 5 }} />
        {quad.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={r}
            className="crop-dot"
            style={{ strokeWidth: r / 4 }}
            role="slider"
            tabIndex={0}
            aria-label={`Move the ${names[i]} corner`}
            aria-valuetext={`${Math.round((p.x / img.width) * 100)}% across, ${Math.round((p.y / img.height) * 100)}% down`}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture?.(e.pointerId);
              setDrag(i);
            }}
            onKeyDown={(e) => {
              const step = Math.max(img.width, img.height) / 50;
              const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
              if (!d) return;
              e.preventDefault();
              const q = [...quad] as Quad;
              q[i] = { x: Math.min(img.width, Math.max(0, p.x + d[0])), y: Math.min(img.height, Math.max(0, p.y + d[1])) };
              onChange(q);
            }}
          />
        ))}
      </svg>
    </div>
  );
}

function ImgView({ img, label }: { img: Img; label: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(canvasOf(img).toDataURL('image/jpeg', 0.8));
  }, [img]);
  return url ? <img src={url} alt={label} className="receipt-photo" /> : null;
}

// ---------- one receipt ----------

interface Fields {
  shop: string;
  chain?: StoreChain;
  date: string;
  total: string;
  section: Section;
  note: string;
  text: string;
  pinned: boolean;
}

const fieldsOf = (r: Receipt): Fields => ({
  shop: r.shop ?? '',
  chain: r.chain as StoreChain | undefined,
  date: r.receiptDate ?? '',
  total: r.total !== undefined ? r.total.toFixed(2) : '',
  section: r.section,
  note: r.note ?? '',
  text: r.text ?? '',
  pinned: r.pinned,
});

/** Home → Receipts → Add a receipt (no id), or an existing receipt. */
/**
 * The words read off a receipt, every line shown and each one its own box, so a misread word can
 * be fixed without a fiddly text box. Recall alerts check these too.
 */
function ReceiptLines({ text, items, onChange }: { text: string; items: number; onChange: (text: string) => void }) {
  const lines = text ? text.split('\n') : [];
  const put = (i: number, v: string) => onChange(lines.map((l, j) => (j === i ? v : l)).join('\n'));
  const drop = (i: number) => onChange(lines.filter((_, j) => j !== i).join('\n'));
  return (
    <div className="card flush">
      <div className="section-head" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
        <span className="title">{lines.length ? `Words read off it${items ? ` · ${items} item lines` : ''}` : 'Words on the receipt'}</span>
        <span className="small">Recall alerts check these too. Tap a line to fix a word that was misread.</span>
      </div>
      {lines.map((l, i) => (
        <div key={i} className="row receipt-line">
          <input className="input" value={l} onChange={(e) => put(i, e.target.value)} aria-label={`Line ${i + 1}`} />
          <button className="icon-btn" onClick={() => drop(i)} aria-label={`Remove line ${i + 1}`}>
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
      <button className="row linkish small" onClick={() => onChange([...lines, ''].join('\n'))}>
        <Icon name="plus" size={16} /> Add a line
      </button>
    </div>
  );
}

export function ReceiptScreen({ id }: { id?: string }) {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const [existing, setExisting] = useState<Receipt>();
  const [photo, setPhoto] = useState<string>();
  // A saved receipt's other photos (a long receipt taken in several).
  const [morePhotos, setMorePhotos] = useState<string[]>([]);
  // 0.9.2: photos kept on the Restock server (older than "Keep price history for"), and ones fetched from it to show.
  const [onServer, setOnServer] = useState<string[]>([]);
  const [fetched, setFetched] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  // Photos already taken of this receipt, before the one being lined up now: what's read, and what's kept.
  const [pages, setPages] = useState<{ ocr: Img; shown: Img }[]>([]);
  const [step, setStep] = useState<'pick' | 'corners' | 'look' | 'details'>(id ? 'details' : 'pick');
  const [src, setSrc] = useState<Img>();
  const [quad, setQuad] = useState<Quad>();
  const [found, setFound] = useState(true);
  const [look, setLook] = useState<Look>('bw');
  const [result, setResult] = useState<Img>();
  const [fields, setFields] = useState<Fields>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const reader = useReader();

  useEffect(() => {
    if (!id) return;
    void getReceipt(id).then(async (r) => {
      if (!r) return;
      setExisting(r);
      setFields(fieldsOf(r));
      const missing: string[] = [];
      if (r.photo) {
        const b = await readPhoto(r.photo);
        if (b) setPhoto(dataUrl(b));
        else missing.push(r.photo);
      }
      const more: string[] = [];
      for (const path of r.pages ?? []) {
        const b = await readPhoto(path);
        if (b) more.push(dataUrl(b));
        else missing.push(path);
      }
      setMorePhotos(more);
      setOnServer(await photosOnServer(missing));
    });
  }, [id]);

  useEffect(() => {
    if (src && quad && step === 'look') setResult(finish(src, quad, look));
  }, [src, quad, look, step]);

  if (!settings) return <div className="screen" />;
  const tabs = activeSections(settings);
  const set = (p: Partial<Fields>) => setFields((f) => ({ ...(f as Fields), ...p }));

  const picked = async (file?: File) => {
    if (!file) return;
    setError(undefined);
    setBusy('Finding the receipt…');
    try {
      const img = await loadPhoto(file);
      const d = detect(img);
      setSrc(img);
      setQuad(d.quad);
      setFound(d.found);
      setStep('corners');
    } catch (e) {
      setError(`Couldn't open that photo: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(undefined);
    }
  };

  const turn = () => {
    if (!src || !quad) return;
    setSrc(rotate(src, 1));
    // The corners turn with the picture: (x, y) → (h - y, x), and stay in reading order.
    const q = quad.map((p) => ({ x: src.height - p.y, y: p.x })) as Quad;
    setQuad([q[3], q[0], q[1], q[2]]);
  };

  const turnResult = () => result && setResult(rotate(result, 1));

  const read = async (img: Img | Img[] | undefined) => {
    const imgs = img === undefined ? [] : Array.isArray(img) ? img : [img];
    const blank: Fields = { shop: '', date: '', total: '', section: tabs[0] ?? 'pantry', note: '', text: '', pinned: false };
    if (!imgs.length) {
      setFields(fields ?? blank);
      setStep('details');
      return;
    }
    setError(undefined);
    if (!(await readerInstalled())) {
      setFields(fields ?? blank);
      setStep('details');
      return;
    }
    try {
      setBusy('Starting the receipt reader…');
      // The reader does its own black and white, and does it best from the straightened photo itself.
      const texts: string[] = [];
      for (let i = 0; i < imgs.length; i++) {
        const tag = imgs.length > 1 ? `Photo ${i + 1} of ${imgs.length}: ` : '';
        texts.push((await readText(canvasOf(imgs[i]), (s) => setBusy(tag + s))).text);
      }
      // Several photos of one long receipt: join them, leaving out lines two photos both caught.
      const out = { text: imgs.length > 1 ? joinPages(texts) : texts[0] };
      const p = parseReceipt(out.text);
      setFields({
        ...(fields ?? blank),
        shop: p.shop ?? fields?.shop ?? '',
        chain: p.chain ?? fields?.chain,
        date: p.date ?? fields?.date ?? '',
        total: p.total !== undefined ? p.total.toFixed(2) : (fields?.total ?? ''),
        section: p.section && tabs.includes(p.section) ? p.section : (fields?.section ?? blank.section),
        text: out.text.trim(),
      });
      setStep('details');
    } catch (e) {
      setError(`Couldn't read it: ${e instanceof Error ? e.message : e}. You can fill it in yourself.`);
      setFields(fields ?? blank);
      setStep('details');
    } finally {
      setBusy(undefined);
    }
  };

  const save = async () => {
    if (!fields) return;
    setBusy('Saving…');
    try {
      const rid = existing?.id ?? uid();
      let path = existing?.photo;
      let extra = existing?.pages;
      const shots = [...pages.map((x) => x.shown), ...(result ? [result] : [])];
      if (shots.length) {
        const paths: string[] = [];
        for (let i = 0; i < shots.length; i++) {
          const p = photoPath(rid, i + 1);
          const jpeg = canvasOf(shots[i]).toDataURL('image/jpeg', look === 'colour' ? 0.72 : 0.62);
          await writePhoto(p, jpeg.slice(jpeg.indexOf(',') + 1));
          paths.push(p);
        }
        [path, ...extra] = paths;
        if (!extra.length) extra = undefined;
      }
      const total = parseFloat(fields.total.replace(/[$,\s]/g, ''));
      // 0.9.5 (undo)
      await act(existing ? 'Receipt saved' : 'Receipt added', () => saveReceipt({
        id: rid,
        scannedAt: existing?.scannedAt ?? nowIso(),
        shop: fields.shop.trim() || undefined,
        chain: fields.chain,
        receiptDate: fields.date || undefined,
        total: Number.isFinite(total) ? total : undefined,
        section: fields.section,
        note: fields.note.trim() || undefined,
        text: fields.text.trim() || undefined,
        photo: path,
        pages: extra,
        pinned: fields.pinned,
      }));
      nav.pop();
    } catch (e) {
      setError(`Couldn't save it: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async () => {
    if (!existing) return;
    // 0.9.5 (undo): no question first; Undo brings it back, photo and all.
    await removeReceiptsUndoable([existing], 'Receipt deleted');
    nav.pop();
  };

  const inputs = (
    <>
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void picked(e.target.files?.[0])} />
      <input ref={gallery} type="file" accept="image/*" hidden onChange={(e) => void picked(e.target.files?.[0])} />
    </>
  );
  const status = busy && (
    <div style={{ display: 'grid', gap: 6 }}>
      <span className="small" role="status">
        {busy}
      </span>
      <LoadingBar seconds={12} />
    </div>
  );
  const errorBox = error && <div className="banner amber">{error}</div>;

  if (step === 'pick') {
    return (
      <div className="screen">
        <TopBar title="Add a receipt" />
        {inputs}
        <div className="card">
          {pages.length ? (
            <>
              <p style={{ margin: 0 }}>
                <strong>Photo {pages.length + 1}:</strong> take the next part of the receipt, a little further down.
              </p>
              <p className="small" style={{ margin: 0 }}>
                Let it overlap the last photo by a line or two. Restock reads every photo and leaves out the lines it sees twice.
              </p>
            </>
          ) : (
            <>
              <p style={{ margin: 0 }}>
                Lay the receipt flat on a darker surface, with a little space around it, and take the photo from straight above.
              </p>
              <p className="small" style={{ margin: 0 }}>
                A long receipt? Take it in several photos, top to bottom: after the first one, tap "Add the next part".
              </p>
            </>
          )}
        </div>
        <button className="btn primary block" onClick={() => camera.current?.click()} disabled={!!busy}>
          <Icon name="camera" size={18} /> Take a photo
        </button>
        <button className="btn block" onClick={() => gallery.current?.click()} disabled={!!busy}>
          Choose a photo you already took
        </button>
        {pages.length ? (
          <button className="btn ghost block" disabled={!!busy} onClick={() => void read(pages.map((x) => x.ocr))}>
            That's all of it: read {pages.length === 1 ? 'the photo' : `the ${pages.length} photos`}
          </button>
        ) : (
          <button className="btn ghost block" onClick={() => void read(undefined)}>
            No photo, just type it in
          </button>
        )}
        {status}
        {errorBox}
        <p className="small">The photo is kept inside Restock, not in your phone's gallery.</p>
      </div>
    );
  }

  if (step === 'corners' && src && quad) {
    return (
      <div className="screen">
        <TopBar title="Line up the corners" />
        <p className="sub">
          {found ? 'Drag a corner if it isn’t on the receipt’s corner.' : 'Couldn’t spot the edges: drag the corners onto the receipt’s corners.'}
        </p>
        <CornerEditor img={src} quad={quad} onChange={setQuad} />
        <div className="two">
          <button className="btn" onClick={turn}>
            <Icon name="refresh" size={17} /> Turn
          </button>
          <button className="btn" onClick={() => setQuad(fullQuad(src.width, src.height, 0))}>
            Whole photo
          </button>
        </div>
        <button className="btn primary block" onClick={() => setStep('look')}>
          Next
        </button>
        <button className="btn ghost block" onClick={() => setStep('pick')}>
          Take it again
        </button>
      </div>
    );
  }

  if (step === 'look' && src && quad) {
    return (
      <div className="screen">
        <TopBar title={pages.length ? `Check photo ${pages.length + 1}` : 'Check it'} />
        <div className="seg" role="radiogroup" aria-label="How it looks">
          {LOOKS.map((l) => (
            <button key={l.id} role="radio" aria-checked={look === l.id} className={look === l.id ? 'on' : ''} onClick={() => setLook(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
        {result && <ImgView img={result} label="The straightened receipt" />}
        <div className="two">
          <button className="btn" onClick={turnResult}>
            <Icon name="refresh" size={17} /> Turn
          </button>
          <button className="btn" onClick={() => setStep('corners')}>
            Corners
          </button>
        </div>
        <button className="btn primary block" disabled={!!busy || !result} onClick={() => void read([...pages.map((x) => x.ocr), warp(src, quad)])}>
          {pages.length ? `Read all ${pages.length + 1} photos` : 'Read the receipt'}
        </button>
        <button
          className="btn block"
          disabled={!!busy || !result}
          onClick={() => {
            if (!result) return;
            setPages((p) => [...p, { ocr: warp(src, quad), shown: result }]);
            setResult(undefined);
            setSrc(undefined);
            setQuad(undefined);
            setStep('pick');
          }}
        >
          <Icon name="camera" size={17} /> Long receipt? Add the next part
        </button>
        {status}
        {errorBox}
      </div>
    );
  }

  if (!fields) return <div className="screen" />;
  const on = existing ? deleteOn({ scannedAt: existing.scannedAt, pinned: fields.pinned }, settings.receipts.keepMonths) : undefined;
  const items = itemLines(fields.text);

  return (
    <div className="screen">
      <TopBar title={existing ? fields.shop || 'Receipt' : 'Receipt details'} />
      {inputs}
      {result || pages.length
        ? [...pages.map((x) => x.shown), ...(result ? [result] : [])].map((im, i, all) => (
            <ImgView key={i} img={im} label={all.length > 1 ? `The receipt, photo ${i + 1} of ${all.length}` : 'The receipt'} />
          ))
        : [photo, ...morePhotos]
            .filter((x): x is string => !!x)
            .map((u, i, all) => (
              <img key={i} src={u} alt={all.length > 1 ? `The receipt, photo ${i + 1} of ${all.length}` : 'The receipt'} className="receipt-photo" />
            ))}
      {!result && !pages.length && fetched.map((u, i) => <img key={`s${i}`} src={u} alt="The receipt, from your Restock server" className="receipt-photo" />)}
      {!result && !pages.length && onServer.length > fetched.length && (
        <div className="card" style={{ gap: 6 }}>
          <span className="small">{onServer.length === 1 ? 'Photo kept on your Restock server' : `${onServer.length} photos kept on your Restock server`}</span>
          <button
            className="btn small"
            style={{ alignSelf: 'flex-start' }}
            disabled={fetching}
            onClick={async () => {
              setFetching(true);
              setError(undefined);
              try {
                const got: string[] = [];
                for (const path of onServer) got.push(dataUrl(await serverPhoto(path)));
                setFetched(got);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setFetching(false);
              }
            }}
          >
            {fetching ? 'Getting it…' : onServer.length === 1 ? 'Show it' : 'Show them'}
          </button>
        </div>
      )}
      {errorBox}
      {!existing && fields.text && <p className="small">Check what was read and fix anything that's wrong.</p>}
      <div className="card">
        <label className="field">
          <span>Shop</span>
          <input className="input" value={fields.shop} onChange={(e) => set({ shop: e.target.value })} placeholder="e.g. Woolworths Newtown" />
        </label>
        <label className="field">
          <span>Which chain</span>
          <select
            className="input"
            value={fields.chain ?? ''}
            onChange={(e) => set({ chain: (e.target.value || undefined) as StoreChain | undefined })}
          >
            <option value="">Another shop</option>
            {SHOPS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <div className="two">
          <label className="field">
            <span>Date on it</span>
            <input className="input" type="date" value={fields.date} onChange={(e) => set({ date: e.target.value })} />
          </label>
          <label className="field">
            <span>Total</span>
            <input
              className="input num"
              inputMode="decimal"
              value={fields.total}
              onChange={(e) => set({ total: e.target.value })}
              placeholder="0.00"
              aria-label="Total in dollars"
            />
          </label>
        </div>
        {tabs.length > 1 && (
          <div className="field">
            <span>For</span>
            <div className="seg" role="radiogroup" aria-label="Which tab it's for">
              {tabs.map((t) => (
                <button
                  key={t}
                  role="radio"
                  aria-checked={fields.section === t}
                  className={fields.section === t ? 'on' : ''}
                  onClick={() => set({ section: t })}
                >
                  <Icon name={t} size={16} /> {SECTION_NAMES[t]}
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="field">
          <span>Note</span>
          <input
            className="input"
            value={fields.note}
            onChange={(e) => set({ note: e.target.value })}
            placeholder="Optional, e.g. warranty for the kettle"
          />
        </label>
        <label className="check" style={{ padding: 0 }}>
          <input type="checkbox" className="switch" checked={fields.pinned} onChange={(e) => set({ pinned: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Pin it: keep this one
            </span>
            <span className="small">
              {fields.pinned
                ? 'Kept until you delete it.'
                : settings.receipts.keepMonths
                  ? `Otherwise deleted ${on ? dayText(on) : `${keepLabel(settings.receipts.keepMonths).toLowerCase()} after scanning`}.`
                  : 'Receipts are kept until you delete them.'}
            </span>
          </span>
        </label>
      </div>
      <ReceiptLines text={fields.text} items={items.length} onChange={(text) => set({ text })} />
      <button className="btn primary block" disabled={!!busy} onClick={() => void save()}>
        {existing ? 'Save' : 'Add receipt'}
      </button>
      {existing && photo && reader.installed && (
        <button
          className="btn block"
          disabled={!!busy}
          onClick={async () => {
            const imgs: Img[] = [];
            for (const u of [photo, ...morePhotos]) imgs.push(await loadPhoto(await (await fetch(u)).blob()));
            await read(imgs);
          }}
        >
          Read it again
        </button>
      )}
      {existing && (
        <button className="btn ghost block" style={{ color: 'var(--red-ink)' }} onClick={() => void remove()}>
          <Icon name="trash" size={17} /> Delete receipt
        </button>
      )}
      {status}
    </div>
  );
}
