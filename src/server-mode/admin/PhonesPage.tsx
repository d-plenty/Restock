// 0.18.3: Phones and admins. Every phone and tablet on the server: its role, when it last synced,
// what it shares and its Restock version, with Make admin or Make user, Rename and Remove; Add a
// phone or tablet (a code it scans, once, for 10 minutes, with both addresses in it); and Activity.
// The last admin phone can't be removed or made a user (the server says so too).
import { useEffect, useId, useState } from 'react';
import { api3, ApiError, type Activity, type Phone } from '../api';
import { confirmPassphrase, confirmWithVault, session } from '../session';
import { newBackupKey, openBackupKey, openPhoneBackup } from '../crypto';
import { isAdminAction, isTrouble, phoneName, sharesText, whatOf, whoOf } from '../ui/houseWords';
import { appTooOld } from '../../lib/minVersion';
import { ago, ask, bytes, Card, change, Dialog, errText, Icon, Loading, LoadError, PageHead, Qr, saveFile, Seg, sure, toast, useLoad } from './ui';

const active = (p: Phone) => !p.status || p.status === 'active';
/** When a code made now runs out. */
const inSeconds = (secs: number) => Date.now() + secs * 1000;
const viaPhone = () => !!session()?.viaPhone;

function sortPhones(list: Phone[]): Phone[] {
  return [...list].sort((a, b) => Number(active(b)) - Number(active(a)) || (active(a) ? phoneName(a).localeCompare(phoneName(b)) : (b.statusAt ?? '').localeCompare(a.statusAt ?? '')));
}

async function remove(p: Phone, reload: () => void) {
  if (!(await sure(`Remove ${phoneName(p)}?`, 'It stops syncing with the server, and the household gets a new key (the other phones take it by themselves). It keeps its own lists and prices.', 'Remove', true))) return;
  const pass = await ask({ title: 'Your passphrase', detail: `Removing ${phoneName(p)} needs the passphrase again.`, label: 'Passphrase', action: 'Remove', secret: true, danger: true });
  if (!pass) return;
  await change(async () => api3.removePhone(p.device, await confirmPassphrase(pass)), `${phoneName(p)} was removed`);
  reload();
}

/**
 * 0.18.4: a phone's backup, downloaded: the passphrase (it opens the phone backups' key, and a yes on
 * an admin phone may be asked for), then the file, opened here and saved as a Restock backup file. It
 * opens in Restock's Import data, on any phone. A password locks it, where this browser can.
 */
async function downloadBackup(p: Phone) {
  const pass = await ask({ title: `${phoneName(p)}'s backup`, detail: "The server's passphrase: it opens the phone backups, and is checked again.", label: 'Passphrase', action: 'Download', secret: true });
  if (!pass) return;
  const lockable = typeof crypto !== 'undefined' && !!crypto.subtle;
  const lock = lockable
    ? await ask({ title: 'Lock the file?', detail: 'A password for the file, so only someone with it can open it (Restock asks for it when importing). Leave it empty for no lock.', label: 'Password (optional)', action: 'Save the file', secret: true, optional: true })
    : '';
  if (lock === undefined) return;
  await change(async () => {
    const { confirm, vault } = await confirmWithVault(pass);
    try {
      const got = await api3.phoneBackup(p.device, confirm);
      const priv = openBackupKey(vault, got.sealedKey);
      const b = openPhoneBackup(priv, got.bytes);
      priv.fill(0);
      const text = lock ? await (await import('../../lib/backupLock')).lockBackup(b.json, lock) : b.json;
      const day = (b.at ?? new Date().toISOString()).slice(0, 10);
      saveFile(`restock-backup-${phoneName(p).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${day}.json`, text, 'application/json');
    } finally {
      vault.fill(0);
    }
  }, lock ? 'Saved, locked with your password' : 'Saved. Keep it private: it has everything on that phone.');
}

/** 0.18.4: turning phone backups on: a key made here, its private half sealed with the passphrase. */
async function turnOnBackups(reload: () => void) {
  const pass = await ask({ title: 'Turn on phone backups', detail: "The server's passphrase. Each phone's backup is locked with it: putting one back asks for it.", label: 'Passphrase', action: 'Turn on', secret: true });
  if (!pass) return;
  await change(async () => {
    const { confirm, vault } = await confirmWithVault(pass);
    try {
      await api3.putBackupKey(newBackupKey(vault), confirm);
    } finally {
      vault.fill(0);
    }
  }, 'Phone backups are on. Each phone backs up once a day while Restock is open on it.');
  reload();
}

