// 0.14.0: syncing with another phone over your own Wi-Fi, on iPhone and iPad (ios/wire.ts). The same
// household of phones the Android app makes: one phone starts it, the others join with its code, and
// they swap changes straight to each other. An iPhone or iPad does its part while Restock is open.
import { useCallback, useEffect, useRef, useState } from 'react';
import { scanBarcode } from '../../lib/barcode';
import { confirmAction } from '../../lib/confirm';
import { getSettings } from '../../lib/db';
import { deviceWord } from '../../lib/platform';
import { RestockNative } from '../../lib/sql/native';
import { agoText } from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { isWifiCode } from '../../ios/wire';
import { wifi, type WifiStatus } from '../../ios/sync';
import { Icon, Sheet, TopBar } from '../components';
import { useNav } from '../nav';
import { CodeText, PairingQr } from './Sync';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** This device's code for another phone to scan. It closes by itself once that phone is in. */
function AddPhoneSheet({ onClose, onIn }: { onClose: () => void; onIn: () => void }) {
  const nav = useNav();
  const device = deviceWord();
  const [invite, setInvite] = useState<{ code: string; until: number }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const before = wifi.status().members.length;
    wifi
      .invite()
      .then((i) => alive && setInvite(i))
      .catch((e) => alive && setError(errText(e)));
    const look = setInterval(() => {
      if (!alive) return;
      try {
        if (wifi.status().members.length > before) {
          nav.toast('That phone is in. They sync from now on.');
          onIn();
        }
      } catch {
        // the next look
      }
    }, 1500);
    return () => {
      alive = false;
      clearInterval(look);
      void wifi.closeInvite().catch(() => undefined);
    };
    // Once, when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Sheet title="Add a phone" onClose={onClose}>
      {error && (
        <div className="banner amber" role="alert">
          <span>{error}</span>
        </div>
      )}
      <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <li>Put the other phone on the same Wi-Fi as this {device}.</li>
        <li>
          In Restock on it, open <strong>Sync and backups</strong>, choose to sync with another phone, then <strong>Join with a code</strong>.
        </li>
        <li>Scan this code. Keep Restock open here until it says the phone is in.</li>
      </ol>
      {invite && <PairingQr code={invite.code} label="Sync code" />}
      {invite && <CodeText code={invite.code} />}
      <p className="small" role="status" style={{ margin: 0 }}>
        Waiting for the other phone… This code works once, for 10 minutes.
      </p>
      <button className="btn block" onClick={onClose}>
        Close
      </button>
    </Sheet>
  );
}

