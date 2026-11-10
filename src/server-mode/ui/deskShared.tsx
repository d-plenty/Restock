// 0.9.3: small pieces the desktop pages share.
// 0.9.5: product photos (only from the shops' picture hosts the server's CSP allows), the item's big
// photo, and Previous / Next for catalogue pages.
import { useState, type ReactNode } from 'react';
import type { Group } from '../../types';
import type { Nav } from '../../ui/nav';
import { Icon } from '../../ui/components';

/**
 * The shops' picture hosts: the same list as IMAGE_HOSTS in server/src/server.mjs (the page's CSP
 * img-src; a test keeps the two the same). A picture from anywhere else would be blocked, so it
 * shows the placeholder straight away instead of a failed load.
 */
export const IMAGE_HOSTS = [
  '*.woolworths.media',
  'productimages.coles.com.au',
  'dm.apac.cms.aldi.cx',
  'media.danmurphys.com.au',
  'edgmedia.bws.com.au',
  'static.chemistwarehouse.com.au',
  'cdn.shopify.com',
  'images.openfoodfacts.org',
];

const hostAllowed = (host: string) =>
  IMAGE_HOSTS.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h));

/** A shop's product picture the page may show: https, from a shop's picture host. Else undefined. */
export function photoUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.length > 2000) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && hostAllowed(u.hostname.toLowerCase()) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The first photo among a few products (the deal, your pick, then any other). */
export function firstPhoto(...products: ({ imageUrl?: string } | undefined)[]): string | undefined {
  for (const p of products) {
    const u = photoUrl(p?.imageUrl);
    if (u) return u;
  }
  return undefined;
}

/** A Woolworths medium or small picture, asked for large (a big photo shouldn't be blurry). */
const larger = (url: string) => url.replace('/wowproductimages/medium/', '/wowproductimages/large/').replace('/wowproductimages/small/', '/wowproductimages/large/');

/** The letter the placeholder shows: the name's first letter or digit ("?" if it has none). */
export function photoLetter(name: string): string {
  const m = name.match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : '?';
}

/**
 * An item's big photo, at the top of the item panel and page. The box keeps its size whether the
 * photo is loading, loaded or missing (no jump); with no photo, or one that won't load, it shows the
 * item's first letter instead of a broken image.
 */
export function ItemPhoto({ src, name, size = 'big' }: { src?: string; name: string; size?: 'big' | 'sheet' }) {
  const ok = photoUrl(src);
  const big = ok ? larger(ok) : undefined;
  // The large one first; if it isn't there, the one the shop gave; then the letter.
  const [failed, setFailed] = useState<string[]>([]);
  const shown = [big, ok].find((u) => u && !failed.includes(u));
  return (
    <div className={`dk-photo ${size}${shown ? '' : ' none'}`}>
      {shown ? (
        <img
          key={shown}
          src={shown}
          alt={name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed((f) => [...f, shown])}
        />
      ) : (
        <span className="dk-photo-letter" role="img" aria-label={`${name}, no photo`}>
          <span aria-hidden>{photoLetter(name)}</span>
        </span>
      )}
    </div>
  );
}

/** A page number moved by one, kept within 0 … count − 1. */
export function stepPage(page: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(page) + delta));
}

/** The page a key goes to (← → Home End), or undefined if the key isn't one of them. */
export function pageForKey(key: string, page: number, count: number): number | undefined {
  if (key === 'ArrowLeft') return stepPage(page, -1, count);
  if (key === 'ArrowRight') return stepPage(page, 1, count);
  if (key === 'Home') return 0;
  if (key === 'End') return Math.max(0, count - 1);
  return undefined;
}

/** Previous / "Page 3 of 7" / Next, above and below a catalogue's pages. */
export function PageArrows({ page, count, name, onGo, where }: { page: number; count: number; name?: string; onGo: (page: number) => void; where: 'top' | 'bottom' }) {
  if (count < 2) return null;
  const at = stepPage(page, 0, count);
  return (
    <div className={`dk-pager ${where}`} role="group" aria-label={where === 'top' ? 'Pages' : 'Pages (bottom)'}>
      <button type="button" className="btn dk-pager-btn" disabled={at === 0} onClick={() => onGo(stepPage(at, -1, count))}>
        <Icon name="back" size={20} /> Previous
      </button>
      <span className="dk-pager-at num" aria-live={where === 'top' ? 'polite' : undefined}>
        Page {at + 1} of {count}
        {name ? <span className="dk-pager-name"> · {name}</span> : null}
      </span>
      <button type="button" className="btn dk-pager-btn" disabled={at === count - 1} onClick={() => onGo(stepPage(at, 1, count))}>
        Next <Icon name="chevron" size={20} />
      </button>
    </div>
  );
}

let pendingItem: string | undefined;

/** Opens an item in its tab's table, with its side panel open (from Home, say). */
export function openItem(nav: Nav, group: Pick<Group, 'id' | 'section'>): void {
  pendingItem = group.id;
  nav.setTab(group.section ?? 'pantry');
}

/** The item a page was asked to open, once. */
export function takeOpenItem(): string | undefined {
  const id = pendingItem;
  pendingItem = undefined;
  return id;
}

let start: 'add-phone' | undefined;
/** 0.9.4: where the app opens next (after Set up this server: Server and phones, Add a phone showing). */
export const startOn = (what: 'add-phone') => (start = what);
export const peekStartOn = () => start;
export function takeStartOn(): 'add-phone' | undefined {
  const s = start;
  start = undefined;
  return s;
}

/** Where a greyed setting is changed: "Change this on the owner phone". */
export function WhereNote({ children }: { children: ReactNode }) {
  return (
    <span className="dk-where">
      <span className="sr-only">Can't change it here. </span>
      {children}
    </span>
  );
}

/** A page's heading row. */
export function DeskHead({ title, sub, above, children }: { title: string; sub?: ReactNode; above?: ReactNode; children?: ReactNode }) {
  // 0.9.5 (look): `above` is a small line over the title, as on the phone's Home (the date).
  const h1 = title ? (
    <h1>
      {title}
      {sub !== undefined && <span className="dk-head-sub"> {sub}</span>}
    </h1>
  ) : null;
  return (
    <div className="dk-head">
      {above !== undefined && h1 ? (
        <div className="dk-head-title">
          <span className="dk-date">{above}</span>
          {h1}
        </div>
      ) : (
        h1
      )}
      {children}
    </div>
  );
}

export { greeting } from '../../lib/greeting';
