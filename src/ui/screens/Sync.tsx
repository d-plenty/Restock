import { useEffect, useState } from 'react';
import { scanBarcode } from '../../lib/barcode';
import { saveCopyInApp } from '../../lib/backup';
import { confirmAction } from '../../lib/confirm';
import { allGroups, getSettings, updateSettings } from '../../lib/db';
import { RestockNative } from '../../lib/sql/native';
import { agoText, MAX_SYNC_PHONES, pairingCode, strictBatteryMaker, syncAvailable, syncInfo, type SyncInfo } from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { syncBackgroundSchedule } from '../../lib/check';
import { scheduleReminders } from '../../lib/notify';
import { Icon, LoadingBar, Sheet, TopBar } from '../components';
import { useNav } from '../nav';

// Settings → Sync (0.8.0): phones in the same household sync with each other on the same Wi-Fi.
// No server, no account: one phone shows a QR code, the other scans it.

/**
 * A QR code as an SVG that scales to any size: one square per module, with the white border
 * scanners need (0.8.2: the zxing picture had a fixed size and was cut off when stretched).
 */
export function qrSvg(symbol: { data: ArrayLike<number>; width: number; height: number }): string {
  const q = 4;
  let d = '';
  for (let y = 0; y < symbol.height; y++)
    for (let x = 0; x < symbol.width; x++) if (symbol.data[y * symbol.width + x] < 128) d += `M${x + q} ${y + q}h1v1h-1z`;
  const w = symbol.width + q * 2;
  const h = symbol.height + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%" shape-rendering="crispEdges"><rect width="${w}" height="${h}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/** The pairing code as a QR code, drawn on the phone (zxing, bundled; nothing is sent anywhere). */
function PairingQr({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>();
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [mod, { default: wasmUrl }] = await Promise.all([import('zxing-wasm/writer'), import('zxing-wasm/writer/zxing_writer.wasm?url')]);
      mod.prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } });
      const r = await mod.writeBarcode(code, { format: 'QRCode', options: 'ecLevel=M' });
      if (alive && r.symbol?.width) setSvg(qrSvg(r.symbol));
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

/**
 * The pairing code as text, for when the camera won't read the QR code (0.8.1): send it to the
 * other phone in a message and paste it into Join a household → "Or paste the code".
 */