export function PhonesPage() {
  const phones = useLoad(async () => sortPhones(await api3.phones()));
  const backupKey = useLoad(() => api3.backupKey());
  const [adding, setAdding] = useState(false);
  const list = phones.data ?? [];
  const on = list.filter(active);
  const admins = on.filter((p) => p.role === 'admin');
  const last = [...on].sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))[0];
  const onlyAdmin = (p: Phone) => p.role === 'admin' && admins.length === 1;

  return (
    <>
      <PageHead title="Phones and admins" sub="Every phone and tablet on this server. Admins add, remove and change phones, here or in Restock on their phone.">
        <button className="sv-btn primary" type="button" onClick={() => setAdding(true)}>
          <Icon name="plus" size={18} /> Add a phone or tablet
        </button>
      </PageHead>
      {phones.error && <LoadError error={phones.error} onRetry={phones.reload} />}
      <div className="sv-grid3">
        <div className="sv-card sv-stat">
          <b>{phones.data ? on.length : '…'}</b>
          <span>phones and tablets syncing</span>
        </div>
        <div className="sv-card sv-stat">
          <b>{phones.data ? admins.length : '…'}</b>
          <span>{admins.length === 1 ? 'admin' : 'admins'} (there's always at least one)</span>
        </div>
        <div className="sv-card sv-stat">
          <b>{last ? ago(last.lastSeen) : '…'}</b>
          <span>{last ? `last sync, from ${phoneName(last)}` : 'last sync'}</span>
        </div>
      </div>
      <div className="sv-card sv-tbl-wrap" style={{ padding: '8px 10px' }}>
        {!phones.data && !phones.error ? (
          <Loading label="Loading the phones" />
        ) : (
          <table className="sv-tbl">
            <thead>
              <tr>
                <th scope="col">Phone or tablet</th>
                <th scope="col">Role</th>
                <th scope="col">Last synced</th>
                <th scope="col">Shares</th>
                <th scope="col">
                  <span className="sv-skip">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <PhoneRow key={p.device} p={p} onlyAdmin={onlyAdmin(p)} reload={phones.reload} />
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={5} className="sv-small">
                    No phones yet. Add one with Add a phone or tablet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="sv-grid2">
        <ActivityCard phones={list} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title="Phone backups">
            {backupKey.data?.pub ? (
              <p className="sv-small">
                On{backupKey.data.at ? ` since ${new Date(backupKey.data.at).toLocaleDateString('en-AU')}` : ''}. Each phone keeps its whole backup here once a day, locked with the passphrase (the server can't read them). <b>Backup…</b> on a phone downloads it; to put a lost phone back, Add a phone or tablet → Replaces a lost phone.
              </p>
            ) : (
              <>
                <p className="sv-small">Off. Turned on, each phone keeps its whole backup here (settings, shops, every tab, cards, receipts), so a lost or broken one can be put back on a new one. They're locked with the passphrase: the server can't read them.</p>
                <button className="sv-btn primary" type="button" style={{ alignSelf: 'flex-start' }} disabled={viaPhone() || !backupKey.data} onClick={() => void turnOnBackups(backupKey.reload)}>
                  Turn on phone backups
                </button>
              </>
            )}
          </Card>
          <Card title="Adding a phone">
            <p className="sv-small">
              Add a phone or tablet shows a QR code it scans in Restock (Settings → Sync → Join a home server). It works once, for 10 minutes, and has both of the server's addresses in it.
            </p>
            <div className="sv-note">The last admin phone can't be removed or made a user, so there's always one to say yes and look after the phones.</div>
          </Card>
        </div>
      </div>
      {adding && (
        <AddPhone
          phones={on}
          onClose={() => {
            setAdding(false);
            phones.reload();
          }}
        />
      )}
    </>
  );
}

function PhoneRow({ p, onlyAdmin, reload }: { p: Phone; onlyAdmin: boolean; reload: () => void }) {
  const [now] = useState(() => Date.now());
  const isOn = active(p);
  const old = isOn && !!p.version && appTooOld(p.version);
  const stale = isOn && p.lastSeen && now - Date.parse(p.lastSeen) > 7 * 86400_000;
  const setRole = async (role: 'admin' | 'user') => {
    if (viaPhone()) return toast('Sign in with the passphrase to make admins.');
    if (role === 'admin' && !(await sure(`Make ${phoneName(p)} an admin?`, 'An admin adds and removes phones, says yes to sign-ins and risky changes, and changes Server settings.', 'Make admin'))) return;
    await change(() => api3.setRole(p.device, role), role === 'admin' ? `${phoneName(p)} is an admin now` : `${phoneName(p)} is a user now`);
    reload();
  };
  const rename = async () => {
    const name = await ask({ title: 'Rename', label: 'Name', value: phoneName(p), action: 'Save' });
    if (!name?.trim() || name.trim() === phoneName(p)) return;
    await change(() => api3.renamePhone(p.device, name.trim()));
    reload();
  };
  return (
    <tr>
      <td>
        <div className="sv-who">
          <span className="sv-dev">
            <Icon name={/ipad|tablet/i.test(phoneName(p) + ' ' + (p.name ?? '')) ? 'tablet' : 'phone'} />
          </span>
          <span>
            <b>
              {phoneName(p)}
              {p.me ? ' (this one)' : ''}
            </b>
            <span className="sv-small">{p.version ? `Restock ${p.version}` : 'Restock'}</span>
          </span>
        </div>
      </td>
      <td data-label="Role">{isOn ? <span className={`sv-tag ${p.role === 'admin' ? 'admin' : 'user'}`}>{p.role === 'admin' ? 'Admin' : 'User'}</span> : <span className="sv-tag user">{p.status === 'left' ? 'Left' : 'Removed'}</span>}</td>
      <td data-label="Last synced">
        {isOn ? <span className={`sv-tag ${old || stale ? 'warn' : 'ok'}`}>{old ? 'Needs updating' : ago(p.lastSeen)}</span> : <span className="sv-small">{ago(p.statusAt)}</span>}
        {p.backup?.at && <span className="sv-small" style={{ display: 'block' }}>Backup {ago(p.backup.at)} · {bytes(p.backup.size)}</span>}
      </td>
      <td data-label={isOn ? 'Shares' : undefined}>
        <span className="sv-small">{isOn ? sharesText(p).replace(/^Shares /, '') : ''}</span>
      </td>
      <td>
        {isOn && (
          <div className="sv-row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
            {p.role === 'admin' ? (
              <button className="sv-btn sm" type="button" disabled={onlyAdmin} title={onlyAdmin ? "It's the only admin phone" : undefined} onClick={() => void setRole('user')}>
                Make user
              </button>
            ) : (
              <button className="sv-btn sm" type="button" onClick={() => void setRole('admin')}>
                Make admin
              </button>
            )}
            <button className="sv-btn sm" type="button" onClick={() => void rename()}>
              Rename
            </button>
            {p.backup && (
              <button className="sv-btn sm" type="button" onClick={() => (viaPhone() ? toast('Sign in with the passphrase to download a backup.') : void downloadBackup(p))}>
                Backup…
              </button>
            )}
            <button
              className="sv-btn sm danger"
              type="button"
              disabled={onlyAdmin}
              title={onlyAdmin ? "It's the only admin phone" : undefined}
              onClick={() => (viaPhone() ? toast('Sign in with the passphrase to remove phones.') : void remove(p, reload))}
            >
              Remove
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

/** Add a phone or tablet: its name (and Make it an admin), then the code to scan. */
function AddPhone({ onClose, phones }: { onClose: () => void; phones: Phone[] }) {
  const [label, setLabel] = useState('');
  const [admin, setAdmin] = useState(false);
  // 0.18.4: a lost or broken phone this one replaces (its role, and its backup to put back).
  const [replaces, setReplaces] = useState('');
  const replacing = phones.find((p) => p.device === replaces);
  const [code, setCode] = useState<{ code: string; until: number }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ids = { name: useId(), admin: useId(), replaces: useId() };
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]);
  const left = code ? Math.max(0, Math.round((code.until - now) / 1000)) : 0;
  const make = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api3.addPhone(label.trim(), admin, replacing?.device);
      const secs = typeof r.expiresIn === 'number' ? r.expiresIn : 600;
      setCode({ code: r.code, until: inSeconds(secs) });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 && admin ? 'Sign in with the passphrase to add an admin.' : errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={code ? `Scan this on ${label.trim()}` : 'Add a phone or tablet'} onClose={onClose} wide={!!code}>
      {!code ? (
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) void make();
          }}
        >
          <div className="sv-field">
            <label htmlFor={ids.name}>Its name</label>
            <input id={ids.name} className="sv-input" value={label} maxLength={60} placeholder="Sarah's iPhone" onChange={(e) => setLabel(e.target.value)} />
          </div>
          {phones.length > 0 && (
            <div className="sv-field">
              <label htmlFor={ids.replaces}>Replaces a lost or broken phone</label>
              <select id={ids.replaces} className="sv-input" value={replaces} onChange={(e) => setReplaces(e.target.value)}>
                <option value="">No, it's a new one</option>
                {phones.map((p) => (
                  <option key={p.device} value={p.device}>
                    {phoneName(p)}
                    {p.backup ? '' : ' (no backup)'}
                  </option>
                ))}
              </select>
              {replacing && (
                <span className="sv-small">
                  It joins as {replacing.role === 'admin' ? 'an admin' : 'a user'}. {replacing.backup ? `It can put back ${phoneName(replacing)}'s backup with the passphrase` : `${phoneName(replacing)} has no backup here, so only what it shared comes back`}, and {phoneName(replacing)} then comes off the server.
                </span>
              )}
            </div>
          )}
          <div className="sv-row" hidden={!!replacing}>
            <input id={ids.admin} type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
            <label htmlFor={ids.admin} className="sv-grow">
              Make it an admin
              <span className="sv-small" style={{ display: 'block' }}>
                It can add and remove phones and say yes to sign-ins.
              </span>
            </label>
          </div>
          {error && (
            <p className="sv-error" role="alert">
              {error}
            </p>
          )}
          <div className="sv-actions">
            <button className="sv-btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="sv-btn primary" type="submit" disabled={busy || !label.trim()}>
              Make the code
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="sv-row wrap" style={{ alignItems: 'flex-start' }}>
            <Qr text={code.code} label={`Code for ${label.trim()} to scan`} />
            <ol className="sv-small sv-grow" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
              <li>On {label.trim()}: open Restock.</li>
              <li>A new phone: Join a home server on the first screen. One already set up: Settings → Sync → Join your server.</li>
              <li>Scan this code. It works once.</li>
            </ol>
          </div>
          <p className="sv-small" role="status">
            {left > 0 ? `Works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more` : 'This code has run out. Make a new one.'}
          </p>
          <details>
            <summary className="sv-small">Can't scan it? The code as text</summary>
            <p className="sv-code">{code.code}</p>
          </details>
          <div className="sv-actions">
            <button className="sv-btn" type="button" onClick={() => setCode(undefined)}>
              Another phone
            </button>
            <button className="sv-btn primary" type="button" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function ActivityCard({ phones }: { phones: Phone[] }) {
  const [which, setWhich] = useState<'all' | 'admin'>('admin');
  const [limit, setLimit] = useState(30);
  const act = useLoad(() => api3.activity(200));
  const rows: Activity[] = (act.data ?? []).filter((a) => which === 'all' || isAdminAction(a));
  return (
    <Card>
      <div className="sv-row wrap">
        <h2 className="sv-grow">Activity</h2>
        <Seg
          label="Which activity"
          value={which}
          onChange={setWhich}
          options={[
            { value: 'all', label: 'Everything' },
            { value: 'admin', label: 'Admin actions' },
          ]}
        />
      </div>
      {act.error && <LoadError error={act.error} onRetry={act.reload} />}
      {!act.data && !act.error && <Loading label="Loading activity" />}
      <ul className="sv-log">
        {rows.slice(0, limit).map((a, i) => (
          <li key={a.at + i} style={isTrouble(a) ? { color: 'var(--sv-red)' } : undefined}>
            <time dateTime={a.at}>{ago(a.at)}</time>
            <span className="sv-grow">
              <b>{whoOf(a, phones)}</b> {whatOf(a, phones)}
            </span>
          </li>
        ))}
        {act.data && rows.length === 0 && <li className="sv-small">Nothing yet.</li>}
      </ul>
      {rows.length > limit && (
        <button className="sv-btn sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setLimit((l) => l + 50)}>
          Show older
        </button>
      )}
    </Card>
  );
}
