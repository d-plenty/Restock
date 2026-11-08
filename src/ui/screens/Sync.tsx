import { useEffect, useState } from 'react';
import { scanBarcode } from '../../lib/barcode';
import { saveCopyInApp } from '../../lib/backup';
import { confirmAction } from '../../lib/confirm';
import { allGroups, getSettings, updateSettings } from '../../lib/db';
import { RestockNative } from '../../lib/sql/native';
import { agoText, householdIn, pairingCode, strictBatteryMaker, syncAvailable, syncInfo, type SyncInfo } from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { Icon, LoadingBar, Sheet, TopBar } from '../components';
import { useNav } from '../nav';

// Settings → Sync (0.8.0): phones in the same household sync with each other on the same Wi-Fi.
// No server, no account: one phone shows a QR code, the other scans it.

/** The pairing code as a QR code, drawn on the phone (zxing, bundled; nothing is sent anywhere). */
function PairingQr({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>();
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [mod, { default: wasmUrl }] = await Promise.all([import('zxing-wasm/writer'), import('zxing-wasm/writer/zxing_writer.wasm?url')]);
      mod.prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } });
      const r = await mod.writeBarcode(code, { format: 'QRCode', options: 'ecLevel=M', scale: 6 } as never);
      if (alive && r.svg) setSvg(r.svg);
    })().catch((e) => console.error('qr', e));
    return () => {
      alive = false;
    };
  }, [code]);
  return (
    <div className="sync-qr" role="img" aria-label="Pairing QR code">
      {svg ? <span dangerouslySetInnerHTML={{ __html: svg }} /> : <LoadingBar seconds={3} />}
    </div>
  );
}

/** Yes / No buttons for "share my loyalty cards?" (asked when pairing). */
function CardsQuestion({ onAnswer }: { onAnswer: (share: boolean) => void }) {
  return (
    <div className="card" style={{ gap: 10 }}>
      <strong>Share your loyalty cards with the household's other phones?</strong>
      <span className="small">
        Your Flybuys and Everyday Rewards numbers would be copied to them, so member prices count on every phone and anyone can show the card at the
        checkout. You can change this any time on this screen.
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" style={{ flex: 1 }} onClick={() => onAnswer(true)}>
          Yes, share them
        </button>
        <button className="btn" style={{ flex: 1 }} onClick={() => onAnswer(false)}>
          No, keep them here
        </button>
      </div>
    </div>
  );
}

