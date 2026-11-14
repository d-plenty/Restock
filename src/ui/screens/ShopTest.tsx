// 0.10.3: Advanced → Diagnostics → Shop test. Pick any shop Restock knows (picked or not), search
// one word, and see what came back and how it was read, or why it didn't work, with a report to
// copy and send to the developer. The report has the shop, the words, how it was read and the
// first results: nothing from your pantry, lists, settings or branches.
import { useState } from 'react';
import { shareTextFile } from '../../lib/backup';
import { captureWhile, type Captured } from '../../lib/diagnostics';
import { isBlockedError, offerUnblock, TEST_WORD } from '../../lib/health';
import { nameHasSize } from '../../lib/naming';
import { money } from '../../lib/units';
import { chainName, customShops, isPressOnlyShop, kindOf, sectionOf, shopsByGroup, type StoreChain } from '../../shops';
import { adapterFor } from '../../stores';
import { isNative } from '../../stores/http';
import type { StoreProduct } from '../../stores/types';
import { looksLikeBotCheck, searchInfo } from '../../stores/web';
import { BETA_SHOPS, BetaTag, Icon, LoadingBar } from '../components';
import { useNav } from '../nav';
import { UnblockButton } from '../Unblock';

const HOW: Record<string, string> = {
  woolworths: "Woolworths' own app data",
  coles: "Coles' own app data",
  aldi: "Aldi's own app data",
  costco: "Costco's public pages",
  endeavour: "Dan Murphy's and BWS's own data, then its search page",
  web: "the shop's website (its search page)",
};

interface Result {
  shop: StoreChain;
  term: string;
  ms: number;
  found: StoreProduct[];
  error?: string;
  how: string;
  searchPage?: string;
  searchFound?: string;
  botCheck: boolean;
  /** 0.10.4: nothing came back and the shop answered 403/429 or a bot check. */
  blocked?: boolean;
  answers: { kind: Captured['kind']; status: number; host: string; bytes: number }[];
  /** 0.10.7: the biggest answer that worked, for "Copy the shop's answer". Kept only on screen. */
  raw?: Captured;
}

/** Keys that could say who you are or where you shop. Their values never go in the copy. */
const PERSONAL =
  /cookie|token|session|auth|e-?mail|phone|mobile|address|postcode|post_code|suburb|street|latitude|longitude|geo|store_?id|storeid|branch|customer|member_?(id|number)|account|user|login|password|card|ip$|(first|last|given|family|sur|full|display|nick)_?name|greeting|birth|dob|gender|shopper/i;

/** 0.10.8: emails and phone numbers anywhere in the text (a signed-in page can greet you by them). */
const scrubText = (s: string) =>
  s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '(email removed)')
    .replace(/(?<!\d)(?:\+?61[ -]?|0)[2-478](?:[ -]?\d){8}(?!\d)/g, '(phone removed)');

/**
 * 0.10.7: what the shop sent back, cut down to what's needed to fix how it's read: a few products
 * of each list, long text shortened, and details like an email, address or store number taken
 * out (a web page can still name its branch). JSON stays JSON; a web page loses its scripts' code, styles and pictures.
 */
export function shopAnswerCopy(c: Captured, limit = 60_000): string {
  const head = `Restock ${__APP_VERSION__} · shop answer · ${c.kind} ${(() => {
    try {
      return new URL(c.url).host + new URL(c.url).pathname.replace(/\d{3,}/g, '#');
    } catch {
      return '';
    }
  })()} · ${c.status}`;
  let body: string;
  try {
    const trim = (v: unknown, depth: number): unknown => {
      if (Array.isArray(v)) return v.slice(0, depth < 3 ? 3 : 2).map((x) => trim(x, depth + 1));
      if (v && typeof v === 'object')
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, PERSONAL.test(k) ? '(removed)' : trim(x, depth + 1)]),
        );
      if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v;
      return v;
    };
    body = JSON.stringify(trim(JSON.parse(c.body), 0), null, 1);
  } catch {
    body = c.body
      .replace(/<script\b(?![^>]*(application\/(ld\+)?json))[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<(style|svg|noscript)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/g, 'data:…')
      .replace(/("?(?:email|phone|postcode|suburb|address|token|session)"?\s*[:=]\s*)"[^"]*"/gi, '$1"(removed)"')
      .replace(/\s+/g, ' ');
  }
  body = scrubText(body);
  return `${head}\n${body.length > limit ? `${body.slice(0, limit)}\n… (cut short)` : body}`;
}

