// 0.13.2: iCloud sync, on iPhone and iPad (what Sync opens there). A household of iPhones and iPads
// that shares one folder in iCloud Drive: the first device makes the household, the others join with
// its code, and each puts its changes in the folder whenever Restock is open (ios/folderHouse.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { scanBarcode } from '../../lib/barcode';
import { confirmAction } from '../../lib/confirm';
import { getSettings } from '../../lib/db';
import { deviceWord } from '../../lib/platform';
import { RestockNative } from '../../lib/sql/native';
import { agoText } from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { isFolderCode } from '../../ios/folderHouse';
import { icloud, type IcloudStatus } from '../../ios/sync';
import { Icon, Sheet, TopBar } from '../components';
import { NotHereBanner } from '../IosWhy';
import { useNav } from '../nav';
import { CodeText, PairingQr } from './Sync';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The steps for making the folder and sharing it, in the Files app. */
function FolderHelp() {
  return (
    <details className="card flush fold">
      <summary className="row">
        <span className="grow">
          <span className="title" style={{ fontSize: 15 }}>
            How to make the folder and share it
          </span>
          <span className="small">Done once, in the Files app</span>
        </span>
        <Icon name="chevron" size={18} />
      </summary>
      <div className="fold-body" style={{ padding: '4px 14px 14px' }}>
        <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <li>
            On the household's first iPhone or iPad, open the <strong>Files</strong> app and go to <strong>iCloud Drive</strong>.
          </li>
          <li>
            Make a new folder and call it <strong>Restock</strong>.
          </li>
          <li>
            Press and hold the folder, tap <strong>Share</strong>, then <strong>Collaborate</strong> (on older iOS: Share Folder), and invite the
            other people in your household by their Apple Account. Leave them able to make changes.
          </li>
          <li>
            On each of their devices, accept the invitation. The Restock folder then shows in their Files app, under iCloud Drive or Shared.
          </li>
          <li>
            In Restock on every device, tap <strong>Pick the folder</strong> here, go into that same folder, and tap <strong>Open</strong>.
          </li>
        </ol>
      </div>
    </details>
  );
}

/** The first device's code for another to scan. It looks for the other device every few seconds while this is open. */
function AddDeviceSheet({ onClose, onLetIn }: { onClose: () => void; onLetIn: () => void }) {
  const nav = useNav();
  const [invite, setInvite] = useState<{ code: string; until: number }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    try {
      setInvite(icloud.invite());
    } catch (e) {
      setError(errText(e));
    }
    let alive = true;
    const look = setInterval(() => {
      void RestockNative.syncNow()
        .then(() => {
          if (!alive) return;
          // The code is used up once a device has been let in.
          if (!icloud.status().invite) {
            nav.toast('That device is in. It syncs from now on.');
            onLetIn();
          }
        })
        .catch(() => undefined);
    }, 5000);
    return () => {
      alive = false;
      clearInterval(look);
      try {
        icloud.closeInvite();
      } catch {
        // nothing open
      }
    };
    // Once, when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Sheet title="Add an iPhone or iPad" onClose={onClose}>
      {error && (
        <div className="banner amber" role="alert">
          <span>{error}</span>
        </div>
      )}
      <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <li>On the other device, share this household's iCloud folder with it and pick that folder in Restock (Sync and backups, then iCloud sync).</li>
        <li>
          There, tap <strong>Join with a code</strong> and scan this.
        </li>
        <li>Keep Restock open on both until it says the device is in. iCloud can take a minute to pass things along.</li>
      </ol>
      {invite && <PairingQr code={invite.code} label="iCloud sync code" />}
      {invite && <CodeText code={invite.code} />}
      <p className="small" role="status" style={{ margin: 0 }}>
        Waiting for the other device… This code works once, for 30 minutes.
      </p>
      <button className="btn block" onClick={onClose}>
        Close
      </button>
    </Sheet>
  );
}

