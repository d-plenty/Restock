// 0.18.4: this phone's backup on the Restock server (lib/serverBackup.ts): on or off, when it last
// went up, Back up now; and, on a phone that joined to replace a lost one, putting its backup back.
import { useEffect, useId, useState } from 'react';
import { maybeServerBackup, restoreFromServer, serverBackupState, setServerBackupOn, skipRestore, type RestoreOffer, type ServerBackupState } from '../../lib/serverBackup';
import { deviceWord } from '../../lib/platform';
import { LoadingBar, Sheet, timeAgo } from '../components';
import { useNav } from '../nav';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const mb = (n?: number) => (n ? (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`) : '');

export function PhoneBackupCard() {
  const [st, setSt] = useState<ServerBackupState>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void serverBackupState().then(setSt);
  }, []);
  if (!st) return null;
  const line = st.problem === 'no-key'
    ? "Phone backups aren't turned on for this server yet: an admin turns them on in Server admin → Phone backups."
    : st.problem
      ? `The last one didn't go up: ${st.problem}`
      : st.at
        ? `Backed up ${timeAgo(st.at)}${st.size ? ` (${mb(st.size)})` : ''}`
        : 'Not backed up yet';
  return (
    <div className="card" style={{ gap: 8 }}>
      <label className="row" style={{ padding: 0 }}>
        <span className="grow">
          <span className="title" style={{ fontSize: 15 }}>
            Keep a backup on the server
          </span>
          <span className="small">{st.on ? line : 'Off'}</span>
        </span>
        <input
          type="checkbox"
          className="switch"
          checked={st.on}
          onChange={(e) => {
            const on = e.target.checked;
            void setServerBackupOn(on).then(() => (on ? maybeServerBackup(true) : serverBackupState()).then(setSt));
          }}
        />
      </label>
      <span className="small">
        Once a day: this {deviceWord()}'s settings, look, shops, every tab, cards and receipts (not their photos), so a new one can have it all back. Locked so only the server's passphrase opens it.
      </span>
      {st.on && (
        <button
          className="btn small"
          style={{ alignSelf: 'flex-start' }}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void maybeServerBackup(true)
              .then(setSt)
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Backing up…' : 'Back up now'}
        </button>
      )}
      {busy && <LoadingBar seconds={6} />}
    </div>
  );
}

/** After joining with a code that replaces a lost phone: put its backup back (with the server's passphrase), or not. */
export function RestoreOfferSheet({ offer, onDone }: { offer: RestoreOffer; onDone: (restored: boolean) => void }) {
  const nav = useNav();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  const who = offer.label ?? 'the lost phone';
  const skip = () => {
    void skipRestore().catch(() => undefined);
    onDone(false);
  };
  return (
    <Sheet title={`Put back ${who}'s backup?`} onClose={skip}>
      {offer.backup ? (
        <form
          className="card"
          style={{ gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!pass || busy) return;
            setBusy(true);
            setError(undefined);
            restoreFromServer(offer, pass)
              .then(() => {
                nav.toast(`Everything's back from ${who}'s backup.`);
                onDone(true);
              })
              .catch((err: unknown) => setError(errText(err)))
              .finally(() => setBusy(false));
          }}
        >
          <span className="small">
            From {offer.backup.at ? timeAgo(offer.backup.at) : 'earlier'}: its settings, look, shops, every tab, cards and receipts. The shopping list is the household's as it is now. {who} then comes off the server.
          </span>
          <label htmlFor={id} className="small">
            The server's passphrase
          </label>
          <input id={id} className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
          {busy && <LoadingBar seconds={8} />}
          {error && (
            <div className="banner amber" role="alert">
              {error}
            </div>
          )}
          <button className="btn primary block" type="submit" disabled={!pass || busy}>
            {busy ? 'Putting it back…' : 'Put it back'}
          </button>
          <button className="btn block" type="button" onClick={skip} disabled={busy}>
            Not now
          </button>
        </form>
      ) : (
        <div className="card" style={{ gap: 10 }}>
          <span className="small">{who} didn't keep a backup on the server, so what it shared with the household comes back by itself, and nothing else.</span>
          <button className="btn primary block" onClick={skip}>
            OK
          </button>
        </div>
      )}
    </Sheet>
  );
}
