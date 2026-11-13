import { useEffect, useState } from 'react';
import { shareTextFile } from '../../lib/backup';
import { getSettings } from '../../lib/db';
import { captureWhile, clearProblems, problems, problemsText } from '../../lib/diagnostics';
import { recordTrolley } from '../../lib/accounts';
import { getHealth } from '../../lib/health';
import { useLive } from '../../lib/useLive';
import { chainName, enabledIn, isPressOnlyShop, SECTION_NAMES, type Section, type StoreChain } from '../../shops';
import { adapterFor } from '../../stores';
import { isNative } from '../../stores/http';
import { localDay } from '../../lib/verdict';
import {
  searchTestSize,
  shareLastSearchTest,
  startSearchTest,
  stopSearchTest,
  watchSearchTest,
  type SearchTestState,
} from '../../lib/searchTest';
import { CheckedAgo, ChainDot, Icon, LoadingBar, TopBar } from '../components';
import { useNav } from '../nav';
import { getCheckLog, missedSlot, missedWords, OUTCOME_WORDS, whenWords } from '../../lib/checkLog';
import { syncInfo } from '../../lib/sync';
import { RestockNative } from '../../lib/sql/native';

// Settings → Diagnostics: what went wrong lately, shop by shop, and "Send search details" to
// capture exactly what a shop sends back, so its connection can be fixed.

