// 0.15.2: screens that load when first needed (so Restock starts quicker), without the blank page
// that showed while one loaded. Each is loaded quietly once Restock has started (preloadScreens), and
// once loaded it's shown straight away, with no moment of waiting at all. One opened before that
// still waits for its code, the first time only.
import { lazy, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';

export interface LazyScreen<P> {
  (props: P): ReactElement;
  /** Loads its code now (nothing happens if it's loaded already). */
  preload(): Promise<unknown>;
}

const all: LazyScreen<never>[] = [];

// Screens are function components; their props are what the screen is given.
type Fn = (props: never) => ReactNode;
type PropsOf<C extends Fn> = Parameters<C> extends [] ? Record<string, never> : NonNullable<Parameters<C>[0]> & object;

export function lazyScreen<C extends Fn>(load: () => Promise<C>, opts: { preload?: boolean } = {}): LazyScreen<PropsOf<C>> {
  type P = PropsOf<C>;
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;
  const get = () => {
    loading ??= load().then(
      (c) => (loaded = c as unknown as ComponentType<P>),
      (e: unknown) => {
        // Not loaded (no connection on the web, say): tried again next time.
        loading = undefined;
        throw e;
      },
    );
    return loading;
  };
  const Waiting = lazy(() => get().then((c) => ({ default: c })));
  const Screen = ((props: P) => {
    // What this one opened as, kept: a screen that opened waiting stays as it is once its code is
    // in, so nothing on it is lost (switching it to the loaded one would start it again).
    const [Ready] = useState(() => loaded);
    return Ready ? <Ready {...props} /> : <Waiting {...props} />;
  }) as LazyScreen<P>;
  Screen.preload = () => get().catch(() => undefined);
  if (opts.preload !== false) all.push(Screen as LazyScreen<never>);
  return Screen;
}

/** Loads every screen's code, one after another, when the phone isn't busy. */
export async function preloadScreens(idle: (fn: () => void) => void = whenIdle): Promise<void> {
  for (const s of all) {
    await new Promise<void>((r) => idle(r));
    await s.preload();
  }
}

const whenIdle = (fn: () => void) => {
  const ric = (
    globalThis as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (ric) ric(fn, { timeout: 2000 });
  else setTimeout(fn, 50);
};