function CodeText({ code }: { code: string }) {
  const nav = useNav();
  const share = async () => {
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: 'Restock sync code', text: code });
    } catch {
      // cancelled
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      nav.toast('Code copied');
    } catch {
      void share();
    }
  };
  return (
    <details className="sync-code">
      <summary className="small">Can't scan it? Send the code instead</summary>
      <p className="small">
        Send this to the other phone (a text message to yourself is fine), copy it, then on that phone tap Join a household and paste it into "Or
        paste the code". Keep it private, like a Wi-Fi password.
      </p>
      <code className="sync-code-text">{code}</code>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn small" onClick={() => void copy()}>
          Copy
        </button>
        <button className="btn small" onClick={() => void share()}>
          <Icon name="share" size={16} /> Send
        </button>
      </div>
    </details>
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

/** "9:41 left" until a code runs out. */
function useCountdown(until: number | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return undefined;
  const left = Math.max(0, Math.round((until - now) / 1000));
  return { left, text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` };
}

/**
 * Start a household, or (owner) add a phone: a new one-time code each time, working once and
 * for 10 minutes. Closing the sheet closes the code.
 */
function InviteSheet({ info, onClose }: { info: SyncInfo; onClose: () => void }) {
  const settings = useLive(getSettings, []);
  const [household, setHousehold] = useState<string>();
  const [code, setCode] = useState<string>();
  const [until, setUntil] = useState<number>();
  const [error, setError] = useState<string>();
  const [members, setMembers] = useState(info.members?.length ?? 1);
  const [joined, setJoined] = useState<string>();
  const name = household ?? info.household ?? settings?.household.name ?? 'Our house';
  const left = useCountdown(until);

  const make = async (shareCards: boolean) => {
    setError(undefined);
    try {
      const r = await RestockNative.syncInvite({ household: name, shareCards });
      if (!info.paired) await updateSettings({ household: { name } });
      setCode(r.code);
      setUntil(Date.now() + r.expiresInMs);
      setJoined(undefined);
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
        const n = i.members?.length ?? 0;
        if (n > members) {
          setJoined(i.members?.find((m) => !m.me && !info.members?.some((x) => x.device === m.device))?.name ?? 'the other phone');
          setMembers(n);
          setCode(undefined);
        }
      });
    }, 2000);
    return () => clearInterval(t);
  }, [code, members, info.members]);
  const close = () => {
    void RestockNative.syncCloseInvite().catch(() => undefined);
    onClose();
  };
  const expired = left && left.left === 0;

  return (
    <Sheet title={info.paired ? 'Add a phone' : 'Start a household'} onClose={close}>
      {!code && !joined && !info.paired && (
        <>
          <label className="field">
            <span>Household name</span>
            <input className="input" value={name} onChange={(e) => setHousehold(e.target.value)} />
          </label>
          <CardsQuestion onAnswer={(share) => void make(share)} />
        </>
      )}
      {error && <div className="banner amber">{error}</div>}
      {joined && (
        <>
          <div className="banner green" role="status">
            <strong>{joined} joined</strong>
            <span style={{ fontSize: 13 }}>The phones are syncing. That code can't be used again.</span>
          </div>
          <button className="btn block" onClick={() => void make(!!info.shareCards)}>
            Add another phone
          </button>
          <button className="btn block primary" onClick={close}>
            Done
          </button>
        </>
      )}
      {code && !joined && (
        <>
          {expired ? (
            <div className="banner amber">
              <strong>This code has run out</strong>
              <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => void make(!!info.shareCards)}>
                Make a new code
              </button>
            </div>
          ) : (
            <PairingQr code={code} />
          )}
          {!expired && left && (
            <span className="small" role="status" style={{ textAlign: 'center' }}>
              Works once, for the next {left.text}. Waiting for the other phone…
            </span>
          )}
          {!expired && <CodeText code={code} />}
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Put both phones on the same Wi-Fi, and keep this screen open.</li>
            <li>On the other phone (Restock 0.8.2 or newer), tap Join your household on the first screen, or Settings → Local sync → Join a household.</li>
            <li>Scan this code.</li>
          </ol>
          <button className="btn block" onClick={close}>
            Cancel
          </button>
        </>
      )}
    </Sheet>
  );
}

/** The household's settings worth copying to a phone joining from the first screen. */
export const COPIED_SETTINGS = [
  'enabledChains',
  'stores',
  'sections',
  'customShops',
  'hiddenTabs',
  'checkIntervalHours',
  'checkWeekday',
  'alerts',
  'historyWeeks',
  'defaultThresholdPct',
  'listCompare',
  'productOrder',
  'marketData',
  'household',
  'recalls',
] as const;

/** Copies the owner's shop choices and settings (as JSON text) into this phone's settings. */
export async function copyHouseholdSettings(json: string | undefined): Promise<void> {
  if (!json) return;
  try {
    const theirs = JSON.parse(json) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of COPIED_SETTINGS) if (theirs[k] !== undefined) patch[k] = theirs[k];
    // Price checks in the background follow the household's choice too.
    const sync = theirs.sync as { backgroundActivity?: boolean } | undefined;
    const mine = await getSettings();
    if (typeof sync?.backgroundActivity === 'boolean') patch.sync = { ...mine.sync, backgroundActivity: sync.backgroundActivity };
    const s = await updateSettings(patch as never);
    await syncBackgroundSchedule(s).catch(() => undefined);
    await scheduleReminders(s).catch(() => undefined);
    if (syncAvailable()) await RestockNative.scheduleRecalls({ enabled: s.recalls.enabled }).catch(() => undefined);
  } catch (e) {
    console.error('copy settings', e);
  }
}

/** Joining with a code: combine or replace (if this phone has things), cards, then join. */
export function JoinSheet({
  code,
  fresh,
  onClose,
  onJoined,
}: {
  code: string;
  /** From the first screen: take the household's things and settings, no questions about this phone's things. */
  fresh?: boolean;
  onClose: () => void;
  onJoined: (msg: string) => void;
}) {
  const groups = useLive(allGroups, []);
  const [replace, setReplace] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const hasThings = !fresh && (groups?.length ?? 0) > 0;
  const mode = fresh ? true : hasThings ? replace : false;

  const join = async (shareCards: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      // "Use the household's things" empties this phone first: keep a copy, just in case.
      if (mode && !fresh) await saveCopyInApp('backups/before-joining.json');
      const r = await RestockNative.syncJoin({ code, replace: !!mode, shareCards, settings: !!fresh });
      if (fresh) await copyHouseholdSettings(r.settings);
      const where = r.household ?? 'the household';
      onJoined(
        r.reached > 0
          ? `Joined ${where}. Synced with ${r.ownerName ?? 'the owner phone'}.`
          : `Joined ${where}. Syncing as soon as the phones find each other.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet title="Join your household" onClose={busy ? () => undefined : onClose}>
      {busy ? (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="small">Joining and syncing with the owner phone…</span>
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

/** Scan (or paste) a household's code. */
export async function scanPairingCode(): Promise<string | undefined> {
  const out = await scanBarcode('Scan the code on the owner phone', {
    accept: pairingCode,
    qr: true,
    wrong: "That isn't a Restock sync code. On the owner phone, open Settings → Local sync → Add a phone.",
    typeHint: 'Or paste the code',
  });
  return out.ok ? out.code : undefined;
}

/** What the owner can do with another phone. */
function MemberSheet({
  member,
  onClose,
  onDone,
}: {
  member: { device: string; name: string };
  onClose: () => void;
  onDone: (info: SyncInfo, msg: string) => void;
}) {
  const [error, setError] = useState<string>();
  const run = async (what: 'remove' | 'owner') => {
    const ok = await confirmAction(what === 'remove' ? `Remove ${member.name} from the household?` : `Make ${member.name} the owner?`, {
      detail:
        what === 'remove'
          ? "It stops syncing straight away, and the household's key changes so it can't sync again, even with an old code. It keeps what it has now. The other phones get the new key next time they sync with this one."
          : 'It will be the one that adds and removes phones. This phone becomes an ordinary member. The change takes effect when the two phones next sync.',
      action: what === 'remove' ? 'Remove' : 'Make owner',
      danger: what === 'remove',
    });
    if (!ok) return;
    try {
      const info =
        what === 'remove' ? await RestockNative.syncRemove({ device: member.device }) : await RestockNative.syncHandOver({ device: member.device });
      onDone(info, what === 'remove' ? `${member.name} removed` : `${member.name} will be the owner after the next sync`);
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

export function SyncScreen() {
  const nav = useNav();
  const [info, setInfo] = useState<SyncInfo>();
  const [inviting, setInviting] = useState(false);
  const [joining, setJoining] = useState<string>();
  const [member, setMember] = useState<{ device: string; name: string }>();
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
    const code = await scanPairingCode();
    if (code) setJoining(code);
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
    const others = (info?.members ?? []).filter((m) => !m.me);
    if (info?.isOwner && others.length) {
      await confirmAction('Make another phone the owner first', {
        detail: `This is the owner phone. Tap ${others[0].name} in the list above and choose "Make this the owner phone", sync once, then stop syncing this phone.`,
        action: 'OK',
        danger: false,
      });
      return;
    }
    const ok = await confirmAction('Stop syncing this phone?', {
      detail:
        "This phone keeps everything it has now, and nothing is deleted on the household's other phones. Changes just stop going between them. To join again, you'll need a new code from the owner phone.",
      action: 'Stop syncing',
    });
    if (!ok) return;
    const r = await RestockNative.syncLeave();
    setInfo(r);
    if (r.left) nav.toast('This phone has stopped syncing');
  };

  const synced = (device: string) => info?.peers?.find((p) => p.device === device)?.syncedAt;
  const owner = info?.members?.find((m) => m.owner);

  return (
    <div className="screen">
      <TopBar title="Local sync" />

      {!syncAvailable() && (
        <div className="banner grey">
          <strong>Sync works in the Android app</strong>
          <span style={{ fontSize: 13 }}>In this preview everything stays in this browser.</span>
        </div>
      )}

      {info?.notice && !info.paired && (
        <div className="banner amber" role="status">
          <strong>{info.notice === 'removed' ? 'This phone was removed from the household' : 'Pair your phones again'}</strong>
          <span style={{ fontSize: 13 }}>
            {info.notice === 'removed'
              ? 'The owner phone took it out. It kept everything it had. To join again, ask the owner for a new code.'
              : 'Restock 0.8.2 adds an owner phone and one-time codes. Everything is still on this phone. On the phone that will be the owner, tap Start a household; on the other, tap Join a household and scan the code. Choose "Combine" so nothing is lost.'}
          </span>
          <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => void RestockNative.syncDismissNotice().then(refresh)}>
            OK
          </button>
        </div>
      )}

      <div className="card" style={{ gap: 8 }}>
        <strong>Local sync: one pantry and list for the whole house</strong>
        <span className="small">
          Phones in your household sync <strong>straight from one phone to another</strong> on your own Wi-Fi: pantry, shopping list (ticks too),
          prices, categories and alerts.
        </span>
        <ul className="ticks">
          <li>
            <Icon name="check" size={16} />
            <span>No account, no sign-up, no server.</span>
          </li>
          <li>
            <Icon name="check" size={16} />
            <span>Nothing leaves your phones: it never goes over the internet, and the makers of Restock never see it.</span>
          </li>
          <li>
            <Icon name="check" size={16} />
            <span>Encrypted with a key only your phones have.</span>
          </li>
          <li>
            <Icon name="check" size={16} />
            <span>Up to {MAX_SYNC_PHONES} phones. Each keeps its own look, receipts, backups and shop sign-ins.</span>
          </li>
        </ul>
      </div>

      {info && !info.paired && (
        <div className="card flush">
          <button className="row" disabled={!syncAvailable()} onClick={() => setInviting(true)}>
            <Icon name="plus" size={18} />
            <span className="grow">
              <span className="title">Start a household</span>
              <span className="small">This phone becomes the owner: it adds and removes the other phones.</span>
            </span>
            <Icon name="chevron" size={18} />
          </button>
          <button className="row" disabled={!syncAvailable()} onClick={() => void scan()}>
            <Icon name="scan" size={18} />
            <span className="grow">
              <span className="title">Join a household</span>
              <span className="small">Scan the code on the owner phone.</span>
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
                    ((info.members?.length ?? 0) > 1
                      ? 'Syncs when you open Restock, after changes, and every 15 minutes or so.'
                      : 'No other phones yet.')}
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
            <button className="row" onClick={() => void leave()}>
              <Icon name="close" size={18} />
              <span className="grow">
                <span className="title" style={{ fontSize: 14 }}>
                  Stop syncing this phone
                </span>
                <span className="small">This phone keeps everything. Nothing is deleted on the other phones.</span>
              </span>
            </button>
          </div>

          <div className="eyebrow">The household's phones</div>
          <div className="card flush">
            {(info.members ?? []).map((m) => {
              const canManage = info.isOwner && !m.me;
              const body = (
                <>
                  <Icon name="phone" size={18} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 14, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {m.name}
                      {m.owner && <span className="tag great">Owner</span>}
                      {m.me && <span className="tag normal">This phone</span>}
                    </span>
                    {!m.me && <span className="small">Last synced {agoText(synced(m.device))}</span>}
                  </span>
                  {canManage && <Icon name="more" size={18} />}
                </>
              );
              return canManage ? (
                <button key={m.device} className="row" onClick={() => setMember(m)} aria-label={`${m.name}: remove or make owner`}>
                  {body}
                </button>
              ) : (
                <div key={m.device} className="row">
                  {body}
                </div>
              );
            })}
            {info.isOwner && (info.members?.length ?? 1) >= MAX_SYNC_PHONES ? (
              <p className="small" style={{ padding: '4px 14px 12px', margin: 0 }}>
                That's the most local sync allows ({MAX_SYNC_PHONES} phones). To add another, remove one first.
              </p>
            ) : info.isOwner ? (
              <button className="row" onClick={() => setInviting(true)}>
                <Icon name="plus" size={18} />
                <span className="grow">
                  <span className="title" style={{ fontSize: 14, color: 'var(--green)' }}>
                    Add a phone
                  </span>
                  <span className="small">Shows a new one-time code for it to scan</span>
                </span>
              </button>
            ) : (
              <p className="small" style={{ padding: '4px 14px 12px', margin: 0 }}>
                Only the owner phone{owner ? ` (${owner.name})` : ''} can add or remove phones.
              </p>
            )}
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
        </>
      )}

      <div className="card" style={{ gap: 6 }}>
        <strong>Good to know</strong>
        <span className="small">
          Both phones need to be on the same Wi-Fi at the same time; whatever changed while apart catches up then. Some routers and guest networks
          keep devices from seeing each other ("client isolation" or "AP isolation"); if the phones never find each other, that's the usual reason.
        </span>
        <span className="small">
          Codes work once and only for 10 minutes, and never contain the household's key, so a code that's been seen or shared can't be used later.
          Backups never include the household either: a phone restored from a backup joins again with a new code.
        </span>
        <span className="small">
          If both phones change the same thing while apart, the later change wins. Restoring a backup on one phone changes the household's things to
          match it.
        </span>
      </div>

      <div className="card" style={{ gap: 6 }}>
        <strong>Hosted sync: coming later</strong>
        <span className="small">
          For syncing from anywhere, not just on the same Wi-Fi: through a small server you run yourself (a Docker container on a home server, NAS or
          Raspberry Pi). Still no Restock account, and the server only ever sees encrypted data. Local sync keeps working either way.
        </span>
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
      {member && (
        <MemberSheet
          member={member}
          onClose={() => setMember(undefined)}
          onDone={(i, msg) => {
            setMember(undefined);
            setInfo(i);
            nav.toast(msg);
          }}
        />
      )}
    </div>
  );
}

/** One line for Settings and the setup tile. */
export function syncSummary(info: SyncInfo | undefined): string {
  if (!info) return '';
  if (!info.paired) return info.notice === 'repair' ? 'Pair your phones again (0.8.2)' : 'Share one pantry and list between phones';
  const n = info.members?.length ?? 1;
  return n > 1
    ? `${info.household ?? 'Household'} · ${n} phones · synced ${agoText(info.lastSyncAt)}`
    : `${info.household ?? 'Household'} · waiting for another phone`;
}
