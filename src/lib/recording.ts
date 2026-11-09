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
/**
 * 0.9.0: a field is personal if its name has any of these in it, whatever the case ("firstName",
 * "ShopperEmail", "loyaltyCardNumber", "x-csrf-token"…). Some product fields go too (a product's
 * "DisplayName"); the field names stay, so what the shop's page sends can still be seen.
 */
const PERSONAL =
  /name|e-?mail|phone|mobile|address|street|suburb|postcode|postal|zip|shopper|customer|member|loyalty|flybuys|rewards|card|cvv|token|password|passcode|secret|session|cookie|auth|dob|birth|user|login/i;

/** Things that look personal in plain text: emails, phone numbers, card-length numbers and street addresses. */
const EMAIL = /[^\s"'<>(),;:/?&=#]+@[^\s"'<>(),;:/?&=#]+\.[a-z]{2,}/gi;
const PHONE = /(?<!\d)(?:\+?61[\s-]?|\(?0)[2-478]\)?(?:[\s-]?\d){8}\b|\b1[38]00(?:[\s-]?\d){6}\b/g;
const LONG_NUMBER = /\b\d(?:[\s-]?\d){11,18}\b/g;
const STREET =
  /\b\d{1,5}[a-z]?(?:[-/]\d{1,5}[a-z]?)?\s+(?:[a-z]+\s+){0,3}(?:st|street|rd|road|ave|avenue|dr|drive|ct|court|pl|place|cres|crescent|bvd|blvd|boulevard|hwy|highway|lane|ln|way|tce|terrace|pde|parade|cct|circuit|cl|close|gr|grove|esp|esplanade)\b\.?/gi;

/** Blanks anything that looks personal in a piece of text. */
export function scrubText(text: string): string {
  return text
    .replace(EMAIL, '(removed)')
    .replace(STREET, '(removed)')
    .replace(LONG_NUMBER, '(removed)')
    .replace(PHONE, '(removed)');
}

/** "key=value&…" with a personal key, as in a form's body. */
const FORM_FIELD = /([?&]|^)([^=&\s]+)=([^&\s]*)/g;

/**
 * Blanks personal fields in a JSON text. 0.9.0: text that isn't JSON (a form, a web page) is no
 * longer kept as it is: personal-looking form fields, emails, phone numbers, card-length numbers
 * and street addresses are blanked, and it's cut to 2000 characters.
 */
export function scrub(text: string): string {
  const t = text.trim();
  const plain = () =>
    scrubText(t.slice(0, 2000).replace(FORM_FIELD, (all, lead: string, key: string) => (PERSONAL.test(key) ? `${lead}${key}=(removed)` : all)));
  if (!t.startsWith('{') && !t.startsWith('[')) return plain();
  try {
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.slice(0, 20).map(walk);
      if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, PERSONAL.test(k) ? '(removed)' : walk(x)]));
      if (typeof v === 'string') return /@.+\./.test(v) ? '(removed)' : scrubText(v);
      if (typeof v === 'number' && Math.abs(v) >= 1e11) return '(removed)';
      return v;
    };
    return JSON.stringify(walk(JSON.parse(t)));
  } catch {
    return plain();
  }
}

/**
 * 0.9.0: a web address with the values in its query string blanked ("/search?q=(removed)"). The
 * path stays, so it's clear which of the shop's addresses was asked; anything personal-looking in
 * the path is blanked too. The part after "#" goes.
 */
export function scrubUrl(url: string): string {
  const [beforeHash] = url.split('#');
  const q = beforeHash.indexOf('?');
  const path = scrubText(q < 0 ? beforeHash : beforeHash.slice(0, q));
  if (q < 0) return path;
  const names = beforeHash
    .slice(q + 1)
    .split('&')
    .filter(Boolean)
    .map((pair) => `${pair.split('=')[0]}=(removed)`);
  return names.length ? `${path}?${names.join('&')}` : path;
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
    .map((c) => ({
      ...c,
      url: scrubUrl(c.url),
      page: typeof c.page === 'string' ? scrubUrl(c.page) : undefined,
      body: scrub(typeof c.body === 'string' ? c.body : ''),
      response: scrub(typeof c.response === 'string' ? c.response : ''),
    }));
}
