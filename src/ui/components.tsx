import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { nameHasSize } from '../lib/naming';
import { RestockNative } from '../lib/sql/native';
import { formatUnitPrice, money, tidySize, tidyUnitText } from '../lib/units';
import { fetchDetails, type ProductDetails } from '../stores/details';
import { isNative, promoLabel } from '../stores/http';
import { describe, eachText, productQty, type Option } from '../lib/verdict';
import { chainName, stockAtBranch, type Chain, type PriceReading } from '../types';
import { cachedSettings } from '../lib/db';
import { SECTION_NAMES, shopColor, websiteOf, type Section } from '../shops';
import { useNav } from './nav';

// ---------- icons (inline stroke SVG) ----------

const paths: Record<string, ReactNode> = {
  home: <path d="M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  folder: <path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  pantry: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M4 9h16M4 15h16" />
    </>
  ),
  keg: (
    <>
      <rect x="5" y="5" width="14" height="16" rx="3" />
      <path d="M5 10h14M5 16h14M10 5V3h4v2" />
    </>
  ),
  // A green cross on a rounded square: always green, so it reads as "pharmacy" at a glance.
  pharmacy: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" fill="var(--pharm)" stroke="none" />
      <path d="M12 7.5v9M7.5 12h9" stroke="#fff" strokeWidth="2.6" />
    </>
  ),
  scan: <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M11 8v8M15 8v8" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />,
  back: <path d="M15 18l-6-6 6-6" />,
  chevron: <path d="M9 18l6-6-6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  refresh: <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),
  trash: <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />,
  card: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  box: <path d="M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8" />,
  swap: <path d="M7 7h11l-3-3M17 17H6l3 3" />,
  star: <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />,
  up: <path d="M18 15l-6-6-6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  pencil: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z" />,
  torch: <path d="M8 2h8v4l-2 4v12h-4V10L8 6zM8 6h8M12 13v2" />,
  pin: (
    <>
      <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  cart: (
    <>
      <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2" />
      <circle cx="10" cy="20.5" r="1" />
      <circle cx="17" cy="20.5" r="1" />
    </>
  ),
  cartCheck: (
    <>
      <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2" />
      <circle cx="10" cy="20.5" r="1" />
      <circle cx="17" cy="20.5" r="1" />
      <path d="M10 11.5l2 2 4-4" />
    </>
  ),
  cartPlus: (
    <>
      <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2" />
      <circle cx="10" cy="20.5" r="1" />
      <circle cx="17" cy="20.5" r="1" />
      <path d="M13 9v5M10.5 11.5h5" />
    </>
  ),
  book: <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7M8 11h5" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  phone: <path d="M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5zM11 18.5h2" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5h.01" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" />
    </>
  ),
  tag: <path d="M3 12V4h8l10 10-8 8L3 12zM7.5 8.5h0" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 17l-5-5-9 8" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  sliders: <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  shield: <path d="M12 3l8 3v6c0 5-3.4 8.2-8 9-4.6-.8-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5" />,
  receipt: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3" />,
  download: <path d="M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />,
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-1.4-1-1.6-1-3 0-1 .8-2 2-2h2a4 4 0 0 0 4-4c0-3.9-4-7-9-7z" />
      <circle cx="7.5" cy="11" r="1.2" />
      <circle cx="10" cy="7" r="1.2" />
      <circle cx="15" cy="7.5" r="1.2" />
    </>
  ),
  access: (
    <>
      <circle cx="12" cy="4.5" r="1.8" />
      <path d="M4 8.5l8 1.5 8-1.5M12 10v5M12 15l-3.5 6M12 15l3.5 6" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4" />
    </>
  ),
  alert: <path d="M12 3l10 18H2zM12 10v5M12 18h.01" />,
  bug: <path d="M8 8a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0zM4 10h4M16 10h4M4 16h4M16 16h4M9 4l1.5 2M15 4l-1.5 2" />,
  flame: <path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 0 2 1 3 2 3 0-3-1-5.5.5-8z" />,
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
};