function Toggle({ on, label, detail, disabled, onChange }: { on: boolean; label: string; detail: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="row">
      <span className="grow">
        <span className="title" style={{ fontSize: 15 }}>
          {label}
        </span>
        <span className="small">{detail}</span>
      </span>
      <input type="checkbox" className="switch" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** `apple`: opened from "iPhone to iPhone over Wi-Fi" (the same thing, with what that needs said first). */
export function WifiSyncScreen({ apple }: { apple?: boolean }) {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const [st, setSt] = useState<WifiStatus>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const device = deviceWord();
  const alive = useRef(true);

  const load = useCallback(() => {
    try {
      const s = wifi.status();
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

  const start = async () => {
    const name = settings?.household.name || 'Our house';
    const sure = await confirmAction(`Start "${name}" on this ${device}?`, {
      detail: `The other phones join from this ${device}, with a code it shows. What's on it now becomes the household's.`,
      action: 'Start the household',
      danger: false,
    });
    if (!sure) return;
    await run('Starting your household…', async () => {
      await wifi.start(name, ['pantry']);
      nav.toast('Household started. Add the other phone from here.');
      setAdding(true);
    });
  };

  const join = async () => {
    setError(undefined);
    const out = await scanBarcode('Scan the code on the other phone', {
      accept: (text) => (isWifiCode(text) ? text.trim() : undefined),
      qr: true,
      wrong: "That isn't a Restock sync code. On the other phone, open Sync and backups and choose Add a phone.",
      typeHint: 'Or type the code',
    });
    if (!out.ok) return;
    await run('Joining…', async () => {
      const p = await wifi.peek(out.code);
      const sure = await confirmAction(`Join ${p.household ?? 'this household'}?`, {
        detail: `${p.ownerName ? `${p.ownerName} started it. ` : ''}This ${device} keeps everything it has and adds it to the household. Where both have the same thing, the household's copy is kept.`,
        action: 'Join',
        danger: false,
      });
      if (!sure) return;
      await wifi.join(out.code);
      nav.toast('Joined. They sync from now on.');
    });
  };

  const syncNow = () =>
    run('Syncing…', async () => {
      const r = await RestockNative.syncNow();
      nav.toast(r.reached ? (r.received ? `${r.received} change${r.received === 1 ? '' : 's'} came in` : 'Up to date') : (r.lastError ?? "Couldn't reach the other phone"));
    });

  const remove = async (d: { device: string; name: string }) => {
    const sure = await confirmAction(`Take ${d.name} out of the household?`, {
      detail: 'It keeps everything it has now and stops syncing with the others.',
      action: 'Take it out',
    });
    if (sure) await run('Taking it out…', () => wifi.remove(d.device));
  };

  const leave = async () => {
    const sure = await confirmAction('Stop syncing with the other phones?', {
      detail: `This ${device} keeps everything it has now. Nothing is deleted on the other phones.`,
      action: 'Stop syncing',
    });
    if (!sure) return;
    await run('Stopping…', async () => {
      if (await wifi.leave()) nav.toast('This device no longer syncs with the other phones');
      else setError(`This ${device} started the household and other phones are still in it. Take them out first (Phones, below), then stop.`);
    });
  };

  const others = st?.members.filter((m) => !m.me) ?? [];

  return (
    <div className="screen">
      <TopBar title={apple ? 'iPhone to iPhone over Wi-Fi' : 'Sync with another phone'} />

      <div className="card" style={{ gap: 8 }}>
        <strong>Straight between phones, on your own Wi-Fi</strong>
        <span className="small">
          No server and no account. The phones swap changes with each other when they're on the same Wi-Fi. Nothing leaves your home, and what they
          send is sealed so only your household's phones can read it.
        </span>
        <span className="small">
          <strong>This {device} syncs while Restock is open on it.</strong> An Android phone (Samsung, Google Pixel, Oppo, Motorola, Nokia and most
          phones that aren't iPhones) answers in the background, so it doesn't need Restock open.
        </span>
        {apple && (
          <span className="small">
            <strong>Two iPhones or iPads:</strong> both need Restock open on screen at the same moment, on the same Wi-Fi, or nothing is swapped.
            iCloud sync doesn't need that, so it's the easier choice for a household of iPhones.
          </span>
        )}
      </div>

      {st && !st.available && (
        <div className="banner grey" role="status">
          <span>Syncing with another phone works in the Restock app for iPhone and iPad.</span>
        </div>
      )}

      {st?.elsewhere ? (
        <div className="banner grey" role="status">
          <strong>This {device} is {st.elsewhere === 'server' ? 'on a Restock server' : 'in an iCloud household'}</strong>
          <span style={{ fontSize: 13 }}>A device belongs to one household at a time. To sync with a phone this way instead, leave that first.</span>
        </div>
      ) : (
        <>
          {error && (
            <div className="banner amber" role="alert">
              <span>{error}</span>
            </div>
          )}

          {st && !st.joined && (
            <>
              <div className="eyebrow">Your household</div>
              <button className="sync-choice" disabled={!!busy || !st.available} onClick={() => void join()}>
                <strong style={{ fontSize: 17 }}>Join with a code</strong>
                <span className="small">
                  The other phone already has a household. On it, open Sync and backups, choose Add a phone, and scan the code it shows with this{' '}
                  {device}.
                </span>
              </button>
              <button className="sync-choice" disabled={!!busy || !st.available} onClick={() => void start()}>
                <strong style={{ fontSize: 17 }}>Start a household here</strong>
                <span className="small">Nobody has one yet. This {device} starts it and shows a code for the other phone to scan.</span>
              </button>
              {busy && (
                <p className="small" role="status" style={{ margin: 0 }}>
                  {busy}
                </p>
              )}
            </>
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
                      {st.members.length} phone{st.members.length === 1 ? '' : 's'}
                      {st.owner ? ` · this ${device} started it` : ''}
                    </span>
                  </span>
                </div>
                <span className="small" role="status">
                  {st.error ? st.error : st.at ? `Synced with another phone ${agoText(st.at)}.` : others.length ? 'Not synced with another phone yet.' : 'Nobody else is in yet.'}
                </span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn small primary" disabled={!!busy} onClick={() => void syncNow()}>
                    {busy ?? 'Sync now'}
                  </button>
                  {st.owner && (
                    <button className="btn small" disabled={!!busy} onClick={() => setAdding(true)}>
                      Add a phone
                    </button>
                  )}
                </div>
              </div>

              <div className="eyebrow">Phones</div>
              <div className="card flush">
                {st.members.map((d) => (
                  <div className="row" key={d.device}>
                    <Icon name="phone" size={18} />
                    <span className="grow">
                      <span className="title" style={{ fontSize: 15 }}>
                        {d.me ? `This ${device}` : d.name}
                      </span>
                      <span className="small">{d.owner ? 'Started the household: phones are added and taken out on it' : 'In the household'}</span>
                    </span>
                    {st.owner && !d.me && (
                      <button className="btn small" disabled={!!busy} onClick={() => void remove(d)}>
                        Take out
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="eyebrow">What this {device} shares</div>
              <div className="card flush">
                <div className="row">
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>
                      Pantry, shopping lists and prices
                    </span>
                    <span className="small">Always shared with the household</span>
                  </span>
                </div>
                <Toggle
                  on={st.receipts}
                  label="Receipts"
                  detail={st.owner ? 'Receipts and their photos, for the whole household' : "Receipts and their photos, when the household's first phone shares them too"}
                  disabled={!!busy}
                  onChange={(on) => {
                    wifi.setShares({ receipts: on });
                    load();
                  }}
                />
                <Toggle
                  on={st.cards}
                  label="Loyalty cards"
                  detail="Your loyalty cards go to the household's other phones. Gift cards never do."
                  disabled={!!busy}
                  onChange={(on) => {
                    wifi.setShares({ cards: on });
                    load();
                  }}
                />
              </div>

              <div className="eyebrow">Stop</div>
              <div className="card flush">
                <button className="row" disabled={!!busy} onClick={() => void leave()}>
                  <Icon name="close" size={18} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15, color: 'var(--red-ink)' }}>
                      Stop syncing with the other phones
                    </span>
                    <span className="small">This {device} keeps everything it has now. You'll be asked to confirm.</span>
                  </span>
                </button>
              </div>
            </>
          )}

          <div className="eyebrow">Good to know</div>
          <div className="card" style={{ gap: 8 }}>
            <span className="small">
              <strong>Only at home.</strong> The phones have to be on the same Wi-Fi. Away from home, each keeps working by itself and they catch up
              when they're back.
            </span>
            <span className="small">
              <strong>The first time, iOS asks</strong> whether Restock may find devices on your local network. Say yes: that is how it reaches the
              other phone.
            </span>
            <span className="small">
              <strong>Keep a backup too</strong> (Sync and backups, then Backups). Sync keeps your phones the same, mistakes included.
            </span>
          </div>
        </>
      )}

      {adding && (
        <AddPhoneSheet
          onClose={() => {
            setAdding(false);
            load();
          }}
          onIn={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </div>
  );
}
