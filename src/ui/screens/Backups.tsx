import { useState } from 'react';
import { BACKUP_EVERY, BACKUP_KEEP, everyLabel, maybeAutoBackup } from '../../lib/autoBackup';
import { getSettings, updateSettings } from '../../lib/db';
import { RestockNative } from '../../lib/sql/native';
import { isNative } from '../../stores/http';
import type { Settings } from '../../types';
import { Icon, timeAgo } from '../components';
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
            Saves a whole backup into a folder you choose, such as Documents, or a folder your cloud app (Google Drive, Nextcloud) keeps in sync.
            {inSetup ? ' Off unless you turn it on.' : ''}
          </span>
        </span>
        <input type="checkbox" checked={b.enabled} onChange={(e) => void toggle(e.target.checked)} aria-label="Back up automatically" />
      </label>
      <button className="row" onClick={() => void pick()}>
        <span className="grow">
          <span className="title" style={{ fontSize: 14 }}>
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
          <span className="title" style={{ fontSize: 14 }}>
            How often
          </span>
          <span className="small">When you open Restock and the last backup is older than this.</span>
        </span>
        <select
          className="input"
          style={{ width: 'auto', height: 38, padding: '0 8px', fontSize: 14 }}
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
          <span className="title" style={{ fontSize: 14 }}>
            Keep the newest
          </span>
          <span className="small">Older automatic backups in the folder are removed. Your other files are never touched.</span>
        </span>
        <select
          className="input"
          style={{ width: 'auto', height: 38, padding: '0 8px', fontSize: 14 }}
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
          <input type="checkbox" checked={b.receiptPhotos !== false} onChange={(e) => void set({ receiptPhotos: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 14 }}>
              Include receipt photos
            </span>
            <span className="small">Restock's own photos of your receipts (not your phone's photos). Untick for smaller backups.</span>
          </span>
        </label>
      )}
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
