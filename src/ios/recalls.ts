// Recall alerts on iPhone and iPad: the same check Android runs (Recalls.java reads and matches the
// official lists; RecallChecker.java fetches them and saves what it found), in TypeScript. Nothing
// about you is sent anywhere: the lists are downloaded and the matching happens on the device.
// Android checks once a day in the background; here it's checked when Restock is opened, at most
// once a day, and from "Check now".

export interface Recall {
  id: string;
  source: string;
  title: string;
  url: string;
  date?: string;
  reason?: string;
  dates?: string;
  whatToDo?: string;
}
/** Something you have: an item, one of its products, a list line, or a receipt line. */
export interface Thing {
  kind: string;
  name: string;
  brand?: string;
}

export const FSANZ = 'https://www.foodstandards.gov.au/food-recalls/alerts';
export const ACCC = 'https://www.productsafety.gov.au/rss/recalls.xml';
export const TGA = 'https://www.tga.gov.au/feeds/alert/safety-alerts.xml';
const KEEP_DAYS = 120;

const recall = (source: string, title: string, url: string, date?: string): Recall => ({ id: `${source}:${url}`, source, title, url, date: date || undefined });

// ---------- text ----------

export function text(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&amp;', '&').replaceAll('&#039;', "'").replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&rsquo;', '’')
    .replaceAll('&lsquo;', '‘').replaceAll('&nbsp;', ' ').replaceAll('&ndash;', '–').replaceAll('&mdash;', '—').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function first(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const dot = cut.lastIndexOf('. ');
  return dot > max / 2 ? cut.slice(0, dot + 1) : cut.replace(/\s+\S*$/, '') + '…';
}

function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  if (!m) return '';
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(m[1]);
  return cdata ? cdata[1] : m[1];
}

// ---------- reading the lists ----------

const DATE = /\b(\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4})\b/;

/** The FSANZ recall alerts page: each alert's title, link and date. */
export function parseFsanzList(html: string): Recall[] {
  const out = new Map<string, Recall>();
  const link = /<a[^>]+href="(\/food-recalls\/recall-alert\/[^"#?]+)"[^>]*>\s*([^<]{6,300}?)\s*<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = link.exec(html))) {
    const path = m[1];
    const title = text(m[2]);
    if (title.length < 6 || out.has(path)) continue;
    // The date follows the title in the listing.
    const end = m.index + m[0].length;
    const d = DATE.exec(html.slice(end, end + 600));
    out.set(path, recall('FSANZ', title, `https://www.foodstandards.gov.au${path}`, d?.[1]));
  }
  return [...out.values()];
}

/** An RSS feed (Product Safety Australia, TGA): title, link, date and description of each item. */
export function parseRss(xml: string, source: string): Recall[] {
  const out: Recall[] = [];
  const item = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = item.exec(xml))) {
    const title = text(tag(m[1], 'title'));
    const link = text(tag(m[1], 'link'));
    if (!title || !link) continue;
    const r = recall(source, title, link, text(tag(m[1], 'pubDate')));
    // The link the app opens is only kept if it's on an official recall site (the id stays as it was).
    r.url = safeLink(link, source);
    const desc = text(tag(m[1], 'description'));
    if (desc) r.reason = first(desc, 280);
    out.push(r);
  }
  return out;
}

const OFFICIAL = ['foodstandards.gov.au', 'productsafety.gov.au', 'tga.gov.au'];

/** The list a source's notices come from, opened instead of a notice's link that can't be used. */
export function listPage(source: string): string {
  if (source === 'FSANZ') return 'https://www.foodstandards.gov.au/food-recalls/alerts';
  if (source === 'TGA') return 'https://www.tga.gov.au/safety/safety-alerts';
  return 'https://www.productsafety.gov.au/recalls';
}

/** `link` if it's an https address on an official recall site, otherwise the source's list page. */
export function safeLink(link: string | undefined, source: string): string {
  if (link && !link.includes('\\')) {
    try {
      const u = new URL(link.trim());
      const host = u.hostname.toLowerCase();
      if (u.protocol === 'https:' && !u.username && !u.password && OFFICIAL.some((h) => host === h || host.endsWith(`.${h}`))) return u.toString();
    } catch {
      // not an address: the list instead
    }
  }
  return listPage(source);
}

function after(t: string, heading: string, max: number, fallback: string | undefined): string | undefined {
  const m = new RegExp(
    `${heading}\\s+(.{10,${max}}?)(?=\\s+(?:Problem|Food safety hazard|Date markings?|What to do|Country of origin|Where the product|Packaging description|Product information|For further information|Recalling company)\\b|$)`,
    'i',
  ).exec(t);
  return m ? first(m[1].trim(), max) : fallback;
}

/** From an FSANZ recall page: the problem, the date markings and what to do. */
export function readFsanzPage(r: Recall, html: string): void {
  const t = text(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' '));
  r.reason = after(t, '(?:Problem|Food safety hazard|Reason for recall)\\s*:?', 260, r.reason);
  r.dates = after(t, '(?:Date markings?|Best before|Use by)\\s*:?', 200, r.dates);
  r.whatToDo = after(t, 'What (?:to do|should consumers do)\\s*:?', 260, r.whatToDo);
}

// ---------- matching ----------

/** Words that don't tell products apart (and company words in recall titles). */
const STOP = new Set(
  ('the and with for from pack packs each original classic fresh range variety assorted flavour flavours flavor new pty ltd limited stores store group foods food company australia australian ' +
    'trading international products product brand brands recall recalls various selected multiple including also sold packet bottle bottles can cans jar bag box tub pouch tray').split(' '),
);

