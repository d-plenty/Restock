import { useEffect, useRef, useState } from 'react';
import { shareTextFile } from '../../lib/backup';
import { getSettings } from '../../lib/db';
import { captureWhile, clearProblems, problems, problemsText } from '../../lib/diagnostics';
import { recordTrolley } from '../../lib/accounts';
import { getHealth } from '../../lib/health';
import { useLive } from '../../lib/useLive';
import { chainName, enabledIn, SECTION_NAMES, type Section, type StoreChain } from '../../shops';
import { adapterFor } from '../../stores';
import { searchStoreId } from '../../types';
import { isNative } from '../../stores/http';
import { runSearchTest, searchTestSize, type SearchTestProgress } from '../../lib/searchTest';
import { CheckedAgo, ChainDot, Icon, LoadingBar, TopBar } from '../components';
import { useNav } from '../nav';

// Settings → Diagnostics: what went wrong lately, shop by shop, and "Send search details" to
// capture exactly what a shop sends back, so its connection can be fixed.

export function DiagnosticsScreen() {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const list = useLive(problems, []);
  const health = useLive(getHealth, []);
  const [chain, setChain] = useState<StoreChain>();
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);
  if (!settings || !list || !health) return <div className="screen" />;

  const sections: Section[] = ['pantry', 'keg', 'pharmacy'];
  const shops = sections.flatMap((sec) => enabledIn(settings.enabledChains, sec).map((c) => ({ c, sec })));
  const shop = chain ?? shops[0]?.c;

  const copy = async () => {
    const text = problemsText(list, __APP_VERSION__);
    try {
      await navigator.clipboard.writeText(text);
      nav.toast('Copied');
    } catch {
      await shareTextFile(`restock-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`, text, 'text/plain');
    }
  };

  const send = async () => {
    if (!shop || !term.trim()) return;
    setBusy(true);
    try {
      // The same store as a real search: your Coles when you have chosen your Coles store in My shops.
      const storeId = searchStoreId(await getSettings(), shop);
      const run = await captureWhile(() => adapterFor(shop)!.search(term.trim(), storeId));
      const file = {
        app: 'restock',
        kind: 'search-details',
        version: __APP_VERSION__,
        at: new Date().toISOString(),
        shop,
        storeId: storeId ?? 'online',
        shopName: chainName(shop),
        term: term.trim(),
        found: run.result?.length ?? 0,
        firstResults: (run.result ?? []).slice(0, 10),
        error: run.error,
        answers: run.captured,
      };
      await shareTextFile(
        `restock-search-${shop}-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(file, null, 1),
        'application/json',
        'Restock search details',
      );
      nav.toast(run.error ? `Saved. ${chainName(shop)} said: ${run.error}` : `Saved what ${chainName(shop)} sent back (${file.found} results).`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <TopBar title="Diagnostics" />
      <p className="sub">What went wrong lately, in plain words. It stays on your phone unless you copy or send it.</p>

      <div className="eyebrow">Each shop</div>
      <div className="card flush">
        {shops.map(({ c, sec }) => {
          const h = health[c];
          return (
            <div key={c} className="row">
              <ChainDot chain={c} />
              <span className="grow">
                <span className="title" style={{ fontSize: 14 }}>
                  {chainName(c)} <span className="small">· {SECTION_NAMES[sec]}</span>
                </span>
                <span className="small">
                  {h?.failingSince && h.error ? (
                    <>
                      <Icon name="alert" size={13} /> {h.error}
                    </>
                  ) : h?.lastOk ? (
                    <>
                      Working · <CheckedAgo date={h.lastOk} />
                    </>
                  ) : (
                    'Not used yet'
                  )}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="eyebrow">Latest problems</div>
      <div className="card flush">
        {list.slice(0, 30).map((p) => (
          <div key={p.at + p.chain + p.message} className="row" style={{ alignItems: 'flex-start' }}>
            <ChainDot chain={p.chain} />
            <span className="grow">
              <span className="small" style={{ fontWeight: 700 }}>
                {chainName(p.chain)} · {p.what} ·{' '}
                {new Date(p.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
              </span>
              <span className="small">{p.message}</span>
            </span>
          </div>
        ))}
        {!list.length && (
          <p className="small" style={{ padding: 14, margin: 0 }}>
            Nothing has gone wrong lately.
          </p>
        )}
      </div>
      <div className="two">
        <button className="btn" onClick={() => void copy()}>
          <Icon name="share" size={17} /> Copy
        </button>
        <button className="btn" disabled={!list.length} onClick={() => void clearProblems()}>
          <Icon name="trash" size={17} /> Clear
        </button>
      </div>

      <SearchTest />

      <TrolleyRecorder />

      <div className="eyebrow">Send search details</div>
      <div className="card">
        <p className="small" style={{ margin: 0 }}>
          If a shop's search looks wrong, run one search here. Restock saves exactly what the shop sent back into a file you can send to the
          developer, so the connection can be fixed. It only has the shop's answer: nothing about you or your pantry.
        </p>
        <label className="field">
          <span>Shop</span>
          <select className="input" value={shop ?? ''} onChange={(e) => setChain(e.target.value as StoreChain)}>
            {shops.map(({ c }) => (
              <option key={c} value={c}>
                {chainName(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Search for</span>
          <input className="input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="e.g. paracetamol" />
        </label>
        <button className="btn primary" disabled={!isNative() || busy || !term.trim() || !shop} onClick={() => void send()}>
          {busy ? 'Searching…' : 'Search and save the details'}
        </button>
        {busy && <LoadingBar seconds={15} />}
        {!isNative() && <p className="small">This works in the Android app.</p>}
      </div>
    </div>
  );
}

/**
 * Record adding to a trolley: you add one item on the shop's own website inside Restock, and
 * Restock saves what the website asked its servers (its own API calls only, personal details
 * removed) into a file to send to the developer, so Restock can learn to fill that trolley.
 */
function TrolleyRecorder() {
  const nav = useNav();
  const [chain, setChain] = useState<'coles' | 'woolworths'>('coles');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const run = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const calls = await recordTrolley(chain);
      if (!calls.length) {
        setNote(`Nothing was recorded. Make sure you added an item to your ${chainName(chain)} trolley before tapping Done.`);
        return;
      }
      const file = { app: 'restock', kind: 'trolley-recording', version: __APP_VERSION__, at: new Date().toISOString(), shop: chain, calls };
      await shareTextFile(
        `restock-trolley-${chain}-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(file, null, 1),
        'application/json',
        'Restock trolley recording',
      );
      nav.toast(`Saved ${calls.length} steps from ${chainName(chain)}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="eyebrow">Record adding to a trolley</div>
      <div className="card">
        <p className="small" style={{ margin: 0 }}>
          Teaches Restock to fill your trolley. Sign in to the shop first (Settings → My shops). Then tap Record, add any one item to your trolley on
          the shop's page, and tap Done. Restock saves only the shop's own trolley and search calls, with names, emails, addresses and card numbers
          removed, into a file for you to send. You can open it and check before sending.
        </p>
        <div className="seg" role="radiogroup" aria-label="Which shop">
          {(['coles', 'woolworths'] as const).map((c) => (
            <button key={c} role="radio" aria-checked={chain === c} className={chain === c ? 'on' : ''} onClick={() => setChain(c)}>
              {chainName(c)}
            </button>
          ))}
        </div>
        <button className="btn primary" disabled={busy || !isNative()} onClick={() => void run()}>
          <Icon name="cartPlus" size={17} />{' '}
          {busy ? 'Recording…' : isNative() ? `Record at ${chainName(chain)}` : 'Recording works in the Android app'}
        </button>
        {note && (
          <div className="banner amber" style={{ fontSize: 13 }}>
            {note}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The search test (0.8.6): a list of everyday words searched at your shops, marked, and saved to
 * one file for the developer, so search can be made better with what your phone really gets.
 */
function SearchTest() {
  const nav = useNav();
  const [which, setWhich] = useState<'all' | Section>('pantry');
  const [every, setEvery] = useState(false);
  const [count, setCount] = useState<number>();
  const [progress, setProgress] = useState<SearchTestProgress>();
  const [summary, setSummary] = useState<string>();
  const stop = useRef(false);
  const sections: Section[] = which === 'all' ? ['pantry', 'keg', 'pharmacy'] : [which];
  useEffect(() => {
    void searchTestSize(sections, every).then(setCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [which, every]);
  // Keep the screen on while it runs: Android may pause Restock when the screen goes off.
  useEffect(() => {
    if (!progress) return;
    let lock: { release: () => Promise<void> } | undefined;
    const wake = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    void wake
      ?.request('screen')
      .then((l) => (lock = l))
      .catch(() => undefined);
    return () => void lock?.release().catch(() => undefined);
  }, [!!progress]);

  const start = async () => {
    stop.current = false;
    setSummary(undefined);
    setProgress({ done: 0, total: count ?? 0, now: 'Starting…' });
    try {
      const { file, summary: text } = await runSearchTest(sections, every, setProgress, () => stop.current);
      setSummary(text);
      await shareTextFile(
        `restock-search-test-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(file),
        'application/json',
        'Restock search test',
      );
      nav.toast(stop.current ? 'Stopped. Saved what it found so far.' : 'Search test done and saved.');
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(undefined);
    }
  };

  const minutes = Math.max(1, Math.round(((count ?? 0) * 3) / 60));
  return (
    <>
      <div className="eyebrow">Search test</div>
      <div className="card">
        <p className="small" style={{ margin: 0 }}>
          Searches a list of everyday words (milk, Western Star, Panadol, VB…) at each of your shops, the way Restock does, and saves what came
          back in one file you can send to the developer, so search can be made better. One search at a time with a pause in between. The file
          has the shops' answers and the test words, nothing about you, your items or your store.
        </p>
        <label className="field">
          <span>Which shops</span>
          <select className="input" value={which} disabled={!!progress} onChange={(e) => setWhich(e.target.value as 'all' | Section)}>
            <option value="pantry">Supermarkets</option>
            <option value="keg">Bottle shops</option>
            <option value="pharmacy">Pharmacies</option>
            <option value="all">All three</option>
          </select>
        </label>
        <label className="row" style={{ padding: 0 }}>
          <input type="checkbox" checked={every} disabled={!!progress} onChange={(e) => setEvery(e.target.checked)} />
          <span className="grow small">Every word (about four times as many)</span>
        </label>
        {progress ? (
          <>
            <p className="small" style={{ margin: 0 }}>
              {progress.done} of {progress.total}: {progress.now}
            </p>
            <div className="loading-bar" role="progressbar" aria-label="Search test" aria-valuenow={progress.done} aria-valuemax={progress.total}>
              <span style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }} />
            </div>
            <p className="small" style={{ margin: 0 }}>
              Keep Restock open until it's done.
            </p>
            <button className="btn" onClick={() => (stop.current = true)}>
              Stop and save what it has
            </button>
          </>
        ) : (
          <button className="btn primary" disabled={!isNative() || !count} onClick={() => void start()}>
            {count ? `Start: ${count} searches, about ${minutes} minute${minutes === 1 ? '' : 's'}` : 'No shops on for this'}
          </button>
        )}
        {!isNative() && <p className="small">This works in the Android app.</p>}
        {summary && (
          <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', margin: 0 }}>
            {summary}
          </pre>
        )}
      </div>
    </>
  );
}