/** The report to copy: plain text, nothing personal (no branch, store number, cookies or account). */
export function shopTestReport(r: Result, version: string): string {
  const lines = [
    `Restock ${version} · Shop test`,
    `Shop: ${chainName(r.shop)} (${r.shop})`,
    `Searched for: ${r.term}`,
    `Read from: ${r.how}`,
    ...(r.searchPage ? [`Search page: ${r.searchPage}${r.searchFound ? ` (${r.searchFound})` : ''}`] : []),
    `Took: ${(r.ms / 1000).toFixed(1)} s`,
    r.error ? `Result: didn't work: ${r.error}` : `Result: ${r.found.length} found`,
    // 0.10.7: a bot check that Restock got past isn't a problem: say so plainly.
    ...(r.botCheck ? [r.found.length ? "The first try met a bot check; Restock's built-in browser got through." : 'The shop showed a bot check or "checking your browser" page.'] : []),
    ...(r.blocked ? ['Blocked: the shop turned Restock away (Unblock offered).'] : []),
    ...r.found.slice(0, 8).map((p, i) => `${i + 1}. ${p.name}${p.size && !nameHasSize(p.name, p.size) ? ` ${p.size}` : ''} · ${money(p.price)}${p.isSpecial ? ` (special${p.wasPrice ? `, was ${money(p.wasPrice)}` : ''})` : ''}`),
    `Answers: ${r.answers.map((a) => `${a.kind} ${a.host} ${a.status} ${Math.round(a.bytes / 1024)} KB`).join('; ') || 'none'}`,
  ];
  return lines.join('\n');
}

