// 0.18.3: the server page's small parts: icons, cards, rows, switches, the two-way and three-way
// choices, dialogs (with the keyboard and screen readers in mind), a toast, loading, and a QR code.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { useLatest } from '../../ui/useLatest';
import { ApiError } from '../api';

// ---------- icons ----------

const PATHS = {
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  tablet: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 18h2"/>',
  data: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  ha: '<path d="M3 12l9-8 9 8"/><path d="M5 10.5V20h14v-9.5"/><circle cx="12" cy="14" r="2"/><path d="M12 16v4"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'plus' ? 2.5 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: PATHS[name] }} />
  );
}

// ---------- layout ----------

export function PageHead({ group, title, sub, children }: { group?: string; title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="sv-head">
      <div>
        {group && <p className="sv-eyebrow">{group}</p>}
        <h1 tabIndex={-1} data-page-title>
          {title}
        </h1>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`sv-card ${className}`}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

/** A setting's row: its name, a line under it, and its control. */
export function Row({ label, sub, children, wrap }: { label: ReactNode; sub?: ReactNode; children?: ReactNode; wrap?: boolean }) {
  return (
    <div className={`sv-row${wrap ? ' wrap' : ''}`}>
      <span className="sv-grow">
        <span className="sv-label">{label}</span>
        {sub && <span className="sv-small">{sub}</span>}
      </span>
      {children}
    </div>
  );
}

export function Switch({ label, sub, on, onChange, disabled }: { label: string; sub?: ReactNode; on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="sv-row">
      <span className="sv-grow">
        <label htmlFor={id} className="sv-label">
          {label}
        </label>
        {sub && <span className="sv-small">{sub}</span>}
      </span>
      <input id={id} type="checkbox" role="switch" className="sv-switch" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

export function Seg<T extends string | number>({ label, options, value, onChange, disabled }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="sv-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} disabled={disabled} onClick={() => o.value !== value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Lock({ children = 'Needs the passphrase and a yes on an admin phone' }: { children?: ReactNode }) {
  return (
    <span className="sv-lock">
      <Icon name="lock" size={14} /> {children}
    </span>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <div className="sv-loading" role="progressbar" aria-label={label} />;
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Something from the server, with reload; `error` in words. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []): { data?: T; error?: string; reload: () => void; set: (v: T) => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [n, setN] = useState(0);
  const latest = useLatest(load);
  useEffect(() => {
    let on = true;
    latest
      .current()
      .then((v) => {
        if (!on) return;
        setData(v);
        setError(undefined);
      })
      .catch((e: unknown) => on && setError(errText(e)));
    return () => {
      on = false;
    };
  }, [n, latest, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, reload, set: setData };
}

/** A load's error, with Try again. */
export function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="sv-row wrap" role="alert">
      <p className="sv-error sv-grow">{error}</p>
      <button className="sv-btn sm" type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

// ---------- dialogs ----------

/** A dialog over the page: Escape closes it, focus goes in and comes back. */
export function Dialog({ title, onClose, children, wide, labelledBy }: { title?: string; onClose: () => void; children: ReactNode; wide?: boolean; labelledBy?: string }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const close = useLatest(onClose);
  useEffect(() => {
    const was = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-later])');
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key !== 'Tab' || !box.current) return;
      const all = [...box.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select, textarea')];
      if (!all.length) return;
      const [a, z] = [all[0], all[all.length - 1]];
      if (e.shiftKey && document.activeElement === a) {
        z.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === z) {
        a.focus();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      was?.focus?.();
    };
  }, [close]);
  return (
    <div className="sv-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className={`sv-card sv-dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? id}>
        {title && <h2 id={id}>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

/** Shows a dialog outside React's tree and waits for its answer (for ask() and the like). */
export function mount<T>(render: (done: (v: T) => void) => ReactNode): Promise<T> {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    const done = (v: T) => {
      root.unmount();
      el.remove();
      resolve(v);
    };
    root.render(render(done));
  });
}

/** Are you sure? Yes (the action's words) or Cancel. */
export function sure(title: string, detail: ReactNode, action: string, danger = false): Promise<boolean> {
  return mount<boolean>((done) => (
    <Dialog title={title} onClose={() => done(false)}>
      <p className="sv-small" style={{ fontSize: 15 }}>
        {detail}
      </p>
      <div className="sv-actions">
        <button className="sv-btn" type="button" onClick={() => done(false)}>
          Cancel
        </button>
        <button className={`sv-btn ${danger ? 'danger' : 'primary'}`} type="button" onClick={() => done(true)}>
          {action}
        </button>
      </div>
    </Dialog>
  ));
}

/** Asks for one thing (the passphrase, a name, a word to type). Undefined when cancelled. */
export function ask(o: { title: string; detail?: ReactNode; label: string; action: string; secret?: boolean; value?: string; danger?: boolean; must?: string; autoComplete?: string }): Promise<string | undefined> {
  return mount<string | undefined>((done) => <AskBox o={o} done={done} />);
}
function AskBox({ o, done }: { o: Parameters<typeof ask>[0]; done: (v: string | undefined) => void }) {
  const [v, setV] = useState(o.value ?? '');
  const id = useId();
  const ok = o.must ? v.trim() === o.must : v.length > 0;
  return (
    <Dialog title={o.title} onClose={() => done(undefined)}>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) done(v);
        }}
      >
        {o.detail && (
          <p className="sv-small" style={{ fontSize: 15 }}>
            {o.detail}
          </p>
        )}
        <div className="sv-field">
          <label htmlFor={id}>{o.label}</label>
          <input id={id} className="sv-input" type={o.secret ? 'password' : 'text'} value={v} autoComplete={o.autoComplete ?? (o.secret ? 'current-password' : 'off')} onChange={(e) => setV(e.target.value)} />
        </div>
        <div className="sv-actions">
          <button className="sv-btn" type="button" onClick={() => done(undefined)}>
            Cancel
          </button>
          <button className={`sv-btn ${o.danger ? 'danger' : 'primary'}`} type="submit" disabled={!ok}>
            {o.action}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- the toast ----------

let toastSet: ((t: string | undefined) => void) | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** A short line at the bottom ("Saved"), read out by screen readers. */
export function toast(text: string): void {
  toastSet?.(text);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastSet?.(undefined), 3500);
}
export function Toasts() {
  const [t, setT] = useState<string>();
  useEffect(() => {
    toastSet = setT;
    return () => {
      toastSet = undefined;
    };
  }, []);
  return (
    <div role="status" aria-live="polite">
      {t && <div className="sv-toast">{t}</div>}
    </div>
  );
}

/** Runs a change: Saved (or the words given) when it works, the server's words when it doesn't. */
export async function change<T>(run: () => Promise<T>, saved = 'Saved'): Promise<T | undefined> {
  try {
    const out = await run();
    if (saved) toast(saved);
    return out;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'approve-cancelled') toast('Nothing changed');
    else toast(errText(e));
    return undefined;
  }
}

// ---------- a QR code (zxing's writer, bundled; nothing leaves the page) ----------

export function qrSvg(symbol: { data: ArrayLike<number>; width: number; height: number }): string {
  const q = 4;
  let d = '';
  for (let y = 0; y < symbol.height; y++) for (let x = 0; x < symbol.width; x++) if (symbol.data[y * symbol.width + x] < 128) d += `M${x + q} ${y + q}h1v1h-1z`;
  const w = symbol.width + q * 2;
  const h = symbol.height + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%" shape-rendering="crispEdges"><rect width="${w}" height="${h}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

export function Qr({ text, label, small }: { text: string; label: string; small?: boolean }) {
  const [svg, setSvg] = useState<{ text: string; svg: string }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [mod, { default: wasmUrl }] = await Promise.all([import('zxing-wasm/writer'), import('zxing-wasm/writer/zxing_writer.wasm?url')]);
      mod.prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } });
      const r = await mod.writeBarcode(text, { format: 'QRCode', options: 'ecLevel=M' });
      if (alive && r.symbol?.width) setSvg({ text, svg: qrSvg(r.symbol) });
      else if (alive) setFailed(true);
    })().catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [text]);
  const shown = svg?.text === text ? svg.svg : undefined;
  return (
    <div className={`sv-qr${small ? ' small' : ''}`} role="img" aria-label={label} data-code={text}>
      {shown ? <span style={{ width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: shown }} /> : failed ? <p className="sv-small">Couldn't draw the code.</p> : <Loading label="Drawing the code" />}
    </div>
  );
}

// ---------- words ----------

export function ago(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function bytes(n: number | undefined): string {
  const b = Number(n) || 0;
  if (b < 1024 * 1024) return `${Math.max(0, Math.round(b / 1024))} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}

export const count = (n: number | undefined, one: string, many = one + 's') => `${(Number(n) || 0).toLocaleString('en-AU')} ${(Number(n) || 0) === 1 ? one : many}`;

/** Saves text or bytes as a file the browser downloads. */
export function saveFile(name: string, body: BlobPart, type = 'application/octet-stream'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