/** Start a household (or add another phone to it): ask about cards, then show the QR code. */
function InviteSheet({ info, onClose }: { info: SyncInfo; onClose: () => void }) {
  const settings = useLive(getSettings, []);
  const [household, setHousehold] = useState<string>();
  const [code, setCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [peers, setPeers] = useState(info.peers?.length ?? 0);
  const [joined, setJoined] = useState<string>();
  const name = household ?? info.household ?? settings?.household.name ?? 'Our house';

  const make = async (shareCards: boolean) => {
    setError(undefined);
    try {
      const r = await RestockNative.syncInvite({ household: name, shareCards });
      await updateSettings({ household: { name } });
      setCode(r.code);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // Already in a household: the card question was answered then.
  useEffect(() => {
    if (info.paired) void make(!!info.shareCards);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Notice when the other phone has joined.
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => {
      void syncInfo().then((i) => {
        const n = i.peers?.length ?? 0;
        if (n > peers) {
          setJoined(i.peers?.[0]?.name ?? 'the other phone');
          setPeers(n);
        }
      });
    }, 3000);
    return () => clearInterval(t);
  }, [code, peers]);

  return (
    <Sheet title={info.paired ? 'Add a phone' : 'Start a household'} onClose={onClose}>
      {!code && !info.paired && (
        <>
          <label className="field">
            <span>Household name</span>
            <input className="input" value={name} onChange={(e) => setHousehold(e.target.value)} />
          </label>
          <CardsQuestion onAnswer={(share) => void make(share)} />
        </>
      )}
      {error && <div className="banner amber">{error}</div>}
      {code && (
        <>
          <PairingQr code={code} />
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Put both phones on the same Wi-Fi.</li>
            <li>On the other phone, update to Restock 0.8.0 or newer, then open Settings → Sync → Join a household.</li>
            <li>Scan this code. The phones sync straight away, then whenever they're both on this Wi-Fi.</li>
          </ol>
          {joined ? (
            <div className="banner green" role="status">
              <strong>Paired with {joined}</strong>
            </div>
          ) : (
            <span className="small" role="status">
              Waiting for the other phone…
            </span>
          )}
          <button className="btn block" onClick={onClose}>
            Done
          </button>
        </>
      )}
    </Sheet>
  );
}

/** After scanning another phone's code: combine or replace, cards, then join. */
function JoinSheet({ code, onClose, onJoined }: { code: string; onClose: () => void; onJoined: (msg: string) => void }) {
  const groups = useLive(allGroups, []);
  const [replace, setReplace] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const household = householdIn(code) || 'the household';
  const hasThings = (groups?.length ?? 0) > 0;
  const mode = hasThings ? replace : false;

  const join = async (shareCards: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      // "Use the household's things" empties this phone first: keep a copy, just in case.
      if (mode) await saveCopyInApp('backups/before-joining.json');
      const r = await RestockNative.syncJoin({ code, replace: !!mode, shareCards });
      if (householdIn(code)) await updateSettings({ household: { name: householdIn(code) } });
      onJoined(
        r.reached > 0
          ? `Joined ${household}. Synced with ${r.peers?.[0]?.name ?? 'the other phone'}.`
          : `Joined ${household}. Restock syncs as soon as it finds the other phone on this Wi-Fi.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Join ${household}`} onClose={busy ? () => undefined : onClose}>
      {busy ? (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="small">Joining and syncing with the other phone…</span>
          <LoadingBar seconds={15} />
        </div>
      ) : hasThings && replace === undefined ? (
        <div className="card flush">
          <p className="small" style={{ padding: '12px 14px 0', margin: 0 }}>
            This phone already has {groups!.length} item{groups!.length === 1 ? '' : 's'}. What should happen to them?
          </p>
          <button className="row" onClick={() => setReplace(false)}>
            <Icon name="plus" size={18} />
            <span className="grow">
              <span className="title" style={{ fontSize: 14 }}>
                Combine with the household
              </span>
              <span className="small">Both phones keep their things and get each other's. You might see a few doubles to tidy up.</span>
            </span>
          </button>
          <button className="row" onClick={() => setReplace(true)}>
            <Icon name="refresh" size={18} />
            <span className="grow">
              <span className="title" style={{ fontSize: 14 }}>
                Use the household's things
              </span>
              <span className="small">
                This phone's pantry, list and prices are replaced with the household's. A backup of them is saved first. The other phones aren't
                changed.
              </span>
            </span>
          </button>
        </div>
      ) : (
        <CardsQuestion onAnswer={(share) => void join(share)} />
      )}
      {error && <div className="banner amber">{error}</div>}
    </Sheet>
  );
}

export function SyncScreen() {
  const nav = useNav();
  const [info, setInfo] = useState<SyncInfo>();
  const [inviting, setInviting] = useState(false);
  const [joining, setJoining] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);

  const refresh = () => void syncInfo().then(setInfo);
  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      refresh();
      tick((n) => n + 1);
    }, 15000);
    const h = syncAvailable() ? RestockNative.addListener('syncDone', (i) => setInfo(i)) : undefined;
    return () => {
      clearInterval(t);
      void h?.then((x) => x.remove());
    };
  }, []);

  const scan = async () => {
    const out = await scanBarcode('Scan the other phone’s sync code', {
      accept: pairingCode,
      wrong: "That isn't a Restock sync code. On the other phone, open Settings → Sync → Start a household (or Add a phone).",
      typeHint: 'Or paste the code',
    });
    if (out.ok) setJoining(out.code);
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const r = await RestockNative.syncNow();
      setInfo(r);
      nav.toast(
        r.reached
          ? `Synced with ${r.reached === 1 ? (r.peers?.[0]?.name ?? 'the other phone') : `${r.reached} phones`}${r.received ? `: ${r.received} change${r.received === 1 ? '' : 's'} came in` : ''}`
          : (r.lastError ?? "Couldn't find the other phone."),
      );
    } finally {
      setBusy(false);
    }
  };

  const set = async (patch: { name?: string; shareCards?: boolean; keepReady?: boolean }) => setInfo(await RestockNative.syncSet(patch));

  const leave = async () => {
    const ok = await confirmAction('Stop syncing this phone?', {
      detail: 'This phone keeps everything it has now, but changes stop going between it and the household. You can join again any time.',
      action: 'Stop syncing',
    });
    if (ok) setInfo(await RestockNative.syncLeave());
  };

  return (
    <div className="screen">
      <TopBar title="Sync" />

      {!syncAvailable() && (
        <div className="banner grey">
          <strong>Sync works in the Android app</strong>
          <span style={{ fontSize: 13 }}>In this preview everything stays in this browser.</span>
        </div>
      )}

      <div className="card" style={{ gap: 6 }}>
        <strong>One pantry and list for the whole house</strong>
        <span className="small">
          Phones in the same household sync with each other when they're on the same Wi-Fi: pantry, shopping list (ticks too), prices, categories and
          alerts. No server and no account; everything sent between them is encrypted with a key only your phones have.
        </span>
        <span className="small">Each phone keeps its own look, receipts, backups and shop sign-ins.</span>
      </div>

      {info && !info.paired && (
        <div className="card flush">
          <button className="row" disabled={!syncAvailable()} onClick={() => setInviting(true)}>
            <Icon name="plus" size={18} />
            <span className="grow">
              <span className="title">Start a household</span>
              <span className="small">On the first phone. It shows a code for the others to scan.</span>
            </span>
            <Icon name="chevron" size={18} />
          </button>
          <button className="row" disabled={!syncAvailable()} onClick={() => void scan()}>
            <Icon name="scan" size={18} />
            <span className="grow">
              <span className="title">Join a household</span>
              <span className="small">Scan the code on a phone that's already set up.</span>
            </span>
            <Icon name="chevron" size={18} />
          </button>
        </div>
      )}

      {info?.paired && (
        <>
          <div className="eyebrow">{info.household ?? 'Your household'}</div>
          <div className="card flush">
            <div className="row">
              <span className="grow">
                <span className="title">{info.lastSyncAt ? `Synced ${agoText(info.lastSyncAt)}` : 'Not synced yet'}</span>
                <span className="small">
                  {info.lastError ??
                    (info.peers?.length ? 'Syncs when you open Restock, after changes, and every 15 minutes or so.' : 'No other phones yet.')}
                </span>
              </span>
              <button className="btn small primary" disabled={busy} onClick={() => void syncNow()}>
                <Icon name="refresh" size={16} /> {busy ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
            {busy && (
              <div style={{ padding: '0 14px 12px' }}>
                <LoadingBar seconds={8} />
              </div>
            )}
            {(info.peers ?? []).map((p) => (
              <div key={p.device} className="row">
                <Icon name="phone" size={18} />
                <span className="grow">
                  <span className="title" style={{ fontSize: 14 }}>
                    {p.name ?? 'Another phone'}
                  </span>
                  <span className="small">Last synced {agoText(p.syncedAt)}</span>
                </span>
              </div>
            ))}
            <button className="row" onClick={() => setInviting(true)}>
              <Icon name="plus" size={18} />
              <span className="grow">
                <span className="title" style={{ fontSize: 14, color: 'var(--green)' }}>
                  Add a phone
                </span>
                <span className="small">Shows the code for another phone to scan</span>
              </span>
            </button>
          </div>

          <label className="field">
            <span>This phone's name</span>
            <input
              className="input"
              defaultValue={info.name}
              onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== info.name && void set({ name: e.target.value })}
            />
          </label>
          <p className="small" style={{ marginTop: -6 }}>
            What the other phones call this one, like "Declan's phone".
          </p>

          <div className="card flush">
            <label className="check">
              <input type="checkbox" checked={!!info.shareCards} onChange={(e) => void set({ shareCards: e.target.checked })} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span className="title" style={{ fontSize: 14 }}>
                  Share my loyalty cards
                </span>
                <span className="small">Copies this phone's Flybuys and Everyday Rewards numbers to the household's other phones.</span>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={info.keepReady !== false} onChange={(e) => void set({ keepReady: e.target.checked })} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span className="title" style={{ fontSize: 14 }}>
                  Stay ready to sync
                </span>
                <span className="small">
                  Lets the other phones sync with this one while Restock is closed. Android shows a quiet "Ready to sync" notification for it, which
                  you can hide in Android's notification settings. Off: syncs only while Restock is open.
                </span>
              </span>
            </label>
          </div>

          {!info.batteryExempt && (
            <div className="banner amber" style={{ gap: 8 }}>
              <strong>Let Restock sync in the background</strong>
              <span style={{ fontSize: 13 }}>
                Android saves battery by stopping apps in the background, which stops sync while Restock is closed. Tap Allow and choose "Allow" (or
                "Don't optimise"). It hardly uses any battery: Restock just waits quietly for the other phones.
              </span>
              <button
                className="btn small"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => void RestockNative.requestBatteryExemption().then(() => setTimeout(refresh, 1500))}
              >
                Allow
              </button>
            </div>
          )}
          {strictBatteryMaker(info.maker) && (
            <p className="small">
              {info.maker} phones have their own battery saver too, which can still stop Restock.{' '}
              <a href={`https://dontkillmyapp.com/${(info.maker ?? '').toLowerCase().split(/\s+/)[0]}`} target="_blank" rel="noreferrer">
                How to keep Restock running on a {info.maker}
              </a>
            </p>
          )}

          <button className="btn ghost" onClick={() => void leave()}>
            Stop syncing this phone
          </button>
        </>
      )}

      <div className="card" style={{ gap: 6 }}>
        <strong>Good to know</strong>
        <span className="small">
          Both phones need to be on the same Wi-Fi at the same time; whatever changed while apart catches up then. Some routers and guest networks
          keep devices from seeing each other ("client isolation" or "AP isolation"); if the phones never find each other, that's the usual reason.
        </span>
        <span className="small">
          If both phones change the same thing while apart, the later change wins. Restoring a backup on one phone changes the household's things to
          match it.
        </span>
        <span className="small">Away from home (through a small server you run) is coming later.</span>
      </div>

      {inviting && info && (
        <InviteSheet
          info={info}
          onClose={() => {
            setInviting(false);
            refresh();
          }}
        />
      )}
      {joining && (
        <JoinSheet
          code={joining}
          onClose={() => setJoining(undefined)}
          onJoined={(msg) => {
            setJoining(undefined);
            nav.toast(msg);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** One line for Settings and the setup tile. */
export function syncSummary(info: SyncInfo | undefined): string {
  if (!info) return '';
  if (!info.paired) return 'Share one pantry and list between phones';
  const n = info.peers?.length ?? 0;
  return n
    ? `${info.household ?? 'Household'} · ${n + 1} phones · synced ${agoText(info.lastSyncAt)}`
    : `${info.household ?? 'Household'} · waiting for another phone`;
}
