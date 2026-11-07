import { chainName, sectionOf, SHOPS, type StoreChain } from '../shops';
import { isNative } from '../stores/http';
import { render } from '../stores/web';
import { cleanName, extractProducts } from '../stores/webPage';
import { addListEntry, nowIso, uid } from './db';

// "Restock: Add to shopping list" in Android's share menu. A shared product page becomes a
// one-off shopping list line (nothing is tracked): its name, the shop, and the price if the page
// shows one.

/** Which of Restock's shops a link is on. */
export function shopForUrl(url: string): StoreChain | undefined {
  let host: string;
  try {
    host = new URL(url).host.replace(/^www\./, '');
  } catch {
    return undefined;
  }
  const hit = SHOPS.find((s) => {
    try {
      return new URL(s.website).host.replace(/^www\./, '') === host;
    } catch {
      return false;
    }
  });
  return hit?.id as StoreChain | undefined;
}

/** A readable name from a shared link's words, like ".../milo-chocolate-malt-460g-12345" → "Milo Chocolate Malt 460g". */
export function nameFromLink(url: string): string | undefined {
  try {
    const seg = new URL(url).pathname.split('/').filter((x) => /[a-z]/i.test(x) && x.includes('-'));
    const words = (seg.sort((a, b) => b.length - a.length)[0] ?? '').split('-').filter((w) => w && !/^\d{4,}$/.test(w));
    if (words.length < 2) return undefined;
    return words.map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
  } catch {
    return undefined;
  }
}

/** Shared text, usually "Product name https://shop/…", split into its link and the words around it. */
export function splitShared(text: string): { url?: string; words: string } {
  const url = text.match(/https?:\/\/\S+/)?.[0];
  const words = (url ? text.replace(url, ' ') : text)
    .replace(/\b(check (this|it) out|i found this|on (woolworths|coles|aldi)|shared from[^\n]*)\b/gi, ' ')
    .replace(/[|•\-–—:]+\s*(woolworths|coles|aldi|bws|dan murphy'?s|chemist warehouse)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { url, words };
}

/** Add a shared link or text to the shopping list. Returns what to tell the person. */
export async function addShared(text: string): Promise<string> {
  const { url, words } = splitShared(text);
  const chain = url ? shopForUrl(url) : undefined;
  let name = words || (url ? nameFromLink(url) : undefined);
  let price: number | undefined;
  if (url && chain && isNative()) {
    try {
      const page = await render(chain, url);
      const found = extractProducts(chain, page.html, page.url);
      const p = found.find((x) => x.price !== undefined) ?? found[0];
      if (p) {
        name = p.name;
        price = p.price;
      }
    } catch {
      // keep the name from the shared text
    }
  }
  if (!name) return "Couldn't tell what that was. Try sharing the product's page.";
  name = cleanName(name);
  await addListEntry({ id: uid(), text: name, chain, price, section: chain ? sectionOf(chain) : 'pantry', checked: false, createdAt: nowIso() });
  return `${name}${chain ? ` (${chainName(chain)})` : ''} added to your shopping list`;
}
