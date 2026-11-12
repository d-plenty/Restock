import { useEffect, useState } from 'react';
import { getKV, updateSettings } from '../../lib/db';
import {
  DEFAULT_PRICE_HELPER,
  HELPER_SEARCHES,
  helperSearches,
  helperStatus,
  tidyHelperUrl,
  tidySearches,
  type PriceHelperSettings,
  type PriceHelperState,
} from '../../lib/priceHelper';
import { RestockNative } from '../../lib/sql/native';
import { isNative } from '../../stores/http';
import type { Settings } from '../../types';
import { useNav } from '../nav';

/**
 * 0.9.11: Settings → Shared prices → Price helper phone. A spare Android phone, left on its charger,
 * searches Coles and Woolworths through the week and sends what it finds to the restock-prices
 * collector on your own network (PriceHelper.java). Phone only: the web page shows why not.
 */
export function PriceHelperSettings({ settings }: { settings: Settings }) {
  const nav = useNav();
  const ph: PriceHelperSettings = settings.priceHelper ?? DEFAULT_PRICE_HELPER;
  const [url, setUrl] = useState(ph.url ?? '');
  const [key, setKey] = useState(ph.key ?? '');
  const [editing, setEditing] = useState(false);
  const [list, setList] = useState('');
  const [testing, setTesting] = useState(false);
  // 0.9.12: what the background run writes, read again every few seconds while this is open (the
  // phone's own runs don't tell the screen when they write).
  const [state, setState] = useState<PriceHelperState | undefined>();
  const [asked, setAsked] = useState<number | undefined>();
  useEffect(() => {
    let alive = true;
    const read = () =>
      void getKV<PriceHelperState>('priceHelper')
        .then((v) => alive && setState(v))
        .catch(() => undefined);
    read();
    const t = setInterval(read, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  useEffect(() => setUrl(ph.url ?? ''), [ph.url]);
  useEffect(() => setKey(ph.key ?? ''), [ph.key]);

  if (!isNative())
    return (
      <div className="card">
        <div className="banner grey">
          <strong>This is set up on the phone</strong>
          <span style={{ fontSize: 13 }}>The price helper runs on a spare Android phone with Restock, left on its charger. Turn it on in that phone's Settings.</span>
        </div>
      </div>
    );

  // 0.9.12: saved straight away, not held for Settings' Save button: the background run reads the
  // saved settings, so a change waiting for Save did nothing ("Run a few now" ran with it off).
  // It's this phone's own setting, so it never goes to the household.
  const save = async (patch: Partial<PriceHelperSettings>) => {
    const next: PriceHelperSettings = { ...ph, ...patch };
    // Turned on: the list the phone runs is written out, so the background job has it.
    if (next.enabled && !next.searches?.length) next.searches = HELPER_SEARCHES;
    await updateSettings({ priceHelper: next }, { local: true });
    await RestockNative.priceHelperSchedule().catch(() => undefined);
  };

  const searches = helperSearches(ph);
  const custom = !!ph.searches?.length && ph.searches.join('\n') !== HELPER_SEARCHES.join('\n');
  const badUrl = url.trim() !== '' && !tidyHelperUrl(url);

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="small" style={{ margin: 0 }}>
        For a spare Android phone left on its charger at home. Through the week it searches Coles and Woolworths for {searches.length} everyday things,
        the first page of results each time, about one search every 10 minutes while it's charging on Wi-Fi. What it finds (products and shelf
        prices only) goes to your restock-prices collector, which adds it to the shared price history at its weekly run. If a shop turns it away,
        that shop rests for six hours.
      </p>
      <label className="check">
        <input
          type="checkbox"
          className="switch"
          checked={ph.enabled}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
        <span style={{ flex: 1 }}>
          <span className="title" style={{ fontSize: 15 }}>
            Use this phone as a price helper
          </span>
        </span>
      </label>
      <label className="field">
        <span>Collector's helper address</span>
        <input
          className="input"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          value={url}
          placeholder="http://192.168.1.20:8790"
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => {
            const t = tidyHelperUrl(url);
            if (t !== (ph.url ?? undefined) && (t || !url.trim())) void save({ url: t });
          }}
        />
      </label>
      {badUrl && (
        <p className="small" role="alert" style={{ margin: '-6px 0 0', color: 'var(--red-ink, var(--red))' }}>
          That doesn't look like an address. It's http:// and the computer's address and port, like http://192.168.1.20:8790.
        </p>
      )}
      <label className="field">
        <span>Collector's helper key</span>
        <input
          className="input"
          type="password"
          autoCapitalize="off"
          autoCorrect="off"
          value={key}
          placeholder="HELPER_KEY from the collector's .env"
          onChange={(e) => setKey(e.target.value)}
          onBlur={() => {
            const t = key.trim() || undefined;
            if (t !== ph.key) void save({ key: t });
          }}
        />
      </label>
      <p className="small" style={{ margin: '-6px 0 0' }}>
        The key stays on this phone. It isn't shared with your household or put in backups.
      </p>
      <div className="two">
        <button
          className="btn"
          disabled={testing || !tidyHelperUrl(url) || !key.trim()}
          onClick={async () => {
            setTesting(true);
            try {
              const r = await RestockNative.priceHelperTest({ url: tidyHelperUrl(url)!, key: key.trim() });
              nav.toast(
                r.ok
                  ? 'The collector answered and took the key'
                  : r.status === 401 || r.status === 403
                    ? "The collector answered, but didn't take that key"
                    : r.status
                      ? `The collector answered HTTP ${r.status}`
                      : `Couldn't reach the collector${r.error ? ` (${r.error})` : ''}`,
              );
            } finally {
              setTesting(false);
            }
          }}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button
          className="btn"
          disabled={!ph.enabled || !ph.url || !ph.key}
          onClick={async () => {
            // Whatever is typed in the boxes counts, even if they haven't been left yet.
            const u = tidyHelperUrl(url);
            if (u && (u !== ph.url || key.trim() !== ph.key)) await save({ url: u, key: key.trim() || undefined });
            await RestockNative.priceHelperRunNow();
            setAsked(Date.now());
          }}
        >
          Run a few now
        </button>
      </div>
      <div className="small" role="status" aria-live="polite">
        {helperStatus({ state, enabled: ph.enabled, of: searches.length, asked, now: Date.now() }).map((line) => (
          <span key={line} style={{ display: 'block' }}>
            {line}
          </span>
        ))}
      </div>
      {!editing ? (
        <button
          className="btn ghost small"
          style={{ alignSelf: 'flex-start', minHeight: 44 }}
          onClick={() => {
            setList(searches.join('\n'));
            setEditing(true);
          }}
        >
          Edit the {searches.length} searches{custom ? ' (your own list)' : ''}
        </button>
      ) : (
        <>
          <label className="field">
            <span>What it searches, one per line</span>
            <textarea className="input" rows={12} value={list} onChange={(e) => setList(e.target.value)} style={{ height: 'auto', fontSize: 14 }} />
          </label>
          <div className="two">
            <button
              className="btn primary"
              onClick={async () => {
                const next = tidySearches(list);
                await save({ searches: next.length ? next : HELPER_SEARCHES });
                setEditing(false);
                nav.toast(`${(next.length || HELPER_SEARCHES.length).toLocaleString()} searches saved`);
              }}
            >
              Keep this list
            </button>
            <button className="btn" onClick={() => setList(HELPER_SEARCHES.join('\n'))}>
              Back to the built-in {HELPER_SEARCHES.length}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
