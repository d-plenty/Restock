import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * 0.15.1: a ref that always holds the latest `value` (a callback, a flag), for handlers and effects
 * that live longer than one draw. It's updated once the screen has drawn, not while it draws.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
