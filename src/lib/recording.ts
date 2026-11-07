// Tidying a recording of what a shop's website asked its servers while you added something to your
// trolley (see StoreWeb.RECORDER), before you share it. Only the shop's own API calls are kept;
// sign-in and account calls are dropped, and anything personal in what's left is blanked.

export interface RecordedCall {
  kind: string;
  method: string;
  url: string;
  status: number;
  body: string;
  response: string;
  page?: string;
  at?: number;
}

const SKIP =
  /login|logout|signin|sign-in|auth|token|password|identity|oauth|session|account|profile|payment|checkout\/pay|analytics|tracking|telemetry|collect|beacon|gtm|doubleclick|google|facebook|adobe|newrelic|datadog|sentry|optimizely|segment/i;
const PERSONAL =
  /^(e-?mail|emailaddress|phone|mobile|firstname|lastname|fullname|name|dob|dateofbirth|birthday|address(line)?\d?|street|suburb|postcode|card(number)?|cvv|password|token|accesstoken|refreshtoken|customerid|memberid|loyalty(number|card)?|flybuys(number)?|rewardscard(number)?)$/i;

/** Blanks personal fields in a JSON text (anything that isn't JSON is left alone, trimmed). */
export function scrub(text: string): string {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return t.slice(0, 2000);
  try {
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.slice(0, 20).map(walk);
      if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, PERSONAL.test(k) ? '(removed)' : walk(x)]));
      if (typeof v === 'string' && /@.+\./.test(v)) return '(removed)';
      return v;
    };
    return JSON.stringify(walk(JSON.parse(t)));
  } catch {
    return t.slice(0, 2000);
  }
}

/** The recording from the app, as kept: the shop's own API calls, scrubbed. */
export function tidyRecording(raw: string | undefined, site: string): RecordedCall[] {
  if (!raw) return [];
  let data: unknown = raw;
  try {
    // The page hands back a JSON string of a JSON string.
    while (typeof data === 'string') data = JSON.parse(data);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const host = new URL(site).host;
  return (data as RecordedCall[])
    .filter((c) => c && typeof c.url === 'string')
    .filter((c) => {
      let u: URL;
      try {
        u = new URL(c.url, site);
      } catch {
        return false;
      }
      return u.host === host && /\/api|\/apis/i.test(u.pathname) && !SKIP.test(u.pathname);
    })
    .map((c) => ({ ...c, body: scrub(c.body ?? ''), response: scrub(c.response ?? '') }));
}
