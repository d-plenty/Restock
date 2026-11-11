import { useEffect, useState } from 'react';
import { getKV } from '../../lib/db';
import { DEFAULT_PRICE_HELPER, HELPER_SEARCHES, helperSearches, tidyHelperUrl, tidySearches, type PriceHelperSettings, type PriceHelperState } from '../../lib/priceHelper';
import { afterSave, updateSettings } from '../../lib/settingsDraft';
import { RestockNative } from '../../lib/sql/native';
import { useLive } from '../../lib/useLive';
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
  const state = useLive(() => getKV<PriceHelperState>('priceHelper'), []);
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

  const save = async (patch: Partial<PriceHelperSettings>) => {
    const next: PriceHelperSettings = { ...ph, ...patch };
    // Turned on: the list the phone runs is written out, so the background job has it.
    if (next.enabled && !next.searches?.length) next.searches = HELPER_SEARCHES;
    await updateSettings({ priceHelper: next });
    await afterSave('priceHelper', () => RestockNative.priceHelperSchedule().catch(() => undefined));
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
            await RestockNative.priceHelperRunNow();
            nav.toast('Running the next few searches now. It takes a couple of minutes.');
          }}
        >
          Run a few now
        </button>
      </div>
      <div className="small" role="status">
        {state?.week ? (
          <>
            This week: {Math.min(state.done ?? 0, state.of ?? searches.length)} of {state.of ?? searches.length} searches done · {(state.sent ?? 0).toLocaleString()}{' '}
            prices sent
            {state.waiting ? ` · ${state.waiting.toLocaleString()} waiting to send` : ''}
            {state.lastAt ? ` · last ran ${new Date(state.lastAt).toLocaleString()}` : ''}
            {state.lastError ? <span style={{ display: 'block' }}>Last problem: {state.lastError}</span> : null}
          </>
        ) : ph.enabled ? (
          'Not run yet. It starts the next time this phone is charging on Wi-Fi.'
        ) : (
          'Off.'
        )}
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
