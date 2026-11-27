// 0.18.3: the server's own web page, stripped back to looking after the server: Phones and admins,
// Data, and Server settings (no shopping list, pantry or shops: that's on the phones). It talks to
// the server's API only, and keeps no copy of the household in the browser, so it opens quickly.
// The opening animation plays as on the phones (This browser can turn it off).
import { useCallback, useEffect, useState } from 'react';
import { api3, ApiError, isV3, probeServer, serverInfo, whenSignedOut } from '../api';
import { forget, recall, type Session } from '../session';
import { holidayNow } from '../../lib/holiday';
import { Opening } from '../../ui/Opening';
import type { Settings } from '../../types';
import { isDarkNow, lessMotionNow, prefs, usePrefs } from './prefs';
import { PhoneYesHost } from './PhoneYes';
import { NameHousehold, SignIn } from './SignIn';
import { Shell, usePage, type PageId } from './Shell';
import { PhonesPage } from './PhonesPage';
import { DataPage } from './DataPage';
import { AddressesPage, BrowserPage, HomeAssistantPage, HouseholdPage, SecurityPage, UpkeepPage } from './SettingsPages';
import { errText, Loading, Toasts } from './ui';

type Stage = { at: 'checking' } | { at: 'offline'; why: string } | { at: 'old' } | { at: 'released' } | { at: 'login' } | { at: 'house'; s: Session } | { at: 'app'; s: Session };

const hasKeys = (s: Session | undefined) => !!s && Object.keys(s.keys).length > 0;

/** The opening's look from this browser's settings (holiday.ts reads the app's Settings shape). */
function openingLook(): Pick<Settings, 'look' | 'theme' | 'a11y'> {
  const p = prefs();
  return { theme: p.theme, look: { style: 'australia', icon: 'green', holidays: p.holidays }, a11y: { text: 1, contrast: false, motion: !p.motion, big: false } } as Pick<Settings, 'look' | 'theme' | 'a11y'>;
}

function useOpening(): [boolean, () => void] {
  const p = usePrefs();
  const [show, setShow] = useState(() => p.opening);
  useEffect(() => {
    const play = () => setShow(true);
    window.addEventListener('restock-play-opening', play);
    return () => window.removeEventListener('restock-play-opening', play);
  }, []);
  return [show, () => setShow(false)];
}

export function AdminRoot() {
  const [stage, setStage] = useState<Stage>({ at: 'checking' });
  const [opening, openingDone] = useOpening();

  const check = useCallback(async () => {
    setStage({ at: 'checking' });
    try {
      const info = await probeServer();
      if (!isV3()) return setStage({ at: 'old' });
      if (info.mode === 'released') return setStage({ at: 'released' });
      const s = recall();
      if (s?.v !== 3) {
        forget();
        return setStage({ at: 'login' });
      }
      // Still signed in? (A 401 goes to the sign-in.)
      await api3.session();
      if (info.mode === 'new' && !hasKeys(s)) return setStage({ at: 'house', s });
      setStage({ at: 'app', s });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        forget();
        return setStage({ at: 'login' });
      }
      setStage({ at: 'offline', why: errText(e) });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check();
    whenSignedOut(() => {
      forget();
      setStage({ at: 'login' });
    });
  }, [check]);

  const opened = useCallback((s: Session) => setStage(serverInfo()?.mode === 'new' && !hasKeys(s) ? { at: 'house', s } : { at: 'app', s }), []);

  return (
    <>
      {opening && <Opening holiday={holidayNow(openingLook())} look={isDarkNow() ? 'night' : 'day'} still={lessMotionNow()} onDone={openingDone} />}
      <Body stage={stage} onRetry={() => void check()} onOpened={opened} />
      <PhoneYesHost />
      <Toasts />
    </>
  );
}

function Body({ stage, onRetry, onOpened }: { stage: Stage; onRetry: () => void; onOpened: (s: Session) => void }) {
  switch (stage.at) {
    case 'checking':
      return (
        <div className="sv-gate">
          <div className="sv-card" style={{ width: 'min(360px, 100%)' }}>
            <p className="sv-small">Opening your server…</p>
            <Loading />
          </div>
        </div>
      );
    case 'offline':
      return (
        <Note title="Can't reach your Restock server" text={stage.why}>
          <button className="sv-btn primary" type="button" onClick={onRetry}>
            Try again
          </button>
        </Note>
      );
    case 'old':
      return <Note title="This server needs updating" text="It's on a version from before Restock 0.9.4. Update the server (pull the new image and restart it), then reload this page." />;
    case 'released':
      return <Note title="The household was taken back" text="A phone took the household back from this server. Start the server afresh from its setup page if you want to use it again." />;
    case 'login':
      return <SignIn onDone={onOpened} />;
    case 'house':
      return <NameHousehold session={stage.s} onDone={(s) => onOpened(s)} />;
    case 'app':
      return <App key={stage.s.sid} />;
  }
}

function Note({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="sv-gate">
      <main className="sv-card">
        <h1>{title}</h1>
        <p className="sv-small" style={{ fontSize: 15 }}>
          {text}
        </p>
        {children}
      </main>
    </div>
  );
}

const PAGES: Record<PageId, () => React.ReactElement> = {
  phones: PhonesPage,
  data: DataPage,
  household: HouseholdPage,
  addresses: AddressesPage,
  security: SecurityPage,
  ha: HomeAssistantPage,
  browser: BrowserPage,
  upkeep: UpkeepPage,
};

function App() {
  const [page, go] = usePage();
  const Page = PAGES[page];
  return (
    <Shell page={page} go={go}>
      <Page />
    </Shell>
  );
}
