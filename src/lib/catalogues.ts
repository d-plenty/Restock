import { shopDef, websiteOf, type StoreChain } from '../shops';
import { isNative, request } from '../stores/http';
import { absolute } from '../stores/webPage';
import { getKV, putKV } from './db';

// Each shop's catalogue. The supermarkets' are known; for every other shop, Restock looks on
// its homepage for a catalogue link (or tries the usual addresses) and remembers what it finds
// for a week. If there's nothing, it says so.

export interface CatalogueLink {
  url?: string;
  note?: string;
  /** Why there's no link: the site has no catalogue Restock could find, or it couldn't be checked. */
  missing?: 'none' | 'unchecked';
}

const WEEK = 7 * 86_400_000;
const KV = (c: StoreChain) => `catalogue:${c}`;

/** Catalogue hosts shops commonly link out to. */
const CATALOGUE_HOSTS = /salefinder\.com\.au|issuu\.com|lasoo\.com\.au|catalogues?\.|publitas\.com|flipsnack\.com/i;
const WORDS = /\bcatalog(ue)?s?\b|weekly[\s-]?(specials|deals)|e-?mailer|specials[\s-]catalogue/i;

/** A catalogue link on a homepage: one whose address or words say catalogue, best first. */
export function catalogueLinkIn(html: string, base: string): string | undefined {
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  const found: { url: string; score: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const inHref = /catalog/i.test(href);
    const inText = WORDS.test(text);
    if (!inHref && !inText) continue;
    const url = absolute(href, base);
    if (!url) continue;
    const sameSite = new URL(url).host.replace(/^www\./, '') === new URL(base).host.replace(/^www\./, '');
    if (!sameSite && !CATALOGUE_HOSTS.test(url)) continue;
    found.push({ url, score: (inHref ? 2 : 0) + (inText ? 2 : 0) + (sameSite ? 1 : 0) - url.length / 1000 });
  }
  return found.sort((a, b) => b.score - a.score)[0]?.url;
}

/** Where this shop's catalogue is, if it has one. */
export async function findCatalogue(chain: StoreChain, fresh = false): Promise<CatalogueLink> {
  const known = shopDef(chain)?.catalogue;
  if (known) return { url: known.url, note: known.note };
  const cached = fresh ? undefined : await getKV<{ url?: string; at: string }>(KV(chain)).catch(() => undefined);
  if (cached && Date.now() - Date.parse(cached.at) < WEEK) return cached.url ? { url: cached.url } : { missing: 'none' };
  const site = websiteOf(chain);
  if (!site || !isNative()) return { missing: 'unchecked' };
  let url: string | undefined;
  try {
    const home = await request({ url: site, headers: { Accept: 'text/html' } });
    if (home.status < 400) url = catalogueLinkIn(home.text, site);
  } catch {
    // try the usual addresses below
  }
  if (!url) {
    for (const path of ['/catalogue', '/catalogues', '/catalog']) {
      try {
        const r = await request({ url: new URL(path, site).toString(), headers: { Accept: 'text/html' } });
        if (r.status === 200 && /catalog/i.test(r.text.slice(0, 200_000))) {
          url = new URL(path, site).toString();
          break;
        }
      } catch {
        // next
      }
    }
  }
  await putKV(KV(chain), { url, at: new Date().toISOString() }).catch(() => undefined);
  return url ? { url } : { missing: 'none' };
}
