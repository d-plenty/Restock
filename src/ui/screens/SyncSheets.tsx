// 0.15.0: Sync and backups' other sheets (moved out of Sync.tsx): the recovery key, taking over as
// owner, a member, and a household folder on Nextcloud or WebDAV.
import { useEffect, useState } from 'react';
import { scanBarcode } from '../../lib/barcode';
import { confirmAction } from '../../lib/confirm';
import { RestockNative } from '../../lib/sql/native';
import { syncAvailable, type SyncInfo } from '../../lib/sync';
import { Icon, LoadingBar, Sheet, More } from '../components';
import { useNav } from '../nav';
import { PairingQr } from './SyncCodes';
import { errText } from './Sync';

/** Owner: the household's recovery key, to write down or keep in a password manager. */
export function RecoverySheet({ saved, onClose, onDone }: { saved: boolean; onClose: () => void; onDone: (info: SyncInfo, msg?: string) => void }) {
  const nav = useNav();
  const [key, setKey] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    RestockNative.syncRecovery().then(
      (r) => setKey(r.key),
      (e) => setError(errText(e) === 'Not unlocked' ? 'Unlock the phone to see the recovery key.' : errText(e)),
    );
  }, []);
  const copy = async () => {
    if (!key) return;
    try {
      // 0.9.0: on the phone, marked sensitive (kept out of the clipboard preview and keyboards' history).
      await (syncAvailable() ? RestockNative.copyText({ text: key, sensitive: true }) : navigator.clipboard.writeText(key));
      nav.toast('Recovery key copied');
    } catch {
      nav.toast("Couldn't copy it. Write it down instead.");
    }
  };
  const fresh = async () => {
    const ok = await confirmAction('Make a new recovery key?', {
      detail: 'The one you have now stops working. Save the new one straight away.',
      action: 'Make a new one',
    });
    if (!ok) return;
    try {
      onDone(await RestockNative.syncRecoverySaved({ fresh: true }));
      setKey((await RestockNative.syncRecovery()).key);
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Sheet title="Recovery key" onClose={onClose}>
      <p className="small">With this key, another phone can take over as owner if this one is lost. Keep it somewhere safe that isn't this phone.{' '}<More title="Recovery key"><p>If this phone is lost, broken or wiped, another phone in the household can take over as the owner with this key, and then add and remove
        phones again. Keep it somewhere safe that isn't this phone: a password manager, or written down at home.</p></More></p>
      <div className="banner amber" style={{ gap: 4 }}>
        <strong>Keep it private</strong>
        <span style={{ fontSize: 13 }}>Anyone with it and a phone in your household can take the household over.</span>
      </div>
      {error && <div className="banner amber">{error}</div>}
      {key ? (
        <>
          <code className="recovery-key" aria-label="Recovery key">
            {key}
          </code>
          <details className="sync-code">
            <summary className="small">Show it as a QR code</summary>
            <PairingQr code={`RESTOCK-RECOVERY:${key}`} label="Recovery key QR code" />
          </details>
          <button className="btn" onClick={() => void copy()}>
            Copy
          </button>
          <button
            className="btn primary"
            onClick={() =>
              void RestockNative.syncRecoverySaved({ key }).then(
                (i) => onDone(i, saved ? undefined : 'Recovery key saved'),
                (e) => setError(errText(e)),
              )
            }
          >
            <Icon name="check" size={18} /> {saved ? 'Done' : "I've saved it"}
          </button>
          <button className="btn ghost small" onClick={() => void fresh()}>
            Make a new recovery key
          </button>
        </>
      ) : (
        !error && <LoadingBar seconds={2} />
      )}
    </Sheet>
  );
}

/** Another phone: take over as the owner with the recovery key (the owner phone was lost). */
export function TakeOverSheet({ ownerName, onClose, onDone }: { ownerName?: string; onClose: () => void; onDone: (info: SyncInfo) => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    const out = await scanBarcode('Scan the recovery key', {
      accept: (t: string) => (/^RESTOCK-RECOVERY:/i.test(t.trim()) ? t.trim() : undefined),
      qr: true,
      wrong: "That isn't a Restock recovery key.",
      typeHint: 'Or type it',
    });
    if (out.ok) setKey(out.code.replace(/^RESTOCK-RECOVERY:/i, ''));
  };
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await RestockNative.syncTakeOver({ key }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Take over as the owner" onClose={onClose}>
      <p className="small">For when the owner phone{ownerName ? ` (${ownerName})` : ''} is lost. Enter the recovery key and this phone becomes the owner.{' '}<More title="Taking over as owner"><p>For when the owner phone{ownerName ? ` (${ownerName})` : ''} is lost, broken or wiped. Enter the household's recovery key and this phone
        becomes the owner: it can add and remove phones. Then remove the lost phone, so it can't sync again.</p></More></p>
      <p className="small">Every phone in the household needs Restock 0.9.0 or newer to see the change.</p>
      <label className="field">
        <span>Recovery key</span>
        <input
          className="input"
          value={key}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="ABCD-EFGH-…"
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <button className="btn" onClick={() => void scan()}>
        <Icon name="scan" size={18} /> Scan its QR code
      </button>
      {error && <div className="banner amber">{error}</div>}
      <button className="btn primary" disabled={busy || key.replace(/[^a-z0-9]/gi, '').length < 32} onClick={() => void go()}>
        {busy ? 'Taking over…' : 'Take over'}
      </button>
    </Sheet>
  );
}