/** 0.9.0: files are named for the day on the phone's own calendar, not UTC's. */
const today = () => localDay(new Date().toISOString());

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
  const shops = sections.flatMap((sec) => enabledIn(settings.enabledChains, sec).filter((c) => !isPressOnlyShop(c)).map((c) => ({ c, sec })));
  const shop = chain ?? shops[0]?.c;

  const copy = async () => {
    const text = problemsText(list, __APP_VERSION__);
    try {
      await navigator.clipboard.writeText(text);
      nav.toast('Copied');
    } catch {
      await shareTextFile(`restock-diagnostics-${today()}.txt`, text, 'text/plain');
    }
  };

  const send = async () => {
    if (!shop || !term.trim()) return;
    setBusy(true);
    try {
      // 0.9.0: always the shop's online store, never your branch, so the file has no store number
      // or branch in it (the shop's answer would carry them).
      const run = await captureWhile(() => adapterFor(shop)!.search(term.trim()));
      const file = {
        app: 'restock',
        kind: 'search-details',
        version: __APP_VERSION__,
        at: new Date().toISOString(),
        shop,
        shopName: chainName(shop),
        term: term.trim(),
        found: run.result?.length ?? 0,
        firstResults: (run.result ?? []).slice(0, 10),
        error: run.error,
        answers: run.captured,
      };
      await shareTextFile(
        `restock-search-${shop}-${today()}.json`,
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

      {isNative() && <BackgroundChecks />}

      <div className="eyebrow">Each shop</div>
      <div className="card flush">
        {shops.map(({ c, sec }) => {
          const h = health[c];
          return (
            <div key={c} className="row">
              <ChainDot chain={c} />
              <span className="grow">
                <span className="title" style={{ fontSize: 15 }}>
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
          If a shop's search looks wrong, run one search here. Restock searches the shop's website (not your branch) and saves exactly what
          the shop sent back into a file you can send to the developer, so the connection can be fixed. Nothing from your pantry, lists or
          settings goes in it.
        </p>
        <p className="small" style={{ margin: 0 }}>
          The shop's answer can still be about you: if you're signed in to Woolworths inside Restock, Woolworths answers for your account (its
          branch's prices and stock, and possibly what's in your trolley). Open the file and check it before you send it.
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
        `restock-trolley-${chain}-${today()}.json`,
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
 * one file for the developer, so search can be made better with what your phone really gets. It
 * keeps going with the screen off, with a notification showing how far it's got.
 */
function SearchTest() {
  const nav = useNav();
  const [which, setWhich] = useState<'all' | Section>('pantry');
  const [every, setEvery] = useState(false);
  const [count, setCount] = useState<number>();
  const [test, setTest] = useState<SearchTestState>({});
  const sections: Section[] = which === 'all' ? ['pantry', 'keg', 'pharmacy'] : [which];
  useEffect(() => watchSearchTest(setTest), []);
  useEffect(() => {
    void searchTestSize(sections, every).then(setCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [which, every]);
  const progress = test.progress;

  const start = async () => {
    try {
      const how = await startSearchTest(sections, every);
      if (how === 'saved') nav.toast('Search test done. Send it from here.');
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : String(e));
    }
  };

  // About 5 seconds a search on a phone: the shop's answer and a pause before the next one.
  const minutes = Math.max(1, Math.round(((count ?? 0) * 5) / 60));
  return (
    <>
      <div className="eyebrow">Search test</div>
      <div className="card">
        <p className="small" style={{ margin: 0 }}>
          Searches a list of everyday words (milk, Western Star, Panadol, VB…) at each of your shops, the way Restock does, and saves what came
          back in one file you can send to the developer, so search can be made better. One search at a time with a pause in between. The file
          has the shops' answers and the test words: nothing from your pantry, lists or settings, and no branch numbers.
        </p>
        <label className="field">
          <span>Which shops</span>
          <select className="input" value={which} disabled={!!progress} onChange={(e) => setWhich(e.target.value as 'all' | Section)}>
            <option value="pantry">Supermarkets</option>
            <option value="keg">Bottle shops</option>
            <option value="pharmacy">Chemists</option>
            <option value="all">All three</option>
          </select>
        </label>
        <label className="row" style={{ padding: 0 }}>
          <input type="checkbox" className="switch" checked={every} disabled={!!progress} onChange={(e) => setEvery(e.target.checked)} />
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
              You can lock the phone or use other apps: it keeps going, and the notification shows how far it's got.
            </p>
            <button className="btn" onClick={stopSearchTest}>
              Stop and save what it has
            </button>
          </>
        ) : (
          <button className="btn primary" disabled={!isNative() || !count} onClick={() => void start()}>
            {count ? `Start: ${count} searches, about ${minutes} minute${minutes === 1 ? '' : 's'}` : 'No shops on for this'}
          </button>
        )}
        {!isNative() && <p className="small">This works in the Android app.</p>}
        {test.last && !progress && (
          <>
            <p className="small" style={{ margin: 0 }}>
              Last test: {new Date(test.last.at).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}
              {test.last.stoppedEarly ? ' (stopped early)' : ''}
            </p>
            <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', margin: 0 }}>
              {test.last.summary}
            </pre>
            <button className="btn" onClick={() => void shareLastSearchTest()}>
              Send the last test
            </button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * 0.10.2: the scheduled price checks: the last few, whether each ran and finished, and Restock's
 * battery setting (Android decides when background work runs, and can hold it back).
 */
function BackgroundChecks() {
  const settings = useLive(getSettings, []);
  const runs = useLive(getCheckLog, []) ?? [];
  const info = useLive(syncInfo, []);
  if (!settings) return null;
  const plan = { intervalHours: settings.checkIntervalHours, time: settings.checkTime, weekday: settings.checkWeekday };
  const missed = settings.sync.backgroundActivity ? missedSlot(plan, settings.lastCheck, runs) : undefined;
  const held = !!info?.backgroundRestricted || info?.batteryExempt === false;
  return (
    <>
      <div className="eyebrow" id="d-checks">
        Background checks
      </div>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!settings.sync.backgroundActivity ? (
          <p className="small" style={{ margin: 0 }}>
            Background activity is off (Settings → Sync and backups), so prices are only checked when you tap Check now.
          </p>
        ) : (
          <>
            <p className="small" style={{ margin: 0 }}>
              Last finished: <strong>{whenWords(settings.lastCheck)}</strong>.
              {missed !== undefined ? ` ${missedWords(missed, runs)}.` : ''}
            </p>
            {runs.length > 0 ? (
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {runs.slice(0, 6).map((r) => (
                  <li key={r.start}>
                    {whenWords(r.slot)} check: {OUTCOME_WORDS[r.outcome]}
                    {r.outcome === 'done' && r.checked !== undefined ? ` (${r.checked} checked${r.errors ? `, ${r.errors} shop${r.errors === 1 ? '' : 's'} with a problem` : ''})` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small" style={{ margin: 0 }}>
                No scheduled checks noted yet (they're noted from 0.10.2).
              </p>
            )}
            <p className="small" style={{ margin: 0 }}>
              A check that never started was held back by Android, or was waiting for a connection or more battery (it needs both). One that
              stopped part way ran out of the time Android gives it.
            </p>
          </>
        )}
        <p className="small" style={{ margin: 0, fontWeight: 600, color: held ? 'var(--amber-ink)' : 'var(--green-ink)' }}>
          {info?.backgroundRestricted
            ? "Restock's battery setting is Restricted, so Android holds its checks back."
            : info?.batteryExempt === false
              ? "Restock's battery setting is Optimised, so Android can delay its checks."
              : "Restock's battery setting is Unrestricted: checks run on time."}
        </p>
        {held && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn small primary" onClick={() => void RestockNative.requestBatteryExemption().catch(() => undefined)}>
              Let it run in the background
            </button>
            <button className="btn small" onClick={() => void RestockNative.openAppSettings().catch(() => undefined)}>
              Open Restock's settings
            </button>
          </div>
        )}
      </div>
    </>
  );
}