export function ShopTest() {
  const nav = useNav();
  const groups = shopsByGroup();
  const all = [...groups.flatMap((g) => g.shops.map((s) => s.id)), ...customShops().map((c) => c.id)];
  const [shop, setShop] = useState<StoreChain>(all[0]);
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<Result>();
  const word = term.trim() || TEST_WORD[sectionOf(shop)];
  // 0.10.4: a 403, or a "checking your browser" page, is the shop blocking Restock.
  const blocked = !!r?.error && (r.botCheck || r.blocked || isBlockedError(r.error));
  // 0.10.5: Unblock is offered for a hidden-browser shop that found nothing, too.
  const unblock = blocked || (!!r?.error && offerUnblock(r.shop, r.error));

  const run = async () => {
    setBusy(true);
    setR(undefined);
    const t0 = Date.now();
    const kind = kindOf(shop) ?? 'web';
    let searchPage: string | undefined;
    let searchFound: string | undefined;
    // Always the shop's online store (no branch), as Send search details does.
    const out = await captureWhile(async () => {
      if (kind === 'web') {
        const info = await searchInfo(shop).catch(() => undefined);
        searchPage = info?.search;
        searchFound = info?.how;
      }
      return adapterFor(shop)!.search(word);
    });
    const answers = out.captured.map((c) => {
      let host = c.url;
      try {
        host = new URL(c.url).host;
      } catch {
        // keep it as it is
      }
      return { kind: c.kind, status: c.status, host, bytes: c.body.length };
    });
    setR({
      shop,
      term: word,
      ms: Date.now() - t0,
      found: out.result ?? [],
      error: out.error ?? (out.result && !out.result.length ? 'The shop answered, but nothing came back for that word.' : undefined),
      how: HOW[kind] ?? kind,
      searchPage,
      searchFound,
      botCheck: out.captured.some((c) => looksLikeBotCheck(c.body)),
      blocked: !out.result?.length && (isBlockedError(out.error) || out.captured.some((c) => c.status === 403 || c.status === 429)),
      answers,
      raw: out.captured.filter((c) => c.status >= 200 && c.status < 300 && c.body.length > 0).sort((a, b) => b.body.length - a.body.length)[0],
    });
    setBusy(false);
  };

  const copy = async () => {
    if (!r) return;
    const text = shopTestReport(r, __APP_VERSION__);
    try {
      await navigator.clipboard.writeText(text);
      nav.toast('Report copied. Paste it in a message to the developer.');
    } catch {
      await shareTextFile(`restock-shop-test-${r.shop}.txt`, text, 'text/plain');
    }
  };

  const copyAnswer = async () => {
    if (!r?.raw) return;
    const text = shopAnswerCopy(r.raw);
    try {
      await navigator.clipboard.writeText(text);
      nav.toast("The shop's answer is copied. Paste it in a message to the developer.");
    } catch {
      await shareTextFile(`restock-shop-answer-${r.shop}.txt`, text, 'text/plain');
    }
  };

  return (
    <>
      <div className="eyebrow" id="shop-test">
        Shop test
      </div>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p className="small" style={{ margin: 0 }}>
          Try any shop, even one you haven't picked: Restock searches it once, the way it would on a tab, and shows what came back and how it was
          read, or why it didn't work. Copy the report and send it, so a shop that doesn't work yet can be fixed. The report has the shop, the
          word and the first results: nothing from your pantry, lists, settings or branches.
        </p>
        <label className="field">
          <span>Shop</span>
          <select className="input" value={shop} onChange={(e) => (setShop(e.target.value as StoreChain), setR(undefined))}>
            {groups.map((g) => (
              <optgroup key={g.group} label={g.name}>
                {g.shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {BETA_SHOPS.includes(s.id) ? ' (beta)' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Search for</span>
          <input className="input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder={TEST_WORD[sectionOf(shop)]} />
        </label>
        {isPressOnlyShop(shop) && <p className="small" style={{ margin: 0 }}>Costco is only searched when you press a button, so this counts as one search.</p>}
        <button className="btn primary" disabled={!isNative() || busy} onClick={() => void run()}>
          <Icon name="search" size={18} /> {busy ? 'Searching…' : `Test ${chainName(shop)}`}
        </button>
        {busy && <LoadingBar seconds={kindOf(shop) === 'web' ? 30 : 10} />}
        {!isNative() && <p className="small" style={{ margin: 0 }}>This works in the Android app: shops are searched from your phone.</p>}
        {r && (
          <div className={`banner ${r.error ? 'amber' : 'green'}`} role="status" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <strong>
              {r.error
                ? blocked
                  ? `Blocked: ${chainName(r.shop)} is blocking Restock`
                  : `${chainName(r.shop)} didn't work`
                : `${chainName(r.shop)} works: ${r.found.length} found`}{' '}
              {BETA_SHOPS.includes(r.shop) && <BetaTag />}
            </strong>
            {r.error && !blocked && <span className="small">{r.error}</span>}
            {blocked && (
              <span className="small">
                {r.botCheck ? 'It showed a bot check ("checking your browser"). ' : ''}Its website is checking for bots. That’s its check, not
                Restock’s. Unblock it once and try again.
              </span>
            )}
            {unblock && <UnblockButton chain={r.shop} onWorked={() => void run()} />}
            <span className="small">
              Read from {r.how}
              {r.searchPage ? ` · ${r.searchPage}` : ''} · {(r.ms / 1000).toFixed(1)} s
            </span>
            {r.found.slice(0, 5).map((p, i) => (
              <span key={i} className="small clip">
                {p.name} · {money(p.price)}
                {p.isSpecial ? ' (special)' : ''}
              </span>
            ))}
            <button className="btn" onClick={() => void copy()}>
              <Icon name="share" size={17} /> Copy report
            </button>
            {r.raw && (
              <>
                <button className="btn" onClick={() => void copyAnswer()}>
                  <Icon name="share" size={17} /> Copy the shop's answer
                </button>
                <span className="small">
                  What the shop sent back, cut down, with details like your email, address or store number taken out. A shop's web page can still name
                  the branch it's set to.
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
