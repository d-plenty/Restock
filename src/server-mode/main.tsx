// Server mode's start: sign in, set the passphrase, link once, then the real Restock app on the
// browser's own copy of the household.
// 0.9.4: first ask the server what it is (GET /api/v3/health). A house (v3) signs in with a
// challenge and needs no passphrase vault or link; a fresh one asks to Set up this server first. A
// 0.9.3 server, or a 0.9.4 one still in v2 mode, gets the 0.9.3 flow as it was.
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../ui/App';
import { setDatabaseOpener } from '../lib/boot';
import { api, api3, ApiError, isV3, probeServer, serverInfo, whenSignedOut } from './api';
import { deleteLocalCopy, openServerDatabase, serverHistory, start, stop, syncNow, syncStatus } from './live';
import { canChangeVault, forget, recall, session, type Session } from './session';
import { startOn } from './ui/deskShared';
import { Checking, LinkScreen, LoginScreen, ReleasedScreen, SetPassphraseScreen, SetUpServerScreen } from './ui/Gate';
import { AddPhonePanel, ServerTab, serverScreen } from './ui/ServerScreens';
import { PhoneChrome, SearchNeedsSignal } from './ui/PhoneLayout';
import { copyKeyStore, keptHistory } from './pwa/offlineData';
import { Desktop } from './ui/Desktop';
import { serverUi } from './flag';
import { atSignIn, noteServer, offlineNow, openOffline, signedOut, startPwa, watchCopy } from './pwa/boot';
// 0.9.5 (web search): Let the web page search the shops; the Scan button sits by the add box now.
import { setBarcodeSearch } from './pwa/scan';
import { webSearchUi } from './ui/WebShopSearch';
import { barcodeSearch } from './ui/webSearch';
import { useNetworkWatch } from './pwa/offline';
import { askAboutOtherCards } from './cardStore'; // 0.9.6 (review M2)
import { askChoice } from '../lib/confirm';
import './server.css';

// 0.9.5: the home screen web app (service worker, offline list, notices). 0.9.5 (web search): the
// Scan a barcode button moved next to the Shopping list's add box (List.tsx, DeskList.tsx).
startPwa();
// 0.9.5 (web search): a scanned barcode no household product has searches the shops, when that's on.
setBarcodeSearch((code, section) => barcodeSearch(code, section));
// 0.9.6 (iPhone): the phone layout: the phone's tab bar (with More) and the notices, in place of
// 0.9.5's navy strip (ui/PhoneLayout.tsx).
// 0.9.6 (offline): shop search needs signal; an item's older prices are kept for offline.
const searchOffline = () => offlineNow();
const webSearch: typeof webSearchUi = {
  ...webSearchUi,
  PickButton: (p) => (searchOffline() ? <SearchNeedsSignal /> : <webSearchUi.PickButton {...p} />),
  ListButton: (p) => (searchOffline() && p.text.trim() ? <SearchNeedsSignal /> : <webSearchUi.ListButton {...p} />),
  ListPanel: (p) => (searchOffline() ? null : <webSearchUi.ListPanel {...p} />),
};
const olderPrices = keptHistory(
  serverHistory,
  () => {
    const s = session();
    // Not for a tab signed in with a phone: its copy is memory only.
    return s && !s.viaPhone ? copyKeyStore(s.webId) : undefined;
  },
  offlineNow,
);

serverUi.current = {
  Strip: PhoneChrome,
  Tab: ServerTab,
  screen: serverScreen,
  // 0.9.3: the desktop layout, from 1000 px wide.
  Desktop,
  // 0.9.4: the full item page shows the server's older prices too (as the desktop side panel does).
  olderPrices,
  // 0.9.5 (web search): the Pick sheet's and the phone layout's list's shop search, and its Scan button.
  webSearch,
  refresh: async () => {
    const r = await syncNow();
    if (!r) return syncStatus().error ?? "Couldn't reach the server";
    return r.received ? `Got ${r.received} change${r.received === 1 ? '' : 's'} from your phones` : 'Up to date with your phones';
  },
};

type Stage =
  | { at: 'checking' }
  | { at: 'offline'; why: string }
  | { at: 'login' }
  | { at: 'setup'; user: string }
  | { at: 'link' }
  | { at: 'house'; s: Session }
  | { at: 'released' }
  | { at: 'app'; s: Session };

const hasKeys = (s: Session | undefined) => !!s && Object.keys(s.keys).length > 0;

