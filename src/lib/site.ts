// 0.9.0: is a web address safe to use for a shop? Restock only talks to shops over https, and a
// shop's search page has to be on the shop's own site (the same registrable domain as its
// website, so search.example.com.au is fine for www.example.com.au, but another-site.com isn't).
// Used for shops people add, shops that come from a backup or a household, and search pages
// Restock finds on a shop's homepage.

/** Endings where the site's name is the part before them ("example" in example.com.au). */
const TWO_PART_ENDINGS = new Set([
  'com.au',
  'net.au',
  'org.au',
  'asn.au',
  'id.au',
  'edu.au',
  'gov.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.sg',
  'com.hk',
  'co.jp',
]);

/** The registrable domain of a host: "shop.example.com.au" → "example.com.au". */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  // An IP address or a single name is its own site.
  if (/^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  return TWO_PART_ENDINGS.has(parts.slice(-2).join('.')) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

/**
 * The address as https, or undefined if it isn't a proper web address with a domain name. A
 * plain http address is moved to https (Restock never uses http for a shop).
 */
export function asHttps(url: string | undefined): URL | undefined {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  try {
    const u = new URL(url.trim());
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) return undefined;
    return u;
  } catch {
    return undefined;
  }
}

/** Is `url` a web address (used as https) on the same site as `website`? */
export function sameSite(url: string | undefined, website: string | undefined): boolean {
  const a = asHttps(url);
  const b = asHttps(website);
  return !!a && !!b && siteOf(a.hostname) === siteOf(b.hostname);
}

/**
 * A search page address for a shop: https, on the shop's own site, with {q} where the words go.
 * Returns it (moved to https if it was http) or undefined. The text is kept as written apart from
 * that, so "{q}" stays readable.
 */
export function searchOnSite(search: string | undefined, website: string | undefined): string | undefined {
  if (typeof search !== 'string') return undefined;
  const t = search.trim();
  if (!t.includes('{q}') || !sameSite(t, website)) return undefined;
  return t.replace(/^http:\/\//i, 'https://');
}
