// 0.9.5 (final review): the words for the server's Auto delete (0.9.4's "Keep data for"), the same
// on the phone and the web. Auto delete is off (null) or any whole number of months from 1 to 120.

/** "1 month", "7 months". */
export const monthsWord = (m: number) => `${m} month${m === 1 ? '' : 's'}`;

/** The phone's server card: what the server keeps. `m` undefined: no server row yet (nothing set, so off). */
export function serverKeepText(m: number | null | undefined): string {
  return typeof m === 'number'
    ? `Auto delete on the server is on: prices and receipts older than ${monthsWord(m)} are deleted there every night.`
    : 'Auto delete on the server is off: it keeps everything until someone deletes it.';
}

/** Activity and logs on the web: how long they stay. `m` undefined: the settings haven't loaded yet. */
export function logsKeepText(m: number | null | undefined): string {
  if (m === undefined) return 'Auto delete (in Data) says how long they stay.';
  return m === null ? 'Auto delete is off, so they stay until someone deletes them.' : `Auto delete removes them after ${monthsWord(m)}.`;
}
