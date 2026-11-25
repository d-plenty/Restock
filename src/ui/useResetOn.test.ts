import { createElement, useState } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';
import { depsChanged, useResetOn } from './useResetOn';

function Box({ id, first }: { id: string; first?: boolean }) {
  const [n, setN] = useState(5);
  useResetOn([id], () => setN(0), first);
  return createElement('span', null, String(n));
}

test('the first draw keeps the starting state, unless asked to reset then too', () => {
  expect(renderToString(createElement(Box, { id: 'a' }))).toBe('<span>5</span>');
  expect(renderToString(createElement(Box, { id: 'a', first: true }))).toBe('<span>0</span>');
});

test('a change is any dep that differs (as React compares them), or a different number of them', () => {
  const o = {};
  expect(depsChanged([1, o], [1, o])).toBe(false);
  expect(depsChanged([1, o], [1, {}])).toBe(true);
  expect(depsChanged([NaN], [NaN])).toBe(false);
  expect(depsChanged([1], [1, 2])).toBe(true);
});