function ServerRoot() {
  const [stage, setStage] = useState<Stage>({ at: 'checking' });

  const check = useCallback(async () => {
    setStage({ at: 'checking' });
    try {
      const info = await probeServer();
      noteServer(info);
      if (isV3()) {
        if (info.mode === 'released') return setStage({ at: 'released' });
        const s = recall();
        if (s?.v !== 3) {
          forget();
          return setStage({ at: 'login' });
        }
        // Still signed in? (A 401 here goes to the sign-in page.)
        const g = await api3.session();
        if (g === null) await api3.settings();
        if (info.mode === 'new' && !hasKeys(s)) return setStage({ at: 'house', s });
        return setStage({ at: 'app', s });
      }
      const web = await api.web();
      if (web.mustChange) return setStage({ at: 'setup', user: web.user ?? 'admin' });
      const s = recall();
      if (s?.v === 3) forget();
      else if (s && web.webId && s.webId === web.webId && hasKeys(s)) return setStage({ at: 'app', s });
      if (s && web.webId && s.webId === web.webId && canChangeVault()) return setStage({ at: 'link' });
      forget();
      setStage({ at: 'login' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        forget();
        return setStage({ at: 'login' });
      }
      // 0.9.5: no connection, but this browser has the kept session's own copy: open it offline.
      const off = await openOffline(e);
      if (off) return setStage({ at: 'app', s: off });
      setStage({ at: 'offline', why: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void check();
    whenSignedOut(() => {
      const s = session();
      stop();
      forget();
      if (s) void deleteLocalCopy(s.webId);
      signedOut();
      setStage({ at: 'login' });
    });
    // A new passphrase means a new web id, and so a fresh copy under it.
    const changed = () => {
      const s = session();
      if (s && hasKeys(s)) setStage({ at: 'app', s: { ...s } });
    };
    window.addEventListener('restock-server-session', changed);
    return () => window.removeEventListener('restock-server-session', changed);
  }, [check]);

  const opened = (s: Session) => {
    if (s.v === 3) {
      // A fresh server with no house yet: Set up this server first.
      if (serverInfo()?.mode === 'new' && !hasKeys(s)) return setStage({ at: 'house', s });
      return setStage({ at: 'app', s });
    }
    setStage(hasKeys(s) ? { at: 'app', s } : canChangeVault() ? { at: 'link' } : { at: 'login' });
  };

  useEffect(() => {
    document.documentElement.classList.add('server-mode');
  }, []);
  // 0.9.5: at a house's sign-in page, a copy left by a session that's gone is deleted.
  useEffect(() => {
    if (stage.at === 'login' && isV3()) void atSignIn();
  }, [stage.at]);

  switch (stage.at) {
    case 'checking':
      return <Checking />;
    case 'offline':
      return <Checking error={stage.why} onRetry={() => void check()} />;
    case 'login':
      return <LoginScreen onDone={opened} onSetup={(user) => setStage({ at: 'setup', user })} />;
    case 'setup':
      return <SetPassphraseScreen user={stage.user} onDone={opened} />;
    case 'link':
      return <LinkScreen onDone={opened} addPhone={<AddPhonePanel />} />;
    case 'house':
      return (
        <SetUpServerScreen
          session={stage.s}
          onDone={(s) => {
            const i = serverInfo();
            if (i) i.mode = 'v3';
            // Next: add the first phone, on Server and phones.
            startOn('add-phone');
            setStage({ at: 'app', s });
          }}
        />
      );
    case 'released':
      return <ReleasedScreen />;
    case 'app':
      return <Household key={stage.s.webId} s={stage.s} />;
  }
}

const sync = () => void syncNow();

/** The real app, on this web id's copy. */
function Household({ s }: { s: Session }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let previous: string | undefined;
    try {
      previous = localStorage.getItem('restock-server-webid') ?? undefined;
      localStorage.setItem('restock-server-webid', s.webId);
    } catch {
      // fine
    }
    // The copy under an old web id (before a new passphrase) isn't needed any more.
    if (previous && previous !== s.webId) void deleteLocalCopy(previous);
    setDatabaseOpener(async () => {
      await openServerDatabase(s);
      start();
    });
    setReady(true);
    // 0.9.6 (review M2): cards this browser keeps from a sign-in to another household or server
    // are never shown here; ask once per sign-in whether to keep them (after the page is up).
    const asking = setTimeout(() => void askAboutOtherCards(askChoice, s).catch(() => undefined), 1500);
    // 0.9.5: when the list last came from the server (for the offline notice).
    const unwatch = s.viaPhone ? undefined : watchCopy(s.webId);
    return () => {
      clearTimeout(asking);
      unwatch?.();
      stop();
    };
  }, [s]);
  // 0.9.5: back online, a round straight away.
  useNetworkWatch(sync);
  return ready ? <App /> : null;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServerRoot />
  </StrictMode>,
);
