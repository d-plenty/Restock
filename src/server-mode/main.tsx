// Server mode's start: sign in, set the passphrase, link once, then the real Restock app on the
// browser's own copy of the household.
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../ui/App';
import { setDatabaseOpener } from '../lib/boot';
import { api, ApiError, whenSignedOut } from './api';
import { deleteLocalCopy, openServerDatabase, start, stop, syncNow, syncStatus } from './live';
import { canChangeVault, forget, recall, session, type Session } from './session';
import { Checking, LinkScreen, LoginScreen, SetPassphraseScreen } from './ui/Gate';
import { AddPhonePanel, ServerStrip, ServerTab, serverScreen } from './ui/ServerScreens';
import { serverUi } from './flag';
import './server.css';

serverUi.current = {
  Strip: ServerStrip,
  Tab: ServerTab,
  screen: serverScreen,
  refresh: async () => {
    const r = await syncNow();
    if (!r) return syncStatus().error ?? "Couldn't reach the server";
    return r.received ? `Got ${r.received} change${r.received === 1 ? '' : 's'} from your phones` : 'Up to date with your phones';
  },
};

type Stage = { at: 'checking' } | { at: 'offline'; why: string } | { at: 'login' } | { at: 'setup'; user: string } | { at: 'link' } | { at: 'app'; s: Session };

const hasKeys = (s: Session | undefined) => !!s && Object.keys(s.keys).length > 0;

function ServerRoot() {
  const [stage, setStage] = useState<Stage>({ at: 'checking' });

  const check = useCallback(async () => {
    setStage({ at: 'checking' });
    try {
      const web = await api.web();
      if (web.mustChange) return setStage({ at: 'setup', user: web.user ?? 'admin' });
      const s = recall();
      if (s && web.webId && s.webId === web.webId && hasKeys(s)) return setStage({ at: 'app', s });
      if (s && web.webId && s.webId === web.webId && canChangeVault()) return setStage({ at: 'link' });
      forget();
      setStage({ at: 'login' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        forget();
        return setStage({ at: 'login' });
      }
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

  const opened = (s: Session) => setStage(hasKeys(s) ? { at: 'app', s } : canChangeVault() ? { at: 'link' } : { at: 'login' });

  useEffect(() => {
    document.documentElement.classList.add('server-mode');
  }, []);

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
    case 'app':
      return <Household key={stage.s.webId} s={stage.s} />;
  }
}

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
    return () => stop();
  }, [s]);
  return ready ? <App /> : null;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServerRoot />
  </StrictMode>,
);
