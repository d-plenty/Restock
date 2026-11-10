// 0.9.3: small pieces the desktop pages share.
import type { ReactNode } from 'react';
import type { Group } from '../../types';
import type { Nav } from '../../ui/nav';

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
export function DeskHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="dk-head">
      {title ? (
        <h1>
          {title}
          {sub !== undefined && <span className="dk-head-sub"> {sub}</span>}
        </h1>
      ) : null}
      {children}
    </div>
  );
}

export const greeting = (d = new Date()) => (d.getHours() < 12 ? 'Good morning' : d.getHours() < 17 ? 'Good afternoon' : 'Good evening');
