// 0.9.5: the web app's small notices: a new version ready, offline (with when the list was last
// updated), changes the server didn't take, and on an iPhone in Safari how to add it to the home
// screen. Under the top strip on a phone, at the top of the page on a wide screen.
import { useEffect, useState } from 'react';
import { Icon } from '../../ui/components';
import { syncNow, unsentChanges } from '../live';
import { useStatus } from '../ui/ServerScreens';
import { InstallSheet, isInstalled, isIos } from './InstallHelp';
import { isOfflineError, usePwaState, whenText } from './offline';
import { offlineText, waitingText } from './offlineData'; // 0.9.6 (iPhone offline)
import { applyUpdate, useUpdateWaiting } from './register';
import './pwa.css';

const HINT_KEY = 'restock-pwa-hint-closed';

function hintClosed(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/** 0.9.6: a phone-sized window (the phone layout), where "this phone" is the right word. */
const phoneWide = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 599px)').matches;

/** Is the app offline right now (no network, or the server can't be reached)? */
export function useIsOffline(): boolean {
  const st = useStatus();
  const p = usePwaState();
  return p.noNetwork || isOfflineError(st.error) || (p.bootOffline && !st.at);
}

export function PwaBanners() {
  const st = useStatus();
  const p = usePwaState();
  const update = useUpdateWaiting();
  const offline = useIsOffline();
  const [hint, setHint] = useState(() => isIos() && !isInstalled() && !hintClosed());
  const [helping, setHelping] = useState(false);
  const last = whenText(p.last ?? st.at);
  // The server answered, but didn't take the changes (not a 401: that signs out).
  const refused = !offline && st.error && !/^Signed out/.test(st.error) ? st.error : undefined;
  // The top strip's own "Can't reach the server" line steps aside while this notice says it.
  useEffect(() => {
    document.documentElement.classList.toggle('pwa-offline', offline);
    return () => document.documentElement.classList.remove('pwa-offline');
  }, [offline]);
  return (
    <>
      {update && (
        <div className="pwa-banner update" role="status">
          <span className="grow">A new version is ready</span>
          <button className="pwa-banner-btn" onClick={applyUpdate}>
            Reload
          </button>
        </div>
      )}
      {offline ? (
        <div className="pwa-banner offline" role="status">
          <Icon name="wifi" size={18} />
          {/* 0.9.6 (iPhone offline): everything this phone last saved opens; edits wait here. */}
          <span className="grow">
            <strong>{offlineText(last, phoneWide() ? 'phone' : 'browser')}</strong>
            <span className="pwa-banner-sub">{waitingText(unsentChanges())}</span>
          </span>
        </div>
      ) : refused ? (
        <div className="pwa-banner refused" role="alert">
          <Icon name="alert" size={18} />
          <span className="grow">
            The server didn't take your latest changes. {refused}
          </span>
          <button className="pwa-banner-btn" onClick={() => void syncNow()} disabled={st.busy}>
            Try again
          </button>
        </div>
      ) : null}
      {hint && !update && !offline && (
        <div className="pwa-banner hint">
          <Icon name="phone" size={18} />
          <span className="grow">Put Restock on your home screen.</span>
          <button className="pwa-banner-btn" onClick={() => setHelping(true)}>
            How
          </button>
          <button
            className="pwa-banner-close"
            aria-label="Close"
            onClick={() => {
              setHint(false);
              try {
                localStorage.setItem(HINT_KEY, '1');
              } catch {
                // fine
              }
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {helping && <InstallSheet onClose={() => setHelping(false)} />}
    </>
  );
}

// 0.9.5 (web search): the Scan a barcode row that was here is now a Scan button next to the Shopping list's add box.