export function IcloudSyncScreen() {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const [st, setSt] = useState<IcloudStatus>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const device = deviceWord();
  const alive = useRef(true);

  const load = useCallback(() => {
    try {
      const s = icloud.status();
      if (alive.current) setSt(s);
    } catch {
      // the data isn't open yet: the next look tries again
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, 3000);
    const h = RestockNative.addListener('syncDone', load);
    return () => {
      alive.current = false;
      clearInterval(t);
      void h.then((x) => x.remove()).catch(() => undefined);
    };
  }, [load]);

  const run = async (what: string, job: () => Promise<void>) => {
    setError(undefined);
    setBusy(what);
    try {
      await job();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(undefined);
      load();
    }
  };

  const pick = () =>
    run('Opening Files…', async () => {
      if (await icloud.pickFolder()) nav.toast('Folder picked');
    });

  const start = async () => {
    const name = settings?.household.name || 'Our house';
    const sure = await confirmAction(`Start "${name}" on this ${device}?`, {
      detail: `This ${device} becomes the household's first device: the others are added from here. What's on it now becomes the household's. Its name can be changed in Sync and backups.`,
      action: 'Start the household',
      danger: false,
    });
    if (!sure) return;
    await run('Starting your household…', async () => {
      await icloud.start(name, ['pantry']);
      nav.toast('Household started. Add your other devices from here.');
    });
  };

  const join = async () => {
    setError(undefined);
    const out = await scanBarcode("Scan the code on the household's first device", {
      accept: (text) => (isFolderCode(text) ? text.trim() : undefined),
      qr: true,
      wrong: "That isn't an iCloud sync code. On the household's first iPhone or iPad, open iCloud sync and choose Add an iPhone or iPad.",
      typeHint: 'Or paste the code',
    });
    if (!out.ok) return;
    await run('Asking to join…', async () => {
      await icloud.join(out.code);
    });
  };

  const syncNow = () =>
    run('Syncing…', async () => {
      const r = await RestockNative.syncNow();
      nav.toast(r.folderError ?? (r.received ? `${r.received} change${r.received === 1 ? '' : 's'} came in` : 'Up to date'));
    });

  const remove = async (d: { device: string; name: string }) => {
    const sure = await confirmAction(`Take ${d.name} out of the household?`, {
      detail: `It keeps everything it has now and stops sharing. Also stop sharing the iCloud folder with that person in the Files app: that is what shuts them out of the folder.`,
      action: 'Take it out',
    });
    if (sure) await run('Taking it out…', () => icloud.remove(d.device));
  };

  const leave = async () => {
    const sure = await confirmAction('Leave this household?', {
      detail: `This ${device} keeps everything it has now and stops sharing. Nothing is deleted on the other devices.`,
      action: 'Leave',
    });
    if (sure)
      await run('Leaving…', async () => {
        await icloud.leave();
        nav.toast('You left the household');
      });
  };

  return (
    <div className="screen">
      <TopBar title="iCloud sync" />

      {st && !st.available && <NotHereBanner reason="icloud" title="iCloud sync works in the iPhone and iPad app" />}

      <div className="card" style={{ gap: 8 }}>
        <strong>One shared folder in iCloud Drive</strong>
        <span className="small">
          Your household shares one folder. Each iPhone and iPad puts its changes there and picks up everyone else's, at home or away. No server, and
          no account with Restock. What's in the folder is sealed, so only your household's devices can read it.
        </span>
        <span className="small">
          <strong>It syncs while Restock is open:</strong> when you open it, every minute after that, and a few seconds after you change something.
          Not while it's closed. Nobody else needs to have Restock open at the same time.
        </span>
      </div>

      {st?.inHouse ? (
        <div className="banner grey" role="status">
          <strong>This {device} is on a Restock server</strong>
          <span style={{ fontSize: 13 }}>A device belongs to one household at a time. To use iCloud sync instead, leave the server first.</span>
        </div>
      ) : (
        <>
          {error && (
            <div className="banner amber" role="alert">
              <span>{error}</span>
            </div>
          )}

          <div className="eyebrow">The folder</div>
          <div className="card flush">
            <div className="row">
              <Icon name="folder" size={18} />
              <span className="grow">
                <span className="title" style={{ fontSize: 15 }}>
                  {st?.folderName ?? 'No folder picked yet'}
                </span>
                <span className="small">{st?.folderName ? 'The folder your household shares' : "Pick the folder your household shares in iCloud Drive"}</span>
              </span>
              <button className={`btn small${st?.folderName ? '' : ' primary'}`} disabled={!!busy || !st?.available || !!st?.joined} onClick={() => void pick()}>
                {st?.folderName ? 'Change' : 'Pick the folder'}
              </button>
            </div>
          </div>
          <FolderHelp />

          {st && !st.joined && !st.joining && (
            <>
              <div className="eyebrow">Your household</div>
              <button className="sync-choice" disabled={!!busy || !st.folderName} onClick={() => void start()}>
                <strong style={{ fontSize: 17 }}>Start a household here</strong>
                <span className="small">This is the household's first iPhone or iPad. The others are added from this one.</span>
              </button>
              <button className="sync-choice" disabled={!!busy || !st.folderName} onClick={() => void join()}>
                <strong style={{ fontSize: 17 }}>Join with a code</strong>
                <span className="small">Another iPhone or iPad already started the household. Scan the code it shows.</span>
              </button>
              {!st.folderName && <p className="small" style={{ margin: 0 }}>Pick the folder first.</p>}
            </>
          )}

          {st?.joining && (
            <div className="card" style={{ gap: 10 }} role="status">
              <strong>Waiting for the household's first device</strong>
              <span className="small">
                Keep Restock open on both. The first device has to see this one in the folder and let it in, and iCloud can take a minute to pass
                things along. This {device} joins by itself when the answer arrives.
              </span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn small primary" disabled={!!busy} onClick={() => void syncNow()}>
                  {busy ?? 'Look now'}
                </button>
                <button
                  className="btn small"
                  disabled={!!busy}
                  onClick={() => {
                    icloud.cancelJoin();
                    load();
                  }}
                >
                  Stop waiting
                </button>
              </div>
            </div>
          )}

          {st?.joined && (
            <>
              <div className="card" style={{ gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span className="sync-house-ic">
                    <Icon name="home" size={20} />
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                    <strong style={{ fontSize: 17 }}>{st.household ?? 'Your household'}</strong>
                    <span className="small">
                      {st.others.length + 1} device{st.others.length ? 's' : ''}
                      {st.owner ? ` · this ${device} is the first device` : ''}
                    </span>
                  </span>
                </div>
                <span className="small" role="status">
                  {st.error ? st.error : st.at ? `Synced with another device ${agoText(st.at)}.` : st.others.length ? 'Not synced with another device yet.' : 'Nobody else is in yet.'}
                </span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn small primary" disabled={!!busy} onClick={() => void syncNow()}>
                    {busy ?? 'Sync now'}
                  </button>
                  {st.owner && (
                    <button className="btn small" disabled={!!busy} onClick={() => setAdding(true)}>
                      Add an iPhone or iPad
                    </button>
                  )}
                </div>
              </div>

              <div className="eyebrow">Devices</div>
              <div className="card flush">
                <div className="row">
                  <Icon name="phone" size={18} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>
                      This {device}
                    </span>
                    <span className="small">{st.owner ? "The household's first device: others are added and taken out here" : 'In the household'}</span>
                  </span>
                </div>
                {st.others.map((d) => (
                  <div className="row" key={d.device}>
                    <Icon name="phone" size={18} />
                    <span className="grow">
                      <span className="title" style={{ fontSize: 15 }}>
                        {d.name}
                      </span>
                      <span className="small">In the household</span>
                    </span>
                    {st.owner && (
                      <button className="btn small" disabled={!!busy} onClick={() => void remove(d)}>
                        Take out
                      </button>
                    )}
                  </div>
                ))}
                {!st.owner && (
                  <div className="row">
                    <span className="grow">
                      <span className="small">Devices are added and taken out on the household's first device.</span>
                    </span>
                  </div>
                )}
              </div>

              <div className="eyebrow">Leave</div>
              <div className="card flush">
                <button className="row" disabled={!!busy} onClick={() => void leave()}>
                  <Icon name="close" size={18} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15, color: 'var(--red-ink)' }}>
                      Leave this household
                    </span>
                    <span className="small">This {device} keeps everything it has now and stops sharing. You'll be asked to confirm.</span>
                  </span>
                </button>
              </div>
            </>
          )}

          <div className="eyebrow">Good to know</div>
          <div className="card" style={{ gap: 8 }}>
            <span className="small">
              <strong>What's shared:</strong> your pantry, shopping lists, inventory, the tabs you made, household settings and recent prices. Receipts
              and loyalty cards stay on each device.
            </span>
            <span className="small">
              <strong>iCloud decides how fast.</strong> A change usually reaches the other devices within a minute of them opening Restock, sometimes
              longer.
            </span>
            <span className="small">
              <strong>For iPhones and iPads.</strong> An Android phone can't join an iCloud folder. A household with Android phones in it shares through
              a Restock server.
            </span>
            <span className="small">
              <strong>Keep a backup too</strong> (Sync and backups, then Backups). Sync keeps your devices the same, mistakes included.
            </span>
          </div>
        </>
      )}

      {adding && (
        <AddDeviceSheet
          onClose={() => {
            setAdding(false);
            load();
          }}
          onLetIn={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </div>
  );
}
