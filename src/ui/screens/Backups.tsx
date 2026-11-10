import { useState } from 'react';
import { BACKUP_EVERY, BACKUP_KEEP, everyLabel, maybeAutoBackup } from '../../lib/autoBackup';
import { askPassword, confirmAction } from '../../lib/confirm';
import { getSettings, priceHistorySpan, updateSettings } from '../../lib/db';
import { useLive } from '../../lib/useLive';
import { RestockNative } from '../../lib/sql/native';
import { isNative } from '../../stores/http';
import type { Settings } from '../../types';
import { Icon, timeAgo } from '../components';
import { pricesIn } from './BackupParts';
import { LOCAL_SUGGESTED } from '../../lib/protection';
import { useNav } from '../nav';

/**
 * Automatic backups (off unless switched on): a whole backup saved into a folder the person
 * picks, when Restock is opened and the last one is older than they chose. The oldest automatic
 * backups are removed so only the newest few are kept.
 */
export function AutoBackupSettings({ settings, inSetup }: { settings: Settings; inSetup?: boolean }) {
  const nav = useNav();
  const b = settings.autoBackup;
  const [busy, setBusy] = useState(false);
  // 0.9.1: say how much price history goes in.
  const span = useLive(priceHistorySpan, []);
  const set = async (patch: Partial<Settings['autoBackup']>) => {
    const latest = await getSettings();
    return updateSettings({ autoBackup: { ...latest.autoBackup, ...patch } });
  };

  const pick = async (): Promise<boolean> => {
    if (!isNative()) {
      nav.toast('Picking a folder works in the Android app.');
      return false;
    }
    try {
      const f = await RestockNative.pickFolder();
      await set({ folder: f.uri, folderName: f.name, lastError: undefined });
      return true;
    } catch {
      return false;
    }
  };

  const toggle = async (on: boolean) => {
    if (on && !b.folder && !(await pick())) return;
    await set({ enabled: on });
    if (on) {
      const name = await maybeAutoBackup().catch(() => undefined);
      if (name) nav.toast(`First backup saved: ${name}`);
    }
  };

  // 0.9.0: lock automatic backups with a password.
  const setPassword = async () => {
    const pw = await askPassword(b.password ? 'New password for automatic backups' : 'Password for automatic backups', {
      detail: 'Use one you won’t forget: without it, these backups can’t be opened by anyone, including you. At least 8 characters.',
      action: 'Next',
    });
    if (!pw) return;
    if (pw.length < 8) return nav.toast('Use at least 8 characters.');
    const again = await askPassword('Type it again', { action: 'Lock automatic backups' });
    if (again === undefined) return;
    if (again !== pw) return nav.toast('Those didn’t match. Nothing changed.');
    await set({ password: pw });
    nav.toast('Automatic backups will be locked with your password');
  };
  const removePassword = async () => {
    const ok = await confirmAction('Stop locking automatic backups?', {
      detail: 'New automatic backups won’t need a password. The ones already saved still do.',
      action: 'Stop locking',
    });
    if (ok) await set({ password: undefined });
  };

  const now = async () => {
    setBusy(true);
    try {
      const name = await maybeAutoBackup(true);
      nav.toast(name ? `Saved ${name}` : 'Pick a folder first');
    } catch (e) {
      nav.toast(`Backup failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card flush">
      <label className="check">
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title" style={{ fontSize: 15 }}>
            Back up automatically
          </span>
          <span className="small">
            Saves a whole backup into a folder you choose (Nextcloud, Syncthing or a folder on this phone). {pricesIn(settings, span)}
            {inSetup ? ' Off unless you turn it on.' : ''}
          </span>
        </span>
        <input type="checkbox" className="switch" checked={b.enabled} onChange={(e) => void toggle(e.target.checked)} aria-label="Back up automatically" />
      </label>
      <button className="row" onClick={() => void pick()}>
        <span className="grow">
          <span className="title" style={{ fontSize: 15 }}>
            Folder
          </span>
          <span className="small">{b.folderName ?? 'Not picked yet'}</span>
        </span>
        <span className="small" style={{ fontWeight: 700 }}>
          {b.folder ? 'Change' : 'Pick'}
        </span>
      </button>
      <label className="check">
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title" style={{ fontSize: 15 }}>
            How often
          </span>
          <span className="small">When you open Restock and the last backup is older than this.</span>
        </span>
        <select
          className="input"
          style={{ width: 'auto', height: 38, padding: '0 8px', fontSize: 15 }}
          value={b.everyDays}
          aria-label="How often to back up"
          onChange={(e) => void set({ everyDays: parseInt(e.target.value, 10) })}
        >
          {BACKUP_EVERY.map((d) => (
            <option key={d} value={d}>
              {everyLabel(d)}
              {d === 7 ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title" style={{ fontSize: 15 }}>
            Keep the newest
          </span>
          <span className="small">Older automatic backups in the folder are removed. Your other files are never touched.</span>
        </span>
        <select
          className="input"
          style={{ width: 'auto', height: 38, padding: '0 8px', fontSize: 15 }}
          value={b.keep}
          aria-label="How many automatic backups to keep"
          onChange={(e) => void set({ keep: parseInt(e.target.value, 10) })}
        >
          {BACKUP_KEEP.map((k) => (
            <option key={k} value={k}>
              {k} backups{k === 5 ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      {settings.receipts.enabled && (
        <label className="check">
          <input type="checkbox" className="switch" checked={b.receiptPhotos !== false} onChange={(e) => void set({ receiptPhotos: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Include receipt photos
            </span>
            <span className="small">Restock's own photos of your receipts (not your phone's photos). Untick for smaller backups.</span>
          </span>
        </label>
      )}
      <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <span className="grow">
          <span className="title" style={{ fontSize: 15 }}>
            Lock with a password
          </span>
          <span className="small">
            {b.password
              ? 'On. Restoring one of these backups asks for the password. It’s kept on this phone only, never in a backup.'
              : 'Off. Worth turning on if the folder is in the cloud: backups hold your loyalty card numbers.'}
          </span>
        </span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button className="btn small" onClick={() => void setPassword()}>
            {b.password ? 'Change' : 'Set a password'}
          </button>
          {b.password && (
            <button className="btn small" onClick={() => void removePassword()}>
              Remove
            </button>
          )}
        </span>
      </div>
      {!inSetup && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className="grow" style={{ minWidth: 180 }}>
            <span className="small">{b.lastAt ? `Last backup ${timeAgo(b.lastAt)}` : 'No automatic backup yet'}</span>
            {b.lastError && (
              <span className="small" style={{ color: 'var(--red-ink)' }}>
                <Icon name="alert" size={13} /> Last try failed: {b.lastError}
              </span>
            )}
          </span>
          <button className="btn small" disabled={!b.folder || busy} onClick={() => void now()}>
            {busy ? 'Saving…' : 'Back up now'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 0.9.3: with only phone-to-phone sync or a Restock server keeping a copy, suggest a backup on
 * this phone as well: weekly, keeping the newest 4. One tap picks the folder and turns it on.
 */
export function SuggestLocalBackup({ text }: { text: string }) {
  const nav = useNav();
  const [busy, setBusy] = useState(false);
  const turnOn = async () => {
    if (!isNative()) return nav.toast('Picking a folder works in the Android app.');
    setBusy(true);
    try {
      let f: { uri: string; name: string };
      try {
        f = await RestockNative.pickFolder();
      } catch {
        return;
      }
      const latest = await getSettings();
      await updateSettings({
        autoBackup: { ...latest.autoBackup, folder: f.uri, folderName: f.name, lastError: undefined, enabled: true, ...LOCAL_SUGGESTED },
      });
      const name = await maybeAutoBackup().catch(() => undefined);
      nav.toast(name ? `Backing up weekly, keeping 4. First one saved: ${name}` : 'Backing up weekly, keeping the newest 4');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="banner amber" role="note" style={{ gap: 8 }}>
      <strong>Also keep a backup on this phone</strong>
      <span style={{ fontSize: 13 }}>{text}</span>
      <button className="btn small" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void turnOn()}>
        {busy ? 'Setting it up…' : 'Back up weekly, keep 4'}
      </button>
    </div>
  );
}
