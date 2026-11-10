import { useEffect, useState } from 'react';
import { getSettings } from '../../lib/db';
import { protection, suggestLocalText } from '../../lib/protection';
import { syncAvailable, syncInfo, type SyncInfo } from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { TopBar } from '../components';
import { SuggestLocalBackup } from './Backups';
import { ServerCard } from './Sync';

/**
 * 0.9.3: the Restock server on a screen of its own (Settings → Sync and backups → Restock server).
 * A phone that isn't in a household yet can still Connect: it starts the household first.
 */
export function RestockServerScreen() {
  const settings = useLive(getSettings, []);
  const [info, setInfo] = useState<SyncInfo>();
  useEffect(() => {
    let live = true;
    const load = () => void syncInfo().then((i) => live && setInfo(i));
    load();
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const p = settings && info ? protection(settings.autoBackup.enabled, info) : undefined;

  return (
    <div className="screen">
      <TopBar title="Restock server" />

      {!syncAvailable() && (
        <div className="banner grey">
          <strong>The Restock server works in the Android app</strong>
          <span style={{ fontSize: 13 }}>In this preview everything stays in this browser.</span>
        </div>
      )}

      {info && (
        <>
          <div className="eyebrow">{info.server ? 'Connected' : 'Connect this phone'}</div>
          <ServerCard info={info} busy={false} onInfo={setInfo} />
        </>
      )}

      {info && !info.server && (
        <div className="card" style={{ gap: 6 }}>
          <strong>Don't have a server yet?</strong>
          <span className="small">
            One <code>docker run</code> command sets it up on a NAS or home server, or install it as an app in Home Assistant:{' '}
            <a href="https://github.com/d-plenty/restock-server" target="_blank" rel="noreferrer">
              how to set up a Restock server
            </a>
            .
          </span>
        </div>
      )}

      {p?.server && p.suggestLocal && <SuggestLocalBackup text={suggestLocalText(p)} />}
    </div>
  );
}