export function Icon({
  name,
  size = 22,
  fill = 'none',
  stroke = 2,
}: {
  name: keyof typeof paths | string;
  size?: number;
  fill?: string;
  stroke?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

// ---------- small pieces ----------

export function TopBar({ title, right, back = true }: { title: string; right?: ReactNode; back?: boolean }) {
  const nav = useNav();
  return (
    <div className="topbar">
      {back && (
        <button className="icon-btn" aria-label="Back" onClick={nav.pop}>
          <Icon name="back" size={20} />
        </button>
      )}
      <h1 style={back ? { fontSize: 24 } : undefined}>{title}</h1>
      {right}
    </div>
  );
}

export function ChainDot({ chain }: { chain: Chain }) {
  return <span className={`dot chain-dot ${chain}`} style={{ background: shopColor(chain) }} aria-hidden="true" />;
}

/** A small Keg or Pharmacy icon before an item's name, where items from every tab are mixed (Home). */
export function SectionMark({ section }: { section?: Section }) {
  if (!section || section === 'pantry') return null;
  return (
    <span className="section-mark" title={SECTION_NAMES[section]} aria-label={`${SECTION_NAMES[section]}:`}>
      <Icon name={section} size={15} />
    </span>
  );
}

export function ChainName({ chain }: { chain: Chain }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <ChainDot chain={chain} />
      {chainName(chain)}
    </span>
  );
}

/**
 * The member program behind a shop's member prices (0.9.0, one list for every tag): Flybuys at Coles
 * and the Liquorlands, Everyday Rewards at Woolworths and BWS, My Dan's at Dan Murphy's.
 */
export function memberProgram(chain: string): { name?: string; cls: 'flybuys' | 'everyday' | 'normal' } {
  if (chain === 'coles' || chain.startsWith('liquorland')) return { name: 'Flybuys', cls: 'flybuys' };
  if (chain === 'woolworths' || chain === 'bws') return { name: 'Everyday Rewards', cls: 'everyday' };
  if (chain === 'danmurphys') return { name: "My Dan's", cls: 'normal' };
  return { cls: 'normal' };
}

export function MemberTag({ chain }: { chain: Chain }) {
  const { name, cls } = memberProgram(chain);
  return <span className={`tag ${cls}`}>{name ? `MEMBER PRICE · ${name.toUpperCase()}` : 'MEMBER PRICE'}</span>;
}

/**
 * Where stock was checked, for "Out of stock …": "at Coles Kirwan" when your Coles branch is
 * checked (testing), else "online" (the shop's default online store). `long` adds the shop name.
 */
export function stockWhere(chain: string, long = false): string {
  const branch = stockAtBranch(cachedSettings(), chain);
  if (branch) return `at ${branch}`;
  return long ? `online at ${chainName(chain as never)}` : 'online';
}

/**
 * A product's photo with an ⓘ on it: tap it for more info (a bigger photo, ingredients and
 * nutrition), so you don't have to know to press and hold. Used on every list of products.
 */
export function MoreInfo({ src, name, onOpen }: { src?: string; name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="thumb-btn"
      aria-label={`More info about ${name}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      }}
    >
      <Thumb src={src} />
      <span className="info-dot" aria-hidden>
        <Icon name="info" size={12} />
      </span>
    </button>
  );
}

export function Thumb({ src, icon = 'box' }: { src?: string; icon?: string }) {
  // A shop's picture that won't load shows the plain icon instead of a broken image.
  const [broken, setBroken] = useState<string | undefined>();
  return (
    <div className="thumb">
      {src && broken !== src ? (
        <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(src)} />
      ) : (
        <span style={{ color: 'var(--muted)' }}>
          <Icon name={icon} size={24} />
        </span>
      )}
    </div>
  );
}

export function Price({ value, was }: { value?: number; was?: number }) {
  return (
    <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="num" style={{ fontSize: 17, fontWeight: 600 }}>
        {money(value)}
      </span>
      {was !== undefined && was > (value ?? 0) && (
        <span className="num small" style={{ textDecoration: 'line-through' }}>
          {money(was)}
        </span>
      )}
    </div>
  );
}

// ---------- Android back button ----------
//
// One back press (or Escape) does one thing. App.tsx works through, in order:
//   1. the scanner, if it's open;
//   2. the newest open layer: a Sheet, the confirm dialog, shopping mode (useBackLayer);
//   3. the top screen on the screen stack (nav.pop);
//   4. back handlers (useBackHandler), newest first: for steps that aren't on the screen
//      stack, like first-run setup's welcome → privacy → tiles. Return true if you handled it
//      (went back a step); return false to let the next one, then App, carry on;
//   5. the Home tab, then leaving the app.
// Usage, e.g. in Onboarding:
//   useBackHandler(() => {
//     if (stage === 'privacy') { setStage('welcome'); return true; }
//     return false;
//   });

interface BackEntry {
  fn: () => boolean;
  layer: boolean;
}
const backEntries: BackEntry[] = [];

function useBackEntry(fn: () => boolean, layer: boolean, active: boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const entry: BackEntry = { fn: () => ref.current(), layer };
    backEntries.push(entry);
    // Escape (a desktop keyboard) closes only the top layer; the scanner handles its own.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !layer || document.querySelector('.scanner')) return;
      if (backEntries.filter((x) => x.layer).pop() === entry) entry.fn();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = backEntries.indexOf(entry);
      if (i >= 0) backEntries.splice(i, 1);
    };
  }, [layer, active]);
}

/** An overlay (a sheet, shopping mode) that back or Escape closes, but only while it's the top one. */
export function useBackLayer(onClose: () => void, active = true) {
  useBackEntry(
    () => {
      onClose();
      return true;
    },
    true,
    active,
  );
}

/** Handle the back button yourself (see above): return true if handled. The newest handler goes first. */
export function useBackHandler(fn: () => boolean, active = true) {
  useBackEntry(fn, false, active);
}

/** For App: close the newest open layer. False if none is open. */
export function closeTopLayer(): boolean {
  const top = backEntries.filter((x) => x.layer).pop();
  return top ? (top.fn(), true) : false;
}

/** For App: give the back handlers a go, newest first. True once one has handled it. */
export function runBackHandlers(): boolean {
  return backEntries
    .filter((x) => !x.layer)
    .reverse()
    .some((x) => x.fn());
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A sheet over the screen (0.9.0: a proper modal dialog for screen readers and keyboards). Focus
 * moves to its title when it opens (unless something in it, like a price box, takes it first), Tab
 * stays inside it, and focus goes back to whatever opened it when it closes.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useBackLayer(onClose);
  const ref = useRef<HTMLDivElement>(null);
  // What had focus before the sheet drew (the button that opened it), so focus can go back there.
  const [opener] = useState(() => (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null));
  useEffect(() => {
    const sheet = ref.current;
    if (!sheet) return;
    if (!sheet.contains(document.activeElement)) sheet.querySelector<HTMLElement>('.sheet-title')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !items.includes(at as HTMLElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    sheet.addEventListener('keydown', onKey);
    return () => {
      sheet.removeEventListener('keydown', onKey);
      // Not back into a text box: that would pop the keyboard up.
      const typing = opener?.matches('textarea, input:not([type="checkbox"]):not([type="radio"])');
      if (opener && opener !== document.body && opener.isConnected && !typing) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  return (
    <div className="sheet-back" onClick={onClose}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="topbar">
          <h2 className="sheet-title" tabIndex={-1} style={{ flex: 1 }}>
            {title}
          </h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A screen reader announcement area that's always there and shows nothing on screen (0.9.0). Live
 * regions only speak when their text changes, so a toast that appears with its words already in it
 * can go unread; App puts each toast's words in here as well.
 */
export function Announcer({ text }: { text?: string }) {
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {text ?? ''}
    </div>
  );
}

export function timeAgo(iso?: string): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ---------- price chart ----------

export function PriceChart({ readings, typical }: { readings: PriceReading[]; typical?: number }) {
  const [tapped, setTapped] = useState<number>();
  if (readings.length < 2) {
    return <p className="small">The price history chart appears after a couple of price checks.</p>;
  }
  const W = 340;
  const H = 170;
  const pad = { l: 44, r: 10, t: 12, b: 24 };
  const t0 = Date.parse(readings[0].date);
  const t1 = Date.parse(readings[readings.length - 1].date);
  const prices = readings.map((r) => r.price).concat(typical ? [typical] : []);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  // A flat price gets a sensible band around it (±10%), not labels like $4.97 / $5.01.
  const flat = max - min < 0.05;
  const span = flat ? Math.max(0.2, max * 0.2) : Math.max(0.2, max - min);
  const lo = Math.max(0, flat ? min - span / 2 : min - span * 0.15);
  const hi = flat ? max + span / 2 : max + span * 0.1;
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (p: number) => pad.t + (1 - (p - lo) / Math.max(0.01, hi - lo)) * (H - pad.t - pad.b);
  // Step line: price holds until the next reading.
  let d = '';
  readings.forEach((r, i) => {
    const px = x(Date.parse(r.date));
    const py = y(r.price);
    if (i === 0) d += `M${px},${py}`;
    else d += `H${px}V${py}`;
  });
  const last = readings[readings.length - 1];
  const day = (t: number) => new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  // Three price gridlines and up to four date ticks.
  const yTicks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
  const xTicks = [0, 1 / 3, 2 / 3, 1].map((f) => t0 + (t1 - t0) * f);
  const label = `Price history from ${day(t0)} to ${day(t1)}, between ${money(Math.min(...readings.map((r) => r.price)))} and ${money(Math.max(...readings.map((r) => r.price)))}. Tap the chart to see the price on a day.`;
  const sel = tapped !== undefined ? readings[tapped] : undefined;
  const pickAt = (clientX: number, el: SVGSVGElement) => {
    const box = el.getBoundingClientRect();
    const vx = ((clientX - box.left) / box.width) * W;
    let best = 0;
    readings.forEach((r, i) => {
      if (Math.abs(x(Date.parse(r.date)) - vx) < Math.abs(x(Date.parse(readings[best].date)) - vx)) best = i;
    });
    setTapped(best);
  };
  const muted = { fill: 'var(--muted)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <p className="small num" style={{ margin: 0, minHeight: 18 }} aria-live="polite">
        {sel ? (
          <>
            <strong style={{ color: 'var(--ink)' }}>{money(sel.price)}</strong> on {day(Date.parse(sel.date))}
            {sel.isSpecial ? ' · on special' : ''}
            {sel.wasPrice && sel.wasPrice > sel.price ? ` · was ${money(sel.wasPrice)}` : ''}
          </>
        ) : (
          'Tap the chart to see the price on any day.'
        )}
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={label}
        style={{ display: 'block', touchAction: 'pan-y' }}
        onClick={(e) => pickAt(e.clientX, e.currentTarget)}
        onTouchMove={(e) => pickAt(e.touches[0].clientX, e.currentTarget)}
      >
        {yTicks.map((p) => (
          <g key={p}>
            <line x1={pad.l} x2={W - pad.r} y1={y(p)} y2={y(p)} style={{ stroke: 'var(--line-soft)' }} />
            <text x={pad.l - 6} y={y(p) + 4} fontSize="11" textAnchor="end" style={muted}>
              {money(p)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={t} x={x(t)} y={H - 6} fontSize="11" textAnchor={i === 0 ? 'start' : i === 3 ? 'end' : 'middle'} style={muted}>
            {i === 3 ? 'Today' : day(t)}
          </text>
        ))}
        {typical !== undefined && (
          <>
            <line x1={pad.l} x2={W - pad.r} y1={y(typical)} y2={y(typical)} strokeDasharray="4 4" style={{ stroke: 'var(--muted)' }} />
            <text x={W - pad.r} y={y(typical) - 5} fontSize="11" textAnchor="end" style={muted}>
              normal {money(typical)}
            </text>
          </>
        )}
        <path d={d} fill="none" strokeWidth={2.5} strokeLinejoin="round" style={{ stroke: 'var(--green)' }} />
        {readings
          .filter((r) => r.isSpecial)
          .map((r) => (
            <circle key={r.date} cx={x(Date.parse(r.date))} cy={y(r.price)} r={2.5} style={{ fill: 'var(--green)' }} />
          ))}
        <circle cx={x(Date.parse(last.date))} cy={y(last.price)} r={5} style={{ fill: 'var(--green-solid)' }} />
        {sel && (
          <>
            <line
              x1={x(Date.parse(sel.date))}
              x2={x(Date.parse(sel.date))}
              y1={pad.t}
              y2={H - pad.b}
              style={{ stroke: 'var(--ink-2)' }}
              strokeDasharray="2 3"
            />
            <circle cx={x(Date.parse(sel.date))} cy={y(sel.price)} r={6} style={{ fill: 'var(--surface)', stroke: 'var(--ink)' }} strokeWidth={2} />
          </>
        )}
      </svg>
      <p className="small" style={{ margin: 0 }}>
        Dots are specials. The dashed line is the normal price.
      </p>
    </div>
  );
}

/** A short "how this works" note that opens when tapped. */
export function Explain({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="explain" open={open}>
      <summary>
        <Icon name="info" size={18} />
        <span>{title}</span>
      </summary>
      <div className="explain-body">{children}</div>
    </details>
  );
}

/** Bar shown while picking several rows at once. */
export function SelectBar({
  count,
  total,
  onAll,
  onNone,
  onDone,
  children,
}: {
  count: number;
  total: number;
  onAll: () => void;
  onNone: () => void;
  onDone: () => void;
  children: ReactNode;
}) {
  return (
    <div className="selectbar" role="region" aria-label="Selected items">
      <div className="selectbar-top">
        <strong className="num">{count} selected</strong>
        <button className="chip" onClick={count === total ? onNone : onAll}>
          {count === total ? 'Select none' : 'Select all'}
        </button>
        <span style={{ flex: 1 }} />
        <button className="chip" onClick={onDone}>
          Done
        </button>
      </div>
      <div className="selectbar-actions">{children}</div>
    </div>
  );
}

/** Opens a store's website so the user can clear its "are you human" check, then calls onDone (e.g. to retry). */
export function OpenStoreButton({ chain = 'coles', onDone, label }: { chain?: Exclude<Chain, 'other'>; onDone?: () => void; label?: string }) {
  if (!isNative()) return null;
  return (
    <button
      className="btn small"
      onClick={async () => {
        await RestockNative.openStore({ chain, home: websiteOf(chain) }).catch(() => undefined);
        onDone?.();
      }}
    >
      {label ?? `Open ${chainName(chain)}`}
    </button>
  );
}

/** Light / dark / follow the phone. */
export function ThemePicker({ value, onChange }: { value: 'system' | 'light' | 'dark'; onChange: (v: 'system' | 'light' | 'dark') => void }) {
  const opts = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ] as const;
  return (
    <div className="seg" role="group" aria-label="Appearance">
      {opts.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The Restock logo: a basket with a falling price line. */
export function Logo({ size = 56 }: { size?: number }) {
  // Same drawing as the launcher icon (android/.../ic_launcher_foreground.xml, assets/icon.svg).
  return (
    <svg width={size} height={size} viewBox="18 18 72 72" role="img" aria-label="Restock">
      <defs>
        <linearGradient id="restock-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1F8352" />
          <stop offset="1" stopColor="#10512F" />
        </linearGradient>
      </defs>
      <rect x="18" y="18" width="72" height="72" rx="16" fill="url(#restock-logo-g)" />
      <g transform="translate(54 54.5) scale(0.8) translate(-54 -53.5)">
        <path d="M38.5,47 C38.5,27.5 69.5,27.5 69.5,47" fill="none" stroke="#F6F1E4" strokeWidth="7" strokeLinecap="round" />
        <path
          d="M25.6,45 H82.4 Q86.6,45 85.6,49.1 L78.7,75.4 Q77.7,79.4 73.6,79.4 H34.4 Q30.3,79.4 29.3,75.4 L22.4,49.1 Q21.4,45 25.6,45 Z"
          fill="#F6F1E4"
        />
        <path d="M24.6,52.6 H83.4" stroke="#E2DAC6" strokeWidth="2.2" />
        <path
          d="M35,58.5 L45.5,68 L54.5,61.2 L68,72.6 M58.6,73.2 H68.6 V63.2"
          fill="none"
          stroke="#156B42"
          strokeWidth="5.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

/**
 * Pull down from the top of a scrolling screen to refresh. Returns the props for the screen
 * element and the indicator to show above its content.
 */
export function usePullToRefresh(onRefresh: () => void, disabled = false, pullText = 'Pull to check prices', letGoText = 'Let go to check prices') {
  const [pull, setPull] = useState(0);
  // Less easy to set off by accident (0.8.8): it only counts once the finger has clearly gone
  // down, not sideways (swiping through cards), and has to go further before letting go does it.
  const start = useRef<{ x: number; y: number; dir?: 'down' | 'other' } | undefined>(undefined);
  const THRESHOLD = 100;
  const DEAD = 14;
  const props = {
    onTouchStart: (e: React.TouchEvent<HTMLDivElement>) => {
      const t = e.touches[0];
      start.current = !disabled && e.currentTarget.scrollTop <= 0 && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : undefined;
    },
    onTouchMove: (e: React.TouchEvent<HTMLDivElement>) => {
      const s0 = start.current;
      if (!s0) return;
      const t = e.touches[0];
      const dx = t.clientX - s0.x;
      const dy = t.clientY - s0.y;
      if (!s0.dir) {
        if (Math.abs(dx) < DEAD && Math.abs(dy) < DEAD) return;
        s0.dir = dy > 0 && dy > Math.abs(dx) * 2 ? 'down' : 'other';
      }
      if (s0.dir !== 'down') return;
      setPull(dy > DEAD ? Math.min(140, (dy - DEAD) * 0.5) : 0);
    },
    onTouchEnd: () => {
      if (pull >= THRESHOLD && start.current?.dir === 'down') onRefresh();
      start.current = undefined;
      setPull(0);
    },
    onTouchCancel: () => {
      start.current = undefined;
      setPull(0);
    },
  };
  const indicator =
    pull > 12 ? (
      <div className="pull" style={{ height: Math.min(pull, 110) }} aria-hidden>
        <Icon name="refresh" size={18} />
        <span>{pull >= THRESHOLD ? letGoText : pullText}</span>
      </div>
    ) : null;
  return { props, indicator };
}

/**
 * A row you can swipe: right for the positive action, left for delete. Taps still work as
 * normal. Vertical scrolling wins over sideways movement, so lists stay easy to scroll.
 */
export function SwipeRow({
  children,
  className,
  style,
  onLeft,
  onRight,
  leftLabel,
  rightLabel,
  disabled,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onLeft?: () => void;
  onRight?: () => void;
  leftLabel?: string;
  rightLabel?: string;
  disabled?: boolean;
}) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; dir?: 'h' | 'v' } | undefined>(undefined);
  const swiped = useRef(false);
  const TRIGGER = 90;
  const reset = () => {
    start.current = undefined;
    setDx(0);
  };
  return (
    <div className="swipe">
      {dx !== 0 && (
        <div className={`swipe-under ${dx > 0 ? 'right' : 'left'}${Math.abs(dx) >= TRIGGER ? ' armed' : ''}`} aria-hidden>
          <span>{dx > 0 ? rightLabel : leftLabel}</span>
        </div>
      )}
      <div
        className={className}
        style={{ ...style, transform: dx ? `translateX(${dx}px)` : undefined, transition: start.current ? 'none' : 'transform 0.18s' }}
        onTouchStart={(e) => {
          if (disabled) return;
          const t = e.touches[0];
          start.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchMove={(e) => {
          const s0 = start.current;
          if (!s0) return;
          const t = e.touches[0];
          const mx = t.clientX - s0.x;
          const my = t.clientY - s0.y;
          if (!s0.dir) {
            if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
            s0.dir = Math.abs(mx) > Math.abs(my) * 1.3 ? 'h' : 'v';
          }
          if (s0.dir !== 'h') return;
          if ((mx > 0 && !onRight) || (mx < 0 && !onLeft)) return;
          const next = Math.max(-140, Math.min(140, mx));
          if (Math.abs(next) >= TRIGGER && Math.abs(dx) < TRIGGER) buzzOnce();
          setDx(next);
        }}
        onTouchEnd={() => {
          const d = dx;
          swiped.current = Math.abs(d) > 8;
          reset();
          if (d >= TRIGGER) onRight?.();
          else if (d <= -TRIGGER) onLeft?.();
        }}
        onTouchCancel={reset}
        onClickCapture={(e) => {
          // A finished swipe shouldn't also count as a tap.
          if (swiped.current) {
            swiped.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
function buzzOnce() {
  try {
    navigator.vibrate?.(12);
  } catch {
    // no vibration
  }
}

export function unitLabel(o?: Option) {
  if (!o || o.unitPrice === undefined) return '';
  return formatUnitPrice(o.unitPrice, productQty(o.product).unit);
}

/** One side of a swap: which product, where, its price and its unit price. */
export function SwapBox({ label, option, hi }: { label: string; option?: Option; hi?: boolean }) {
  return (
    <div className={`stat${hi ? ' hi' : ''}`} style={{ gap: 2 }}>
      <span className="k" style={{ fontWeight: 700 }}>
        {label}
      </span>
      <span className="k two-lines">{option ? describe(option) : 'No price yet'}</span>
      {option && <span className="k">{chainName(option.product.chain)}</span>}
      <span className="v num">{money(option?.price)}</span>
      <span className="k num">{[unitLabel(option), eachText(option)].filter(Boolean).join(' · ')}</span>
    </div>
  );
}

// ---------- hold to preview ----------

/**
 * Press and hold (about half a second) to do something else, like showing a product bigger.
 * A normal tap still works, and moving your finger (scrolling) cancels it.
 */
export function useLongPress(onLong: () => void, ms = 450) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const fired = useRef(false);
  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    start.current = undefined;
  };
  return {
    onTouchStart: (e: React.TouchEvent) => {
      fired.current = false;
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        try {
          navigator.vibrate?.(20);
        } catch {
          // no vibration
        }
        onLong();
      }, ms);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = start.current;
      const t = e.touches[0];
      if (s && (Math.abs(t.clientX - s.x) > 10 || Math.abs(t.clientY - s.y) > 10)) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    // A fresh mouse press starts clean (after a right-click that never ended in a click).
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button === 0 && !timer.current) fired.current = false;
    },
    // Right-click or a desktop long press.
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      if (!fired.current) onLong();
      fired.current = true;
    },
    // The tap that ends a long press shouldn't also tick the box or open the page.
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        fired.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}

/** Everything the bigger product view can show. Works for search results and saved products. */
export interface PreviewProduct {
  chain: Chain;
  name: string;
  brand?: string;
  size?: string;
  imageUrl?: string;
  storeProductId?: string;
  barcode?: string;
  price?: number;
  wasPrice?: number;
  isSpecial?: boolean;
  memberOnly?: boolean;
  promo?: string;
  unitText?: string;
  inStock?: boolean;
  /** For a pantry item: which role this product plays. */
  role?: 'main' | 'alt';
}

export function previewFromOption(o: Option): PreviewProduct {
  const cur = o.stats.current;
  return {
    chain: o.product.chain,
    name: o.product.name,
    brand: o.product.brand,
    size: o.product.size,
    imageUrl: o.product.imageUrl,
    storeProductId: o.product.storeProductId,
    barcode: o.product.barcode,
    price: o.price,
    wasPrice: cur?.wasPrice,
    isSpecial: cur?.isSpecial,
    memberOnly: cur?.memberOnly,
    promo: cur?.promo,
    unitText: [unitLabel(o), eachText(o)].filter(Boolean).join(' · ') || undefined,
    inStock: o.product.inStock,
    role: o.role,
  };
}

/** The store's bigger version of a product photo, where its address says how. */
export function biggerImage(url: string): string {
  return url
    .replace('/wowproductimages/medium/', '/wowproductimages/large/')
    .replace('/wowproductimages/small/', '/wowproductimages/large/')
    .replace(/([/_=])300(?=[/_.&x]|$)/, '$1900');
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Where to see the product on the store's own website. */
export function storePageUrl(p: PreviewProduct): string | undefined {
  const q = encodeURIComponent([p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? p.brand : '', p.name].filter(Boolean).join(' '));
  if (p.chain === 'woolworths')
    return p.storeProductId
      ? `https://www.woolworths.com.au/shop/productdetails/${p.storeProductId}`
      : `https://www.woolworths.com.au/shop/search/products?searchTerm=${q}`;
  if (p.chain === 'coles') {
    // Coles product pages are /product/<brand-name-size>-<id>.
    if (p.storeProductId) {
      const words = [
        p.brand && !p.name.toLowerCase().startsWith(p.brand.toLowerCase()) ? p.brand : '',
        p.name,
        p.size && !nameHasSize(p.name, p.size) ? p.size : '',
      ];
      return `https://www.coles.com.au/product/${slug(words.filter(Boolean).join(' '))}-${p.storeProductId}`;
    }
    return `https://www.coles.com.au/search/products?q=${q}`;
  }
  if (p.chain === 'aldi') return `https://www.aldi.com.au/results?q=${q}`;
  return undefined;
}

/** A bigger look at one product: photo, full name, size, price and a link to the store's page. */
export function ProductPreview({ product: p, onClose, action }: { product: PreviewProduct; onClose: () => void; action?: ReactNode }) {
  const [src, setSrc] = useState(p.imageUrl ? biggerImage(p.imageUrl) : undefined);
  const page = storePageUrl(p);
  const brandInName = p.brand && p.name.toLowerCase().includes(p.brand.toLowerCase());
  return (
    <Sheet title={chainName(p.chain)} onClose={onClose}>
      <div className="preview-photo">
        {src ? (
          <img
            src={src}
            alt={p.name}
            referrerPolicy="no-referrer"
            // If the bigger photo isn't there, fall back to the one from the search.
            onError={() => setSrc(src !== p.imageUrl ? p.imageUrl : undefined)}
          />
        ) : (
          <span style={{ color: 'var(--muted)' }}>
            <Icon name="box" size={48} />
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {p.brand && !brandInName && <span className="eyebrow">{p.brand}</span>}
        <span className="title" style={{ fontSize: 17, lineHeight: 1.25 }}>
          {p.name}
        </span>
        <span className="small" style={{ fontSize: 15 }}>
          {[tidySize(p.size, p.name), tidyUnitText(p.unitText)].filter(Boolean).join(' · ')}
        </span>
      </div>
      {p.price !== undefined && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span className="num" style={{ fontSize: 26, fontWeight: 700 }}>
            {money(p.price)}
          </span>
          {p.wasPrice && p.wasPrice > p.price && (
            <span className="small num">
              was <span style={{ textDecoration: 'line-through' }}>{money(p.wasPrice)}</span>
            </span>
          )}
        </div>
      )}
      <div className="tags">
        {p.role && <span className={`tag ${p.role === 'alt' ? 'alt' : 'normal'}`}>{p.role === 'alt' ? 'WOULD ALSO TAKE' : 'MY PICK'}</span>}
        {/* A member-only special is still a special (0.9.0): both tags show. */}
        {p.isSpecial && <span className="tag good">SPECIAL</span>}
        {promoLabel(p.promo) && <span className="tag normal">{promoLabel(p.promo)}</span>}
        {p.memberOnly && <MemberTag chain={p.chain} />}
        {p.inStock === false && <span className="tag fake">OUT OF STOCK {stockWhere(p.chain).toUpperCase()}</span>}
      </div>
      {p.barcode && <span className="small num">Barcode {p.barcode}</span>}
      {action}
      <DetailsPanel product={p} />
      {page && (
        <a className="btn" href={page} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
          <Icon name="external" size={18} /> See it on the {chainName(p.chain)} website
        </a>
      )}
    </Sheet>
  );
}

/** Product details (ingredients, allergens, nutrition…), fetched when asked for. */
function DetailsPanel({ product: p }: { product: PreviewProduct }) {
  const [state, setState] = useState<'idle' | 'loading' | 'none' | ProductDetails>('idle');
  if (state === 'idle') {
    return (
      <button
        className="btn"
        onClick={async () => {
          setState('loading');
          const d = await fetchDetails(p).catch(() => undefined);
          setState(d ?? 'none');
        }}
      >
        <Icon name="info" size={18} /> Product details
      </button>
    );
  }
  if (state === 'loading') return <p className="small">Getting ingredients, allergens and nutrition…</p>;
  if (state === 'none') {
    return (
      <p className="small">No details found for this one. The store's website (below) has the full ingredients, allergens and nutrition panel.</p>
    );
  }
  const d = state;
  const block = (title: string, text?: string) =>
    text ? (
      <div className="detail-block">
        <div className="title" style={{ fontSize: 15 }}>
          {title}
        </div>
        <p>{text}</p>
      </div>
    ) : null;
  return (
    <div className="details">
      {block('About', d.description)}
      {block('Ingredients', d.ingredients)}
      {block('Allergens', d.allergens)}
      {d.nutrition && (
        <div className="detail-block">
          <div className="title" style={{ fontSize: 15 }}>
            Nutrition
          </div>
          {d.nutrition.note && <p className="small">{d.nutrition.note}</p>}
          <table className="nutrition">
            <thead>
              <tr>
                <th />
                {d.nutrition.header.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.nutrition.rows.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  {r.values.map((v, i) => (
                    <td key={i} className="num">
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.important.map((i) => block(i.label, i.text))}
      <p className="small">From {d.source}. Always check the pack, especially for allergies: recipes change.</p>
    </div>
  );
}

/** Wraps a row so pressing and holding it calls onLong (taps still go through). */
export function Hold({ onLong, children }: { onLong: () => void; children: ReactNode }) {
  const press = useLongPress(onLong);
  return (
    <div className="holdable" {...press}>
      {children}
    </div>
  );
}

/**
 * A bar that fills while something slow runs. It can't know the real progress, so it moves
 * quickly at first and slows near the end, reaching about 90% at the usual time. It disappears
 * with the thing it belongs to.
 */
export function LoadingBar({ seconds }: { seconds: number }) {
  const [p, setP] = useState(0.02);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => {
      const s = (Date.now() - start) / 1000;
      setP(Math.min(0.97, 1 - Math.exp((-2.3 * s) / seconds)));
    }, 200);
    return () => clearInterval(t);
  }, [seconds]);
  return (
    <div className="loading-bar" role="progressbar" aria-label="Loading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
      <span style={{ width: `${Math.round(p * 1000) / 10}%` }} />
    </div>
  );
}

/**
 * When a price was last checked: "checked today", "checked 3 days ago". Amber once it's 3 days or
 * more, so an old price (a shop that's been failing) isn't trusted by mistake.
 */
export function CheckedAgo({ date, source }: { date?: string; source?: string }) {
  if (!date) return null;
  const days = Math.floor((Date.now() - Date.parse(date)) / 86_400_000);
  const word = source === 'manual' ? 'added by hand' : 'checked';
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  const old = days >= 3;
  return (
    <span className={`checked-ago${old ? ' old' : ''}`} title={old ? 'This price may be out of date' : undefined}>
      {word} {when}
    </span>
  );
}