/** What the owner can do with another phone. */
export function MemberSheet({
  member,
  server,
  onClose,
  onDone,
}: {
  member: { device: string; name: string };
  /** 0.9.2: this phone uses a Restock server. */
  server?: boolean;
  onClose: () => void;
  onDone: (info: SyncInfo, msg: string) => void;
}) {
  const [error, setError] = useState<string>();
  const run = async (what: 'remove' | 'owner') => {
    const ok = await confirmAction(what === 'remove' ? `Remove ${member.name} from the household?` : `Make ${member.name} the owner?`, {
      detail:
        what === 'remove'
          ? "It stops syncing straight away, and the household's key changes so it can't sync again, even with an old code. It keeps what it has now. The other phones get the new key next time they sync with this one." +
            (server ? " It can't open anything new on your Restock server either; to take it off the server's list too, remove it on the server's Phones page." : '')
          : 'It will be the one that adds and removes phones, and this phone becomes an ordinary member. That happens when the two phones next sync; until then this phone stays the owner, and you can cancel.',
      action: what === 'remove' ? 'Remove' : 'Make owner',
      danger: what === 'remove',
    });
    if (!ok) return;
    try {
      const info =
        what === 'remove' ? await RestockNative.syncRemove({ device: member.device }) : await RestockNative.syncHandOver({ device: member.device });
      onDone(info, what === 'remove' ? `${member.name} removed` : `${member.name} takes over as owner at the next sync`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Sheet title={member.name} onClose={onClose}>
      <div className="card flush">
        <button className="row" onClick={() => void run('owner')}>
          <Icon name="star" size={18} />
          <span className="grow">
            <span className="title">Make this the owner phone</span>
            <span className="small">For when this phone is being replaced, or someone else looks after the household.</span>
          </span>
        </button>
        <button className="row" onClick={() => void run('remove')}>
          <Icon name="trash" size={18} />
          <span className="grow">
            <span className="title" style={{ color: 'var(--red-ink)' }}>
              Remove from the household
            </span>
            <span className="small">A lost, sold or old phone.</span>
          </span>
        </button>
      </div>
      {error && <div className="banner amber">{error}</div>}
    </Sheet>
  );
}

/** The three ways to sync away from home. */
export function AwayChoices({ disabled, onPick }: { disabled?: boolean; onPick: (kind: 'nextcloud' | 'webdav' | 'folder') => void }) {
  return (
    <div className="card flush">
      <button className="row" disabled={disabled} onClick={() => onPick('nextcloud')}>
        <Icon name="external" size={18} />
        <span className="grow">
          <span className="title" style={{ fontSize: 15 }}>
            Sign in to Nextcloud
          </span>
          <span className="small">Your own Nextcloud, or one from a provider. Restock gets a password of its own.</span>
        </span>
        <Icon name="chevron" size={18} />
      </button>
      <button className="row" disabled={disabled} onClick={() => onPick('webdav')}>
        <Icon name="box" size={18} />
        <span className="grow">
          <span className="title" style={{ fontSize: 15 }}>
            Other WebDAV server
          </span>
          <span className="small">ownCloud, Synology, QNAP, TrueNAS, Koofr, pCloud, kDrive, Box and others.</span>
        </span>
        <Icon name="chevron" size={18} />
      </button>
      <button className="row" disabled={disabled} onClick={() => onPick('folder')}>
        <Icon name="folder" size={18} />
        <span className="grow">
          <span className="title" style={{ fontSize: 15 }}>
            Pick a folder on this phone
          </span>
          <span className="small">One that Syncthing (or a similar app) keeps the same on every phone.</span>
        </span>
        <Icon name="chevron" size={18} />
      </button>
    </div>
  );
}

/** The folder name field, the same for Nextcloud and other servers. */
function FolderField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>Folder for Restock</span>
      <input className="input" value={value} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/**
 * "Sign in to Nextcloud" (Nextcloud's Login Flow v2): Restock opens the sign-in page in the
 * browser, the person signs in there and allows Restock, and Nextcloud gives Restock an app
 * password of its own.
 */
export function NextcloudSheet({ onClose, onDone }: { onClose: () => void; onDone: (info: SyncInfo) => void }) {
  const [server, setServer] = useState('');
  const [folder, setFolder] = useState('Restock');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const go = async () => {
    setError(undefined);
    setWaiting(true);
    try {
      const r = await RestockNative.syncNextcloud({ server: server.trim(), folder: folder.trim() });
      if (r.cancelled) setWaiting(false);
      else onDone(r);
    } catch (e) {
      setError(errText(e));
      setWaiting(false);
    }
  };
  const cancel = () => void RestockNative.syncNextcloudCancel().catch(() => undefined);
  return (
    <Sheet
      title="Sign in to Nextcloud"
      onClose={() => {
        if (waiting) cancel();
        onClose();
      }}
    >
      {waiting ? (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <strong>Finish signing in in your browser</strong>
          <span className="small">Sign in to your Nextcloud there and tap Grant access. Then come back to Restock; it carries on by itself.</span>
          <LoadingBar seconds={60} />
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <p className="small" style={{ margin: 0 }}>You sign in on Nextcloud's own page. Your password never reaches Restock.{' '}<More title="Signing in to Nextcloud"><p>Restock opens your Nextcloud's sign-in page in your browser. Nextcloud then gives Restock a password of its own, so your own password
            never reaches Restock. You can take it away any time in Nextcloud's settings, under Security.</p></More></p>
          <label className="field">
            <span>Your Nextcloud's address</span>
            <input
              className="input"
              value={server}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="cloud.example.com"
              onChange={(e) => setServer(e.target.value)}
            />
          </label>
          <FolderField value={folder} onChange={setFolder} />
          <p className="small" style={{ marginTop: -4 }}>Every phone in the household needs the same folder.{' '}<More title="The Nextcloud folder"><p>Made if it isn't there. Every phone in the household needs the same folder: sign in with the same Nextcloud account, or share the folder
            with each other in Nextcloud.</p></More></p>
          {error && (
            <div className="banner amber" role="alert">
              {error}
            </div>
          )}
          <button className="btn primary" disabled={!server.trim()} onClick={() => void go()}>
            <Icon name="external" size={18} /> Sign in
          </button>
        </>
      )}
    </Sheet>
  );
}

/** Other WebDAV servers: an address, a user name and a password. */
export function WebDavSheet({ onClose, onDone }: { onClose: () => void; onDone: (info: SyncInfo) => void }) {
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [folder, setFolder] = useState('Restock');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = async () => {
    setError(undefined);
    setBusy(true);
    try {
      onDone(await RestockNative.syncSetWebDav({ url: url.trim(), user: user.trim(), password, folder: folder.trim() }));
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title="Other WebDAV server" onClose={busy ? () => undefined : onClose}>
      <p className="small" style={{ margin: 0 }}>For ownCloud, Synology, QNAP, TrueNAS and other servers with WebDAV.{' '}<More title="WebDAV servers"><p>For ownCloud, Synology, QNAP, TrueNAS, Koofr, pCloud, kDrive, Box and other servers with WebDAV. Your server's or provider's help pages give
        its WebDAV address.</p></More></p>
      <label className="field">
        <span>WebDAV address</span>
        <input
          className="input"
          value={url}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://dav.example.com/"
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="field">
        <span>User name</span>
        <input
          className="input"
          value={user}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
          onChange={(e) => setUser(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Password</span>
        <input className="input" type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
      </label>
      <p className="small" style={{ marginTop: -4 }}>Many providers want an app password here. It stays on this phone only.{' '}<More title="The password"><p>Many providers want an app password here (you make one in their settings), not your main one. It stays on this phone only, locked away,
        and is never synced or put in a backup.</p></More></p>
      <FolderField value={folder} onChange={setFolder} />
      <p className="small" style={{ marginTop: -4 }}>
        Made if it isn't there. Use https:// unless the server is at home (like 192.168.1.20) or on Tailscale.
      </p>
      {error && (
        <div className="banner amber" role="alert">
          {error}
        </div>
      )}
      <button className="btn primary" disabled={busy || !url.trim() || !user.trim()} onClick={() => void go()}>
        {busy ? 'Checking the server…' : 'Connect'}
      </button>
      {busy && <LoadingBar seconds={10} />}
    </Sheet>
  );
}
