// Server mode: what the web app adds to (and puts in place of) the phone app's screens: the
// server's own pages (Your server, Server and phones, Your data, Activity, Account), the
// household's settings, and a plain note where a phone-only screen would be.
// 0.15.0: only a house (v3); the 0.9.3 household's pages are gone.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { TopBar } from '../../ui/components';
import { type Screen } from '../../ui/nav';
import { deleteLocalCopy, onStatus, syncNow, syncStatus, unsentChanges } from '../live';
import { askChoice, askSignOutUnsent } from '../../lib/confirm';
import { askKeepCards, thisBrowserCards } from '../cardStore';
import { DeskCards } from './DeskCards';
import { session } from '../session';
import { ActivityLogs } from './DeskActivity';
import { DeskData } from './DeskData';
import { DeskDataManage } from './DeskDataManage';
import { PassphraseV3, SignOutChoices } from './DeskHouseSettings';
import { ServerAndPhones } from './DeskServer';
import { DeskSettings, Line } from './DeskSettings';
import { ServerHomeAssistant } from './ServerHomeAssistant';
import { AddOnServer, PhoneOnlyScreen } from './PhoneOnly';
import { MorePage, OnlineOnly, YourServerPage } from './PhoneLayout';
import '../desk.css'; // the server's own pages (dk- styles)

export const useStatus = () => useSyncExternalStore(onStatus, syncStatus);

/** Ticks every 20 s, so "2 min ago" moves on by itself. */
export function useNow(ms = 20_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** The Add tab on a server. */
export function ServerTab() {
  return <AddOnServer />;
}

/** In place of the phone app's screen, on a server (undefined: the usual screen). */
export function serverScreen(top: Screen): ReactNode | undefined {
  switch (top.name) {
    case 'server':
      // 0.9.6 (iPhone): More, the phone layout's last tab; the server's own pages need signal.
      if (top.page === 'more') return <MorePage />;
      if (top.page === 'data')
        return (
          <OnlineOnly title="Your data" page="data">
            <DeskData narrow />
          </OnlineOnly>
        );
      if (top.page === 'data-manage')
        return (
          <OnlineOnly title="Manage data" page="data-manage">
            <DeskDataManage narrow />
          </OnlineOnly>
        );
      if (top.page === 'phones')
        return (
          <OnlineOnly title="Server and phones" page="phones">
            <ServerAndPhones narrow />
          </OnlineOnly>
        );
      if (top.page === 'activity')
        return (
          <OnlineOnly title="Activity" page="activity">
            <ActivityLogs narrow />
          </OnlineOnly>
        );
      if (top.page === 'account') return <AccountPage />;
      return <YourServerPage />;
    case 'settings':
    case 'household':
      return <DeskSettings narrow />;
    case 'homeAssistant':
      return <ServerHomeAssistant narrow />;
    case 'cards':
      // 0.9.6 (cards): the Cards tab, kept in this browser only (was the phones' loyalty cards, greyed).
      return <DeskCards back />;
    case 'add':
      return <AddOnServer back />;
    case 'stores':
      return <PhoneOnlyScreen title="Shops" />;
    // 0.12.2: Your shops and each shop's catalogue are the phone's own screens here too (they show what the phones shared)
    case 'sync':
      return <PhoneOnlyScreen title="Local sync" text="Do this on a phone: phones pair with each other on the Wi-Fi. Add phones to this server on the Phones page." />;
    case 'permissions':
    case 'setup':
      return <PhoneOnlyScreen title="Setup" text="Do this on a phone: notifications, widgets, shop sign-ins and the camera belong to the phone." />;
    case 'diagnostics':
    case 'soon':
      return <PhoneOnlyScreen title="On your phones" text="Do this on a phone." />;
    case 'receipt':
      return top.id ? undefined : <PhoneOnlyScreen title="Add a receipt" text="Do this on a phone: take the photo there, and it comes here when your household shares receipts." />;
    default:
      return undefined;
  }
}

// ---------- Account ----------

/** Signs out, then takes this browser's copy away and starts again at the sign-in page. */
export async function leave(how: () => Promise<void>) {
  const id = session()?.webId;
  // 0.9.5 (review): changes made here that no round has sent yet (offline, say) go with the copy.
  // One more try to send them first; still not sent, ask (Stay signed in · Sign out).
  if (unsentChanges() > 0) await syncNow().catch(() => undefined);
  if (unsentChanges() > 0 && !(await askSignOutUnsent())) return;
  // 0.9.6 (cards): cards kept in this browser only: "Keep your cards on this phone/browser?"
  // 0.9.6 (review M2): this server's and household's own cards (taken before the session goes).
  const mine = thisBrowserCards();
  const cards = await askKeepCards(askChoice, mine);
  if (cards === 'stay') return;
  try {
    await how();
  } finally {
    if (id) await deleteLocalCopy(id);
    if (cards === 'remove') await mine.removeAll().catch(() => undefined);
    location.reload();
  }
}

function AccountPage() {
  const s = session();
  const [changing, setChanging] = useState(false);
  const [msg, setMsg] = useState<string>();
  return (
    <div className="screen house-narrow">
      <TopBar title="Signing in" />
      <div className="card">
        <span className="small">Signed in as</span>
        <span className="title">{s?.user ?? 'admin'}</span>
        {s?.viaPhone && <span className="small">With a phone: this tab can see the house for 12 hours, or until it's closed.</span>}
      </div>
      <div className="card flush dk-set-card">
        {!s?.viaPhone &&
          (changing ? (
            <PassphraseV3
              onCancel={() => setChanging(false)}
              onDone={(m) => {
                setChanging(false);
                setMsg(m);
              }}
            />
          ) : (
            <Line title="Passphrase" sub="Changing it signs every other browser out.">
              <button className="btn small" onClick={() => setChanging(true)}>
                Change
              </button>
            </Line>
          ))}
        {msg && (
          <p className="dk-set small" role="status">
            {msg}
          </p>
        )}
        <SignOutChoices Line={Line} />
      </div>
    </div>
  );
}

