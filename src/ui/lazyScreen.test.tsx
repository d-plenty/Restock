// @vitest-environment jsdom
// 0.15.2: a screen loaded quietly after start-up opens straight away, with no blank page while it loads.
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense, useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { lazyScreen, preloadScreens } from './lazyScreen';

afterEach(cleanup);

function Hello({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

describe('screens loaded when needed', () => {
  test('once loaded, a screen shows at once (no waiting page)', async () => {
    let loads = 0;
    const S = lazyScreen(async () => {
      loads++;
      return Hello;
    });
    await S.preload();
    render(
      <Suspense fallback={<p>waiting</p>}>
        <S name="Declan" />
      </Suspense>,
    );
    // On the very first render: no fallback at all.
    expect(screen.queryByText('waiting')).toBeNull();
    expect(screen.getByText('Hello Declan')).toBeTruthy();
    await S.preload();
    expect(loads).toBe(1);
  });

  test('one opened before it was loaded waits for its code, the first time only', async () => {
    const S = lazyScreen(async () => Hello);
    render(
      <Suspense fallback={<p>waiting</p>}>
        <S name="Sarah" />
      </Suspense>,
    );
    expect(screen.getByText('waiting')).toBeTruthy();
    expect(await screen.findByText('Hello Sarah')).toBeTruthy();
  });

  test("one that opened waiting keeps what's on it once loaded (it isn't started again)", async () => {
    let mounts = 0;
    function Counter() {
      const [n, setN] = useState(() => (mounts++, 0));
      return <button onClick={() => setN(n + 1)}>n={n}</button>;
    }
    const S = lazyScreen(async () => Counter);
    const { rerender } = render(
      <Suspense fallback={<p>waiting</p>}>
        <S />
      </Suspense>,
    );
    (await screen.findByText('n=0')).click();
    expect(await screen.findByText('n=1')).toBeTruthy();
    rerender(
      <Suspense fallback={<p>waiting</p>}>
        <S />
      </Suspense>,
    );
    expect(screen.getByText('n=1')).toBeTruthy();
    expect(mounts).toBe(1);
  });

  test('preloadScreens loads every screen, and a failed load is tried again later', async () => {
    let fail = true;
    const A = lazyScreen(async () => Hello);
    const B = lazyScreen(async () => {
      if (fail) throw new Error('offline');
      return Hello;
    });
    const none = lazyScreen(async () => Hello, { preload: false });
    await act(() => preloadScreens((fn) => fn()));
    fail = false;
    await B.preload();
    render(
      <Suspense fallback={<p>waiting</p>}>
        <A name="a" />
        <B name="b" />
      </Suspense>,
    );
    expect(screen.queryByText('waiting')).toBeNull();
    void none;
  });
});
