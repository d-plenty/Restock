import { useState } from 'react';
import { RestockNative } from '../../lib/sql/native';
import { protection, suggestLocalText, syncStatus } from '../../lib/protection';
import { agoText, dayAndTime, serverName, syncAvailable, syncNowMessage, type SyncInfo } from '../../lib/sync';
import type { Settings } from '../../types';
import { Icon } from '../components';
import { useNav } from '../nav';
import { SuggestLocalBackup } from './Backups';
import { AddPhoneSheet, serverSummary } from './Sync';

/**
 * The top of Settings → Sync and backups (0.9.3; 0.9.4: the "Restock sync redesign" canvas). Not set
 * up: everything is only on this phone, and the three ways to sync, your server first, then phones
 * on your Wi-Fi, then a cloud drive folder. Set up: a strip with only what's in use (and the last
 * backup's day and time), the house, then how the household syncs. Backups follow in Settings.
 */
export function SyncOverview({ settings, info, onInfo }: { settings: Settings; info: SyncInfo | undefined; onInfo: (i: SyncInfo) => void }) {
  const nav = useNav();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const status = syncStatus(settings.autoBackup, info);
  const p = protection(settings.autoBackup.enabled, info);
  const paired = !!info?.paired;
  const house = !!info?.house || info?.serverApi === 3;
  const phones = (info?.members ?? []).filter((m) => !m.device.startsWith('srv-'));
  const others = phones.filter((m) => !m.me);
  const setUp = paired || !!info?.server;
  const wifi = info?.wifiSync !== false;

  const syncNow = async () => {
    setBusy(true);
    try {
      const r = await RestockNative.syncNow();
      onInfo(r);
      nav.toast(syncNowMessage(r));
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** A way to sync, as a row with a dot: on (filled) or off (a ring). */
  const way = (on: boolean, title: string, sub: string, onClick: () => void) => (
    <button className="row" onClick={onClick}>
      <span className={`sync-dot${on ? ' on' : ''}`} aria-hidden="true" />
      <span className="grow">
        <span className="title">{title}</span>
        <span className="small">
          <span className="sr-only">{on ? 'On. ' : 'Off. '}</span>
          {sub}
        </span>
      </span>
      <Icon name="chevron" size={18} />
    </button>
  );

  return (
    <>
      {info && p.covered && (
        <div className={`sync-strip${status.ok ? ' ok' : ' warn'}`} role="status">
          <div className="sync-strip-head">
            <Icon name={status.ok ? 'check' : 'alert'} size={20} stroke={status.ok ? 3 : 2} />
            <strong>{status.title}</strong>
            {setUp && syncAvailable() && (
              <button className="btn small" disabled={busy} onClick={() => void syncNow()}>
                {busy ? 'Syncing…' : 'Sync now'}
              </button>
            )}
          </div>
          {status.cells.length > 0 && (
            <div className="sync-strip-cells">
              {status.cells.map((c) => (
                <span key={c.label} className="sync-strip-cell">
                  <span className="small">{c.label === 'Server' && info.serverLabel ? info.serverLabel : c.label}</span>
                  <span>{c.day ? dayAndTime(c.when) : agoText(c.when)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {info && !p.covered && (
        <div className="sync-alone" role="status">
          <strong>Everything is only on this phone</strong>
          <span>Pick one way below to keep a copy and share with your household. You can add more later.</span>
        </div>
      )}

      {info?.serverOffer && (
        <div className="banner green" role="status" style={{ gap: 8 }}>
          <strong>Your household now lives on its server</strong>
          <span style={{ fontSize: 13 }}>Connect this phone to keep syncing at home and away.</span>
          <button className="btn small primary" style={{ alignSelf: 'flex-start' }} onClick={() => nav.push({ name: 'restockServer' })}>
            Connect this phone
          </button>
        </div>
      )}
      {info?.server && info.serverApi === 2 && info.isOwner && info.serverMode === 'v2' && (
        <div className="banner green" role="status" style={{ gap: 8 }}>
          <strong>Your server can be the house now</strong>
          <span style={{ fontSize: 13 }}>Hand this household to the server, so it does the owner phone's job around the clock.</span>
          <button className="btn small primary" style={{ alignSelf: 'flex-start' }} onClick={() => nav.push({ name: 'restockServer' })}>
            Hand this household to the server
          </button>
        </div>
      )}

      {!setUp ? (
        <>
          <h3 className="group-head">Sync with your household</h3>
          <button className="sync-choice recommended" disabled={!syncAvailable()} onClick={() => nav.push({ name: 'restockServer' })}>
            <span className="sync-choice-head">
              <span className="sync-choice-ic server" aria-hidden="true">
                <Icon name="server" size={22} />
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="eyebrow green" style={{ margin: 0 }}>
                  Recommended
                </span>
                <strong style={{ fontSize: 17 }}>Your Restock server</strong>
              </span>
            </span>
            <span className="small">
              Your server is the house: phones join it. Syncs around the clock, at home and away, keeps everything for years, and gives you Restock on
              your computer. Runs on a NAS, mini PC, Raspberry Pi or Home Assistant.
            </span>
            <span className="sync-choice-go">Join your server ›</span>
          </button>
          <button className="sync-choice" disabled={!syncAvailable()} onClick={() => nav.push({ name: 'sync' })}>
            <span className="sync-choice-head">
              <span className="sync-choice-ic wifi" aria-hidden="true">
                <Icon name="wifi" size={22} />
              </span>
              <strong style={{ fontSize: 17 }}>Phones on your Wi-Fi (no server)</strong>
            </span>
            <span className="small">
              No server and no account. Phones swap changes straight to each other when they're on the same Wi-Fi. Nothing leaves your home.
            </span>
          </button>
          <button className="sync-choice" disabled={!syncAvailable()} onClick={() => nav.push({ name: 'sync' })}>
            <span className="sync-choice-head">
              <span className="sync-choice-ic folder" aria-hidden="true">
                <Icon name="folder" size={22} />
              </span>
              <strong style={{ fontSize: 17 }}>A cloud drive folder</strong>
            </span>
            <span className="small">
              Use a folder your drive app keeps in step, like Google Drive, Dropbox, OneDrive, Syncthing or Nextcloud, or a WebDAV server. Each phone
              writes there and reads the others. Slower, and depends on the drive app.
            </span>
          </button>
        </>
      ) : (
        <>
          <div className="card" style={{ gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="sync-house-ic">
                <Icon name="home" size={20} />
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                <strong style={{ fontSize: 17 }}>{house ? serverName(info) : (paired && info?.household) || settings.household.name}</strong>
                <span className="small">
                  {house
                    ? `Your Restock server${info?.household ? `, ${info.household}` : ''}${phones.length ? ` · ${phones.length} phone${phones.length === 1 ? '' : 's'}` : ''}`
                    : paired
                      ? `${others.length + 1} phone${others.length ? 's' : ''}${info?.isOwner ? ' · this phone is the owner' : ''}`
                      : 'This phone'}
                </span>
              </span>
              {!house && (
                <button className="btn small" onClick={() => nav.push({ name: 'household' })} aria-label="Change the household's name">
                  Rename
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn small primary" disabled={!syncAvailable()} onClick={() => setAdding(true)}>
                Add a phone
              </button>
              {house ? (
                <button className="btn small" onClick={() => nav.push({ name: 'restockServer' })}>
                  What this phone shares
                </button>
              ) : (
                <button className="btn small" onClick={() => nav.push({ name: 'sync' })}>
                  Phones and sharing
                </button>
              )}
            </div>
          </div>

          <h3 className="group-head">How your household syncs</h3>
          <div className="card flush">
            {way(
              !!info?.server,
              'Restock server',
              info?.server ? `On · ${serverSummary(info)}` : 'Off · your own server, at home and away, around the clock',
              () => nav.push({ name: 'restockServer' }),
            )}
            {way(
              paired && wifi,
              'Phones on your Wi-Fi',
              paired && wifi
                ? others.length
                  ? `On · ${info?.lastSyncAt ? `synced ${agoText(info.lastSyncAt)}` : 'not synced yet'}`
                  : 'On · add a phone to start'
                : "Off · turn on to also swap changes at home when the internet's down",
              () => nav.push({ name: 'sync' }),
            )}
            {way(
              !!info?.folder && !house,
              'Cloud drive folder',
              house
                ? 'Not needed: your server syncs away from home'
                : info?.folder
                  ? (info.folderError ?? `On · ${info.folderName ?? 'a folder'} · ${info.folderAt ? `synced ${agoText(info.folderAt)}` : 'not synced yet'}`)
                  : 'Off · Google Drive, Dropbox, OneDrive, Syncthing, Nextcloud or WebDAV',
              () => nav.push({ name: 'sync' }),
            )}
          </div>
        </>
      )}

      {p.suggestLocal && <SuggestLocalBackup text={suggestLocalText(p)} />}
      {adding && info && (
        <AddPhoneSheet
          info={info}
          onClose={() => setAdding(false)}
          onWifi={() => {
            setAdding(false);
            nav.push({ name: 'sync', invite: true });
          }}
        />
      )}
    </>
  );
}
