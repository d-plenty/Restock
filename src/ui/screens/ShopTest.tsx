// 0.10.3: Advanced → Diagnostics → Shop test. Pick any shop Restock knows (picked or not), search
// one word, and see what came back and how it was read, or why it didn't work, with a report to
// copy and send to the developer. The report has the shop, the words, how it was read and the
// first results: nothing from your pantry, lists, settings or branches.
import { useState } from 'react';
import { shareTextFile } from '../../lib/backup';
import { captureWhile, type Captured } from '../../lib/diagnostics';
import { isBlockedError, TEST_WORD } from '../../lib/health';
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
    ...(r.botCheck ? ['The shop showed a bot check or "checking your browser" page.'] : []),
    ...(r.blocked ? ['Blocked: the shop turned Restock away (Unblock offered).'] : []),
    ...r.found.slice(0, 8).map((p, i) => `${i + 1}. ${p.name}${p.size ? ` ${p.size}` : ''} · ${money(p.price)}${p.isSpecial ? ` (special${p.wasPrice ? `, was ${money(p.wasPrice)}` : ''})` : ''}`),
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
            {blocked && <UnblockButton chain={r.shop} onWorked={() => void run()} />}
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
          </div>
        )}
      </div>
    </>
  );
}
