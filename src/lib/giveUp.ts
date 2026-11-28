/**
 * 0.19.0: a signal that ends a request after `ms`, so nothing outside Restock can keep a screen
 * waiting for ever (a shop or GitHub that takes the connection and then says nothing).
 * `fetch(url, { signal: giveUpAfter(15_000) })` then fails like any other request that didn't get through.
 */
export function giveUpAfter(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(new DOMException('No answer in time', 'TimeoutError')), ms);
  return c.signal;
}
