// 0.15.1: behaviour tests for screens. A screen is drawn in a pretend browser (jsdom) on a real
// database (sql.js, in memory, with the demo pantry), inside a Nav that records where it was sent,
// and the test types, taps and reads what's on the screen, as a person would.
import initSqlJs from 'sql.js';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach } from 'vitest';
import { ensureDefaults, initDb } from '../lib/db';
import { loadDemo } from '../lib/demo';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { NavContext, type Nav, type Screen, type Tab } from '../ui/nav';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => cleanup());
// jsdom has no drawing: screens that measure text with a canvas get none, as on a browser without it.
if (typeof HTMLCanvasElement !== 'undefined') HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];

/** A fresh database: the defaults, and the demo pantry unless `empty`. */
export async function freshData({ empty = false } = {}): Promise<void> {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  await initDb(driver);
  await ensureDefaults();
  if (!empty) await loadDemo();
}

interface Shown {
  /** Where the screen sent you (nav.push), in order. */
  pushed: Screen[];
  popped: number;
  toasts: string[];
  tabs: Tab[];
}

/** Draws `el` inside a recording Nav, and waits for what it loads. */
export async function show(el: ReactElement, tab: Tab = 'pantry'): Promise<Shown> {
  const seen: Shown = { pushed: [], popped: 0, toasts: [], tabs: [] };
  const nav: Nav = {
    tab,
    section: 'pantry',
    setTab: (t) => void seen.tabs.push(t),
    push: (s) => void seen.pushed.push(s),
    pop: () => void seen.popped++,
    toast: (m) => void seen.toasts.push(m),
  };
  await act(async () => {
    render(<NavContext.Provider value={nav}>{el}</NavContext.Provider>);
  });
  return seen;
}

/** Types into the box with this label. */
export async function type(label: string | RegExp, text: string): Promise<void> {
  const box = await screen.findByLabelText(label);
  await act(async () => {
    fireEvent.change(box, { target: { value: text } });
  });
}

/** Taps the button with this name. */
export async function tap(name: string | RegExp): Promise<void> {
  const b = await screen.findByRole('button', { name });
  await act(async () => {
    fireEvent.click(b);
  });
}

export { cleanup, screen, waitFor };
