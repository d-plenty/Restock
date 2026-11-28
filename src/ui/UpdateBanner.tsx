// 0.10.12: a newer Restock is out: Home says so, with the version you have and the one you'd get,
// and one Update now button. It stays until the app is updated (there's no way to put it away),
// and it's Home's only: nothing covers the other screens, and nothing is blocked.
//
// It asks GitHub nothing by itself: it shows what the last check found (the daily one behind "Tell
// me when there's an update", or Check in Settings), kept as settings.updates.told. Update now asks
// GitHub once for the file, then Android shows its own Install screen.
import { useState } from 'react';
import { version } from '../../package.json';
import { checkForUpdate, installUpdate, isNewer, RELEASES, SELF_UPDATE } from '../lib/updates';
import type { Settings } from '../types';
import { Icon } from './components';
import { useNav } from './nav';

/** The newer version the last check found, if this app is still older than it. */
export function updateWaiting(u: Settings['updates'], current = version): string | undefined {
  const told = u?.told?.trim();
  return told && /^\d+(\.\d+)*$/.test(told) && isNewer(told, current) ? told : undefined;
}

export function UpdateBanner({ settings }: { settings: Settings }) {
  const nav = useNav();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const next = SELF_UPDATE ? updateWaiting(settings.updates) : undefined;
  if (!next) return null;
  const update = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const info = await checkForUpdate(version);
      if (!info.newer || !info.apkUrl) throw new Error("GitHub doesn't have the update's file right now.");
      const r = await installUpdate(info.apkUrl);
      if (r === 'permission') nav.toast('Allow Restock to install apps, then come back and tap Update now again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card update-banner" aria-label="Update available">
      <div className="update-banner-head">
        <span className="update-banner-icon" aria-hidden="true">
          <Icon name="download" size={22} />
        </span>
        <div>
          <h2>Update available</h2>
          <p className="small">
            You have {version}. The new version is <strong>{next}</strong>.
          </p>
        </div>
      </div>
      <button className="btn primary block update-banner-btn" disabled={busy} onClick={() => void update()}>
        {busy ? 'Downloading…' : `Update now to ${next}`}
      </button>
      {error && (
        <p className="small" role="alert" style={{ margin: 0 }}>
          {error} You can also get it from <a href={RELEASES}>GitHub Releases</a>.
        </p>
      )}
    </section>
  );
}
