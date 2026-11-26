import { IosBox } from '../IosWhy';
import { deviceWord, isIos } from '../../lib/platform';
import { useState } from 'react';
import { RestockNative } from '../../lib/sql/native';
import { protection, suggestLocalText, syncStatus, wifiSyncOn } from '../../lib/protection';
import { agoText, canSync, dayAndTime, serverName, syncAvailable, syncNowMessage, type SyncInfo } from '../../lib/sync';
import type { Settings } from '../../types';
import { Icon, More } from '../components';
import { useNav } from '../nav';
import { SuggestLocalBackup } from './Backups';
import { serverSummary } from './Sync';
import { AddPhoneSheet } from './SyncServer';

/**
 * The top of Settings → Sync (0.9.3; 0.9.4: the "Restock sync redesign" canvas). Not set
 * up: everything is only on this phone, and the three ways to sync, your server first, then phones
 * on your Wi-Fi, then a cloud drive folder. Set up: a strip with only what's in use (and the last
 * backup's day and time), the house, then how the household syncs. Backups follow in Settings.
 */
export function SyncOverview({ settings, info, onInfo, haSummary }: { settings: Settings; info: SyncInfo | undefined; onInfo: (i: SyncInfo) => void; haSummary?: string }) {
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
  const wifi = wifiSyncOn(info);
  const ios = isIos();
  const device = deviceWord();

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
          <strong>Everything is only on this {device}</strong>
          <span>Pick a way below to share it with your household.</span>
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
          {/* 0.9.11: the household's name lives here now (setup no longer asks for it). */}
          <div className="card flush">
            <button className="row" onClick={() => nav.push({ name: 'household' })}>
              <span className="grow">
                <span className="title">Household name</span>
                <span className="small">{settings.household.name || 'Our house'}</span>
              </span>
            </button>
          </div>
          <h3 className="group-head">Sync with your household</h3>
          {/* 0.13.2: what's recommended goes by what the phone can do and what most households have.
              Android: Phone sharing first (no account, no server). iPhone and iPad: iCloud first. A
              Restock server is for people who run one, so it's listed last and isn't "Recommended". */}
          {/* 0.17.0: one row each, a line about it, and Recommended on the first (they were big cards full of words) */}
          <div className="card flush">
            {(ios ? (['folder', 'wifi', 'server'] as const) : (['wifi', 'folder', 'server'] as const)).map((kind, i) => {
              const can = canSync(kind);
              const first = i === 0;
              const [title, sub, icon, tone, go] =
                kind === 'server'
                  ? (['Your Restock server', 'If you run one: at home and away, and Restock on your computer', 'server', 'slate', () => nav.push({ name: 'restockServer' })] as const)
                  : kind === 'wifi'
                    ? ([ios ? 'Sync with an Android phone' : 'Phone sharing', ios ? 'With an Android phone, on your Wi-Fi' : 'Phones swap changes on your Wi-Fi. No account', 'wifi', 'green', () => nav.push(ios ? { name: 'wifiSync' } : { name: 'sync' })] as const)
                    : ([ios ? 'iCloud sync' : 'A cloud drive folder', ios ? 'iPhones and iPads, at home or away' : 'Google Drive, Dropbox and the like, away from home', 'folder', 'blue', () => nav.push({ name: 'sync' })] as const);
              const choice = (
                <button key={kind} className="row" disabled={!can} onClick={go}>
                  <span className="row-tile" data-tone={tone} aria-hidden="true">
                    <Icon name={icon} size={20} />
                  </span>
                  <span className="grow">
                    <span className="title">
                      {title}
                      {first && <span className="tag good rec-tag">Recommended</span>}
                    </span>
                    <span className="small">{sub}</span>
                  </span>
                  <Icon name="chevron" size={18} />
                </button>
              );
              // 0.15.0: every way works on an iPhone now; a build without the Files part says so.
              return can || !ios ? (
                choice
              ) : (
                <IosBox key={kind} reason="icloud">
                  {choice}
                </IosBox>
              );
            })}
          </div>
          {/* 0.14.0: two iPhones straight to each other works, but only with both open at once: it's there for people who want it, not offered as a good choice. */}
          {ios && canSync('wifi') && (
            <details className="card flush fold">
              <summary className="row">
                <span className="grow">
                  <span className="title" style={{ fontSize: 15 }}>
                    Advanced
                  </span>
                  <span className="small">iPhone to iPhone over Wi-Fi, without iCloud</span>
                </span>
                <Icon name="chevron" size={18} />
              </summary>
              <div className="fold-body" style={{ padding: '4px 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="small">
                  Two iPhones or iPads can swap changes straight to each other on the same Wi-Fi. It only happens while Restock is open on screen on
                  both at the same moment, so changes can sit for days without either of you noticing. iCloud sync doesn't have that problem.
                </span>
                <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => nav.push({ name: 'wifiSync', apple: true })}>
                  Set it up anyway
                </button>
              </div>
            </details>
          )}
          <p className="small" style={{ margin: 0 }}>Whichever you choose, keep a backup too.{' '}<More title="Sync and backups"><p>{ios
              ? `Whichever you choose, also keep a backup on this ${device} (Settings → Backups). And on an iPhone or iPad, Restock syncs when it's open, not while it's closed.`
              : 'Whichever you choose, also keep a backup on this phone (Settings → Backups). On Android, Restock syncs in the background too.'}</p></More></p>
          {/* 0.9.11: Home Assistant sits with the other ways of sharing. */}
          {haSummary !== undefined && (
            <button className="sync-choice" onClick={() => nav.push({ name: 'homeAssistant' })}>
              <span className="sync-choice-head">
                <span className="sync-choice-ic folder" aria-hidden="true">
                  <Icon name="home" size={22} />
                </span>
                <strong style={{ fontSize: 17 }}>Home Assistant</strong>
              </span>
              <span className="small">Your shopping list in Home Assistant, both ways.{haSummary && !haSummary.startsWith('Your shopping list') ? ` ${haSummary}.` : ''}</span>
            </button>
          )}
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
              {/* 0.13.2: an iCloud household's devices are added on its own screen (the first device shows a code) */}
              <button className="btn small primary" disabled={!syncAvailable()} onClick={() => (ios && !house ? nav.push(info?.wifiSync ? { name: 'wifiSync' } : { name: 'sync' }) : setAdding(true))}>
                {ios && !house && !info?.wifiSync ? 'Add an iPhone or iPad' : 'Add a phone'}
              </button>
              {house ? (
                <button className="btn small" onClick={() => nav.push({ name: 'restockServer' })}>
                  What this phone shares
                </button>
              ) : (
                <button className="btn small" onClick={() => nav.push(ios && info?.wifiSync ? { name: 'wifiSync' } : { name: 'sync' })}>
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
              info?.server ? `On · ${serverSummary(info)}` : ios && paired ? 'Not used: this device shares through iCloud' : 'Off',
              () => nav.push({ name: 'restockServer' }),
            )}
            {/* 0.13.2: only the ways this device can sync (an iPhone or iPad can't do every one yet) */}
            {(!ios || canSync('wifi')) &&
              way(
              paired && wifi,
              ios ? 'Sync with another phone (Wi-Fi)' : house ? 'Phone sharing (Wi-Fi, optional)' : 'Phone sharing (no server, local Wi-Fi)',
              paired && wifi
                ? others.length
                  ? `On · ${info?.lastSyncAt ? `synced ${agoText(info.lastSyncAt)}` : 'not synced yet'}`
                  : house
                    ? 'On · set up Phone sharing on the other phones too'
                    : 'On · add a phone to start'
                : ios && paired
                  ? 'Not used on this device'
                  : house
                    ? 'Off · optional, for when the server is down'
                    : 'Off',
              () => nav.push(ios ? { name: 'wifiSync' } : { name: 'sync' }),
            )}
            {(!ios || canSync('folder')) &&
              way(
              !!info?.folder && !house,
              ios ? 'iCloud sync' : 'Cloud drive folder',
              house
                ? 'Not needed: your server syncs away from home'
                : info?.folder
                  ? (info.folderError ?? `On · ${info.folderName ?? 'a folder'} · ${info.folderAt ? `synced ${agoText(info.folderAt)}` : 'not synced yet'}`)
                  : 'Off',
              () => nav.push({ name: 'sync' }),
            )}
            {haSummary !== undefined && way(!!haSummary && !haSummary.startsWith('Your shopping list'), 'Home Assistant', haSummary, () => nav.push({ name: 'homeAssistant' }))}
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
