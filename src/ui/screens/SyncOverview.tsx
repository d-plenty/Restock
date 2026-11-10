import { useState } from 'react';
import { RestockNative } from '../../lib/sql/native';
import { protection, suggestLocalText, syncStatus } from '../../lib/protection';
import { agoText, syncAvailable, type SyncInfo } from '../../lib/sync';
import type { Settings } from '../../types';
import { Icon } from '../components';
import { useNav } from '../nav';
import { SuggestLocalBackup } from './Backups';
import { serverSummary } from './Sync';

/**
 * 0.9.3: the top of Settings → Sync and backups. A strip that says whether everything is kept
 * somewhere else (or what needs you), the household, then the three ways phones sync. Backups
 * follow in Settings. Any mix of a local backup, phone-to-phone sync and a Restock server counts.
 */
export function SyncOverview({ settings, info, onInfo }: { settings: Settings; info: SyncInfo | undefined; onInfo: (i: SyncInfo) => void }) {
  const nav = useNav();
  const [busy, setBusy] = useState(false);
  const status = syncStatus(settings.autoBackup, info);
  const p = protection(settings.autoBackup.enabled, info);
  const paired = !!info?.paired;
  const others = (info?.members ?? []).filter((m) => !m.me);

  const syncNow = async () => {
    setBusy(true);
    try {
      const r = await RestockNative.syncNow();
      onInfo(r);
      nav.toast(r.serverError ?? r.lastError ?? (r.received ? `${r.received} change${r.received === 1 ? '' : 's'} came in` : 'Up to date'));
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const row = (icon: 'refresh' | 'swap' | 'home' | 'layer', title: string, sub: string, onClick: () => void) => (
    <button className="row" onClick={onClick}>
      <Icon name={icon} size={18} />
      <span className="grow">
        <span className="title">{title}</span>
        <span className="small">{sub}</span>
      </span>
      <Icon name="chevron" size={18} />
    </button>
  );

  return (
    <>
      {info && (
        <div className={`sync-strip${status.ok ? ' ok' : ' warn'}`} role="status">
          <div className="sync-strip-head">
            <Icon name={status.ok ? 'check' : 'alert'} size={20} stroke={status.ok ? 3 : 2} />
            <strong>{status.title}</strong>
            {(paired || info.server) && syncAvailable() && (
              <button className="btn small" disabled={busy} onClick={() => void syncNow()}>
                {busy ? 'Syncing…' : 'Sync now'}
              </button>
            )}
          </div>
          {status.cells.length > 0 && (
            <div className="sync-strip-cells">
              {status.cells.map((c) => (
                <span key={c.label} className="sync-strip-cell">
                  <span className="small">{c.label}</span>
                  <span>{agoText(c.when)}</span>
                </span>
              ))}
            </div>
          )}
          {!p.covered && (
            <span className="small">
              Turn on any of these: automatic backups below, phone-to-phone sync, or your own Restock server. One is enough; more is fine.
            </span>
          )}
        </div>
      )}

      <div className="card" style={{ gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="sync-house-ic">
            <Icon name="home" size={20} />
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
            <strong style={{ fontSize: 17 }}>{(paired && info?.household) || settings.household.name}</strong>
            <span className="small">
              {paired
                ? `${others.length + 1} phone${others.length ? 's' : ''}${info?.isOwner ? ' · this phone is the owner' : ''}`
                : 'Not set up: phones in your house can share one pantry and list'}
            </span>
          </span>
          <button className="btn small" onClick={() => nav.push({ name: 'household' })} aria-label="Change the household's name">
            Rename
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {paired ? (
            <>
              {info?.isOwner && (
                <button className="btn small primary" disabled={!syncAvailable()} onClick={() => nav.push({ name: 'sync', invite: true })}>
                  Add a phone
                </button>
              )}
              <button className="btn small" onClick={() => nav.push({ name: 'sync' })}>
                Phones and sharing
              </button>
            </>
          ) : (
            <>
              <button className="btn small primary" disabled={!syncAvailable()} onClick={() => nav.push({ name: 'sync', invite: true })}>
                Start a household
              </button>
              <button className="btn small" disabled={!syncAvailable()} onClick={() => nav.push({ name: 'sync' })}>
                Join a household
              </button>
            </>
          )}
        </div>
      </div>

      <h3 className="group-head">How your phones sync</h3>
      <div className="card flush">
        {row(
          'refresh',
          'On your Wi-Fi',
          paired
            ? others.length
              ? `Phone to phone · ${info?.lastSyncAt ? `synced ${agoText(info.lastSyncAt)}` : 'not synced yet'}`
              : 'Phone to phone · add a phone to start'
            : 'Phone to phone, no server · start a household first',
          () => nav.push({ name: 'sync' }),
        )}
        {row(
          'swap',
          'Away from home',
          info?.folder
            ? (info.folderError ?? `${info.folderName ?? 'A folder'} · ${info.folderAt ? `synced ${agoText(info.folderAt)}` : 'not synced yet'}`)
            : paired
              ? 'Nextcloud, WebDAV or a folder · not set up'
              : 'Nextcloud, WebDAV or a folder · start a household first',
          () => nav.push({ name: 'sync' }),
        )}
        {row('layer', 'Restock server', info?.server ? serverSummary(info) : 'Your own server, at home and away · Connect sets it all up', () =>
          nav.push({ name: 'restockServer' }),
        )}
      </div>
      <p className="small group-note">Any mix works: Wi-Fi at home, plus a drive or your own server when you're out.</p>

      {p.suggestLocal && <SuggestLocalBackup text={suggestLocalText(p)} />}
    </>
  );
}