export function tokens(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replaceAll('’', "'")
    .replace(/'s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+[a-z]{0,2}$/.test(w));
}

/**
 * Does a recall look like it's about this thing? Needs the brand in the recall's title and at
 * least one product word as well, or most of the thing's name.
 */
export function matches(r: Recall, t: Thing): boolean {
  const title = new Set(tokens(r.title));
  const name = tokens(t.name);
  if (!name.length) return false;
  const brand = t.brand && t.brand.trim() ? tokens(t.brand) : name.slice(0, 1);
  const brandHit = brand.length > 0 && brand.every((w) => title.has(w));
  const shared = name.filter((w) => title.has(w) && !brand.includes(w)).length;
  if (brandHit && shared >= 1) return true;
  // Without a clear brand, most of the name has to be there.
  const all = name.filter((w) => title.has(w)).length;
  return name.length >= 3 && all >= Math.ceil(name.length * 0.75);
}

/** The names of your things a recall might affect (each at most once). */
export function affected(r: Recall, things: Thing[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of things) {
    const key = t.name.toLowerCase();
    if (!seen.has(key) && matches(r, t)) {
      seen.add(key);
      out.push(t.name);
    }
  }
  return out;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "3 November 2026", an RSS date, or an ISO time. */
export function parseDate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = s.trim();
  const long = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(t);
  if (long) {
    const month = MONTHS.indexOf(long[2].toLowerCase());
    return month < 0 ? undefined : new Date(Number(long[3]), month, Number(long[1])).getTime();
  }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : undefined;
}

export const tooOld = (date: string | undefined, now = Date.now()): boolean => {
  const d = parseDate(date);
  return d !== undefined && now - d > KEEP_DAYS * 86_400_000;
};

/** Receipt lines worth matching: prices taken out, and long enough to be a product. */
export function receiptLines(textOf: string): string[] {
  return textOf
    .split('\n')
    .map((l) => l.replace(/\$?\d+\.\d{2}/g, ' ').trim())
    .filter((l) => l.length >= 8);
}

// ---------- the check ----------

export interface SavedRecall extends Recall {
  affected: string[];
  foundAt: string;
}

export interface RecallStore {
  /** What was found before, and which were dismissed or already notified. */
  load(): Promise<{ saved: SavedRecall[]; dismissed: string[]; notified: string[] }>;
  save(found: SavedRecall[], notified: string[], checkedAt: string): Promise<void>;
  things(): Promise<Thing[]>;
}

export interface RecallResult {
  checked: number;
  found: number;
  fresh: number;
  errors: Record<string, string>;
  /** The new ones, for notifications. */
  news: SavedRecall[];
}

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One check, as RecallChecker.run does it. `get` fetches a page as text and throws on an error status. */
export async function runRecallCheck(get: (url: string) => Promise<string>, store: RecallStore, now = Date.now()): Promise<RecallResult> {
  const result: RecallResult = { checked: 0, found: 0, fresh: 0, errors: {}, news: [] };
  // 1. The lists.
  const all: Recall[] = [];
  try {
    all.push(...parseFsanzList(await get(FSANZ)));
  } catch (e) {
    result.errors.FSANZ = said(e);
  }
  try {
    all.push(...parseRss(await get(ACCC), 'Product Safety Australia'));
  } catch (e) {
    result.errors['Product Safety Australia'] = said(e);
  }
  try {
    all.push(...parseRss(await get(TGA), 'TGA'));
  } catch {
    // The TGA feed is a bonus: medicines recalls are mostly in their own database (linked in the app).
  }
  result.checked = all.length;

  // 2. What you have.
  const things = await store.things();

  // 3. Matches, skipping very old notices.
  const before = await store.load();
  const byId = new Map<string, SavedRecall>();
  for (const o of before.saved) {
    if (!o || tooOld(o.foundAt, now)) continue;
    byId.set(o.id, o.url ? { ...o, url: safeLink(o.url, o.source) } : o);
  }
  const dismissed = new Set(before.dismissed);
  const notified = new Set(before.notified);
  for (const r of all) {
    if (r.date && tooOld(r.date, now)) continue;
    const hit = affected(r, things);
    if (!hit.length) continue;
    result.found++;
    if (r.source === 'FSANZ' && !r.reason) {
      try {
        readFsanzPage(r, await get(r.url));
      } catch {
        // the link still works
      }
    }
    const o: SavedRecall = { ...(byId.get(r.id) ?? { foundAt: new Date(now).toISOString() }), ...r, affected: hit } as SavedRecall;
    byId.set(r.id, o);
    if (!dismissed.has(r.id) && !notified.has(r.id)) result.news.push(o);
  }
  result.fresh = result.news.length;
  await store.save([...byId.values()], [...before.notified, ...result.news.map((o) => o.id)], new Date(now).toISOString());
  return result;
}

/** The notification for a new one, worded as Android's is. */
export function recallNotice(o: SavedRecall): { title: string; body: string } {
  const yours = o.affected[0] ?? '';
  return { title: `Possible recall: ${o.title}`, body: `${o.reason ? `${o.reason} ` : ''}${yours ? `Might be your ${yours}. ` : ''}Tap for the official notice.` };
}

/** Checked when Restock is opened, at most this often. */
const RECALL_EVERY_MS = 20 * 3_600_000;
export const recallCheckDue = (lastCheck: string | undefined, now = Date.now()): boolean => {
  const t = Date.parse(lastCheck ?? '');
  return !Number.isFinite(t) || now - t >= RECALL_EVERY_MS || t > now;
};
