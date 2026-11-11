import { useEffect, useRef, useState } from 'react';
import { stage } from '../../lib/settingsDraft'; // 0.9.5 (save)
import { SaveBar, useDraftState, useSettingsDraft } from '../SaveBar'; // 0.9.5 (save)
import { scanBarcode } from '../../lib/barcode';
import { confirmAction } from '../../lib/confirm';
import { getSettings, updateSettings } from '../../lib/db';
import { protection, suggestLocalText, wifiSyncOn } from '../../lib/protection';
import { RestockNative, type ServerCodeCheck, type TakeBack } from '../../lib/sql/native';
import {
  agoText,
  demoSync,
  handoverCode,
  serverCode,
  serverCodeAddresses,
  serverCodeVersion,
  serverName,
  syncAvailable,
  syncInfo,
  syncNowMessage,
  webPageCode,
  type SyncInfo,
} from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { SECTIONS, sectionOn, type Section } from '../../shops';
import { Icon, LoadingBar, Sheet, TopBar } from '../components';
import { useNav } from '../nav';
import { serverKeepText } from '../../lib/autoDelete';
import { SuggestLocalBackup } from './Backups';
import { askAdult, LeaveServerSheet, ServerCard, ShopDataStays, TAKE_BACK_NOTE } from './Sync';

/**
 * Settings → Sync and backups → Restock server (0.9.3), and 0.9.4's server-first households: the
 * server is the house, and phones join it (docs/server-v3-design.md). Here a phone joins its server
 * (scan the code from the server's Add a phone page), picks what it shares, and can leave. An owner
 * phone on a 0.9.3-style server hands its household to the server from here.
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const addressText = (a?: string | null) => (a ?? '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');

// ---------- what this phone shares ----------

export interface Shares {
  tabs: Section[];
  receipts: boolean;
  cards: boolean;
}

export const sharesOf = (i: SyncInfo | undefined): Shares => ({
  tabs: (i?.myTabs ?? ['pantry']).filter((t) => SECTIONS.includes(t)),
  receipts: !!i?.shareReceipts,
  cards: !!i?.shareCards,
});

type Kind = 'pantry' | 'keg' | 'pharmacy' | 'receipts' | 'cards';

const ROWS: { kind: Kind; title: string; sub: string }[] = [
  { kind: 'pantry', title: 'Groceries', sub: 'Pantry and shopping list (General too), ticks too, with their prices and alerts' },
  { kind: 'keg', title: 'Keg', sub: 'Bottle shops. Off unless you want the house to see it' },
  { kind: 'pharmacy', title: 'Health', sub: 'Off unless you want the house to see it' },
  { kind: 'receipts', title: 'Receipts', sub: 'What you spent, and the photos. Off unless you want the house to see them' },
  { kind: 'cards', title: 'Loyalty cards', sub: 'Best kept on your phone. Turn on only to share cards with the house.' },
];

const THINGS: Record<Kind, string> = { pantry: 'groceries', keg: 'Keg', pharmacy: 'Health', receipts: 'receipts', cards: 'loyalty cards' };

const isOn = (v: Shares, k: Kind) => (k === 'receipts' ? v.receipts : k === 'cards' ? v.cards : v.tabs.includes(k));

function withKind(v: Shares, k: Kind, on: boolean): Shares {
  if (k === 'receipts') return { ...v, receipts: on };
  if (k === 'cards') return { ...v, cards: on };
  return { ...v, tabs: on ? SECTIONS.filter((t) => t === k || v.tabs.includes(t)) : v.tabs.filter((t) => t !== k) };
}

/** Asked before Keg, Pharmacy, receipts or cards go to everyone on the server. */
async function askToShare(k: Kind): Promise<boolean> {
  if (k === 'keg' && !(await askAdult())) return false;
  if (k === 'pantry') return true;
  const detail =
    k === 'receipts'
      ? 'Everyone on this server will see your receipts and their photos, and what you spent. Share them?'
      : k === 'cards'
        ? 'Everyone on this server gets your Flybuys and Everyday Rewards numbers, so they can scan them at the checkout. Share them?'
        : 'Everyone on this server will see what you buy here. Share it?';
  return confirmAction(`Share ${THINGS[k]} with the house?`, { detail, action: 'Share it', danger: false });
}

/**
 * Turning something off later: what it already shared stays on the server (D11), and for Keg,
 * Pharmacy, receipts and cards there's an unticked "Also take what this phone shared off the server".
 */
function TurnOffSheet({ kind, onClose, onDone }: { kind: Kind; onClose: () => void; onDone: (takeBack: boolean) => void }) {
  const [takeBack, setTakeBack] = useState(false);
  const thing = THINGS[kind];
  const offer = kind !== 'pantry';
  return (
    <Sheet title={`Stop sharing ${thing}?`} onClose={onClose}>
      <p className="small" style={{ margin: 0 }}>
        From now on this phone keeps its {thing} to itself.{' '}
        {offer
          ? `What it already shared of its ${thing} stays on the server for the house, unless you tick the box below.`
          : 'What it already shared stays on the server for the house.'}
      </p>
      <div className="card" style={{ gap: 8 }}>
        <ShopDataStays />
      </div>
      {offer && (
        <div className="card flush">
          <label className="check">
            <input type="checkbox" checked={takeBack} onChange={(e) => setTakeBack(e.target.checked)} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Also take what this phone shared off the server
              </span>
              <span className="small">{TAKE_BACK_NOTE}</span>
            </span>
          </label>
        </div>
      )}
      <button className="btn primary block" onClick={() => onDone(takeBack)}>
        Stop sharing {thing}
      </button>
      <button className="btn block" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}

/**
 * What this phone shares with the server: Groceries, Keg, Pharmacy, Receipts and Loyalty cards.
 * Joining: just the choices. Later: turning one off asks first (TurnOffSheet).
 */
export function SharesPicker({ value, onChange, joining }: { value: Shares; onChange: (v: Shares, takeBack?: TakeBack) => void; joining?: boolean }) {
  const nav = useNav();
  const [off, setOff] = useState<Kind>();
  const flip = async (k: Kind, on: boolean) => {
    const next = withKind(value, k, on);
    if (!next.tabs.length) return nav.toast('Share at least one tab, or leave the server.');
    if (on) {
      if (await askToShare(k)) onChange(next);
    } else if (joining) onChange(next);
    else setOff(k);
  };
  return (
    <>
      <div className="card flush">
        {ROWS.map((r) => (
          <label key={r.kind} className="check">
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                {r.title}
              </span>
              <span className="small">{r.sub}</span>
            </span>
            <input type="checkbox" className="switch" checked={isOn(value, r.kind)} onChange={(e) => void flip(r.kind, e.target.checked)} />
          </label>
        ))}
      </div>
      {off && (
        <TurnOffSheet
          kind={off}
          onClose={() => setOff(undefined)}
          onDone={(takeBack) => {
            const k = off;
            setOff(undefined);
            onChange(withKind(value, k, false), takeBack && k !== 'pantry' ? (k as TakeBack) : undefined);
          }}
        />
      )}
    </>
  );
}

/** Saves what this phone shares (and takes back), then syncs: the server and the house see it. */
async function saveShares(v: Shares, takeBack: TakeBack | TakeBack[] | undefined, before: SyncInfo | undefined): Promise<SyncInfo> {
  const keep = (before?.takeBack ?? []).filter((t) => (t === 'receipts' ? !v.receipts : t === 'cards' ? !v.cards : !v.tabs.includes(t as Section)));
  const more = Array.isArray(takeBack) ? takeBack : takeBack ? [takeBack] : [];
  return RestockNative.syncSetServer({
    tabs: v.tabs,
    receipts: v.receipts,
    cards: v.cards,
    takeBack: [...new Set([...keep, ...more])],
  });
}

/** 0.9.5 (save): whether a kind is still shared (then it isn't taken back). */
const stillShared = (v: Shares, t: TakeBack) => (t === 'receipts' ? v.receipts : t === 'cards' ? v.cards : v.tabs.includes(t as Section));

/** This phone's tabs on, for what it now shares (so a shared Keg or Pharmacy tab shows here too). */
async function showSharedTabs(v: Shares) {
  const s = await getSettings();
  const turnOn = v.tabs.filter((t) => t !== 'pantry' && !sectionOn(s, t));
  if (turnOn.length) await updateSettings({ sections: { ...s.sections, ...Object.fromEntries(turnOn.map((t) => [t, true])) } }, { local: true });
}

// ---------- 2 · joining: label and what this phone shares ----------

function JoinedPage({ joined, info, onDone }: { joined: { label?: string | null; houseName?: string | null }; info: SyncInfo; onDone: (i: SyncInfo, msg: string) => void }) {
  const [label, setLabel] = useState(info.serverLabel ?? 'Home');
  const [shares, setShares] = useState<Shares>({ tabs: ['pantry'], receipts: false, cards: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const house = joined.houseName ?? info.household ?? 'your server';
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await RestockNative.syncSetServer({ label: label.trim() || 'Home', tabs: shares.tabs, receipts: shares.receipts, cards: shares.cards, takeBack: [] });
      await showSharedTabs(shares);
      const r = await RestockNative.syncNow();
      onDone(r, syncNowMessage(r));
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  return (
    <>
      <div className="banner green" role="status">
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {/* A flex item: kept at its own size beside the words (it shrank to a dot before). */}
          <span style={{ display: 'flex', flexShrink: 0 }}>
            <Icon name="check" size={22} stroke={3} />
          </span>
          <span>
            Code scanned. This phone was added as <strong>{joined.label ?? info.name ?? 'this phone'}</strong> on <strong>{house}</strong>.
          </span>
        </span>
      </div>
      <div className="card" style={{ gap: 8 }}>
        <label className="field" style={{ margin: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 500 }}>What to call it on this phone</span>
          <input className="input" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <span className="small">Just a name for you. A phone belongs to one house at a time.</span>
      </div>
      <div className="eyebrow">What this phone shares</div>
      <SharesPicker value={shares} onChange={setShares} joining />
      {error && (
        <div className="banner amber" role="alert">
          {error}
        </div>
      )}
      <button className="btn primary block" disabled={busy || !syncAvailable()} onClick={() => void go()}>
        {busy ? 'Syncing…' : 'Join and sync'}
      </button>
      {busy && <LoadingBar seconds={8} />}
      <p className="small" style={{ textAlign: 'center', margin: 0 }}>
        Change any of this later in Sync and backups.
      </p>
    </>
  );
}

// ---------- a phone already in a household meets a server (section 7) ----------

type HouseChoice = { check: ServerCodeCheck; code: string; where: string };

function HouseChoiceSheet({ choice, onClose, onPick }: { choice: HouseChoice; onClose: () => void; onPick: (how: 'bring' | 'leave') => void }) {
  const c = choice.check;
  const hh = c.household ?? 'your household';
  const server = c.house ? `${c.house}'s server` : `the server at ${choice.where}`;
  // The server says whether its house is still empty; one that doesn't say is tried (it refuses if not).
  const bring = c.empty !== false && !!c.isOwner;
  return (
    <Sheet title={bring ? `Bring ${hh} onto your server?` : `Join ${server}?`} onClose={onClose}>
      {bring ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            The server is new, so {hh} can move onto it as it is: its phones, list, pantry and prices. The server becomes the house and does the owner
            phone's job. The other phones are asked to connect next time they sync with this one.
          </p>
          <button className="btn primary block" onClick={() => onPick('bring')}>
            Bring {hh} onto the server
          </button>
          <button className="btn block" onClick={() => onPick('leave')}>
            Leave {hh} and join with this phone's things
          </button>
        </>
      ) : c.empty !== false && !c.isOwner && (c.members ?? 1) > 1 ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            Bring your household onto this server from {c.owner ? `${c.owner}'s phone` : 'the owner phone'}, or leave {hh} and start the server's house
            with this phone's things.
          </p>
          <button className="btn block" onClick={() => onPick('leave')}>
            Leave {hh} and join
          </button>
        </>
      ) : (
        <>
          <p className="small" style={{ margin: 0 }}>
            This phone will leave {hh} and its things will join {server}. Where both have something, the server's copy wins. Nothing is deleted on{' '}
            {hh}'s other phones.
          </p>
          <button className="btn primary block" onClick={() => onPick('leave')}>
            Leave {hh} and join
          </button>
        </>
      )}
      <button className="btn block" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}

// ---------- 3 · joined (v3): the house's card ----------

function HouseCard({ info, onInfo }: { info: SyncInfo; onInfo: (i: SyncInfo) => void }) {
  const nav = useNav();
  const [sharing, setSharing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [working, setWorking] = useState<string>();
  const [error, setError] = useState<string>();
  const label = serverName(info);
  const keep = info.serverRow?.keepMonths;
  const phones = (info.members ?? []).filter((m) => !m.device.startsWith('srv-')).length;

  const scanWeb = async () => {
    setError(undefined);
    const out = await scanBarcode("Scan the code on your server's sign-in page", {
      accept: webPageCode,
      qr: true,
      wrong: "That isn't a code from your Restock server's page. On the computer, choose Sign in with a phone and scan the code it shows.",
      typeHint: 'Or paste the code',
    });
    if (!out.ok) return;
    let w: { kind: 'link' | 'login'; host: string };
    try {
      w = await RestockNative.syncWebCode({ code: out.code });
    } catch (e) {
      setError(errText(e));
      return;
    }
    const ok = await confirmAction(`Sign in to Restock on ${w.host}?`, {
      detail: `The browser showing the code (at ${w.host}) can see and change your house's list, pantry and prices until it signs out. Only say yes if you're signing in on that page yourself, right now. If someone sent you this code or asked you to scan it, say no.`,
      action: 'Sign in',
    });
    if (!ok) return;
    setWorking('Signing the browser in…');
    try {
      await RestockNative.syncWebApprove({ code: out.code });
      nav.toast(`Signed in on ${w.host}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setWorking(undefined);
    }
  };

  const moved = [info.serverPrices ? plural(info.serverPrices, 'older price') : '', info.serverPhotos ? plural(info.serverPhotos, 'receipt photo') : '']
    .filter(Boolean)
    .join(' and ');
  return (
    <>
      <div className="card" style={{ gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="sync-house-ic">
            <Icon name="home" size={20} />
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
            <strong style={{ fontSize: 17 }}>{label}</strong>
            <span className="small">
              Your Restock server{info.household ? `, ${info.household}` : ''}
              {phones ? ` · ${plural(phones, 'phone')}` : ''}
            </span>
          </span>
        </div>
        <span className="small" role="status">
          {info.serverError ??
            (info.serverAt
              ? `Synced ${agoText(info.serverAt)}${info.serverReached && info.serverReached === info.serverAway ? ' (away address)' : ''}.`
              : 'Connected. Syncing in the background.')}
        </span>
        <span className="small">
          At home: {addressText(info.serverHome) || 'not set'}
          {info.serverAway ? ` · Away: ${addressText(info.serverAway)}` : ''}
        </span>
        <span className="small">
          {serverKeepText(keep)} This phone keeps your "Keep price history for" and moves older prices there{moved ? `: ${moved} so far` : ''}.
        </span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn small primary" aria-expanded={sharing} onClick={() => setSharing((s) => !s)}>
            What this phone shares
          </button>
          <button className="btn small" disabled={!!working} onClick={() => void scanWeb()}>
            <Icon name="scan" size={16} /> Sign in on a computer
          </button>
        </div>
        {working && (
          <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="small">{working}</span>
            <LoadingBar seconds={8} />
          </div>
        )}
        {error && (
          <div className="banner amber" role="alert">
            {error}
          </div>
        )}
      </div>

      {sharing && <SharesEditor info={info} onInfo={onInfo} />}

      <div className="eyebrow">Phones on {label}</div>
      <div className="card flush">
        {(info.members ?? [])
          .filter((m) => !m.device.startsWith('srv-'))
          .map((m) => (
            <div key={m.device} className="row">
              <Icon name="phone" size={18} />
              <span className="grow">
                <span className="title" style={{ fontSize: 15 }}>
                  {m.me ? (m.name === 'This phone' ? 'This phone' : `${m.name} (this phone)`) : m.name}
                </span>
                <span className="small">On the server</span>
              </span>
            </div>
          ))}
        <p className="small" style={{ padding: '4px 14px 12px', margin: 0 }}>
          Phones are added and removed on the server's page.
        </p>
      </div>

      <div className="card flush">
        <button className="row" onClick={() => nav.push({ name: 'sync' })}>
          <Icon name="wifi" size={18} />
          <span className="grow">
            <span className="title" style={{ fontSize: 15 }}>
              Wi-Fi sync (optional)
            </span>
            <span className="small">
              {!wifiSyncOn(info) ? 'Off. Phones swapping changes straight to each other on your Wi-Fi, if you set it up.' : 'On. This phone swaps changes with other phones on your Wi-Fi.'}
            </span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
      </div>

      <div className="eyebrow">Leave this server</div>
      <div className="card flush">
        <button className="row" onClick={() => setLeaving(true)}>
          <Icon name="close" size={18} />
          <span className="grow">
            <span className="title" style={{ fontSize: 15, color: 'var(--red-ink)' }}>
              Leave this server
            </span>
            <span className="small">
              This phone keeps everything it has now and stops syncing with {label}. Nothing is deleted on the server. You'll be asked to confirm.
            </span>
          </span>
        </button>
      </div>
      {leaving && (
        <LeaveServerSheet
          info={info}
          onClose={() => setLeaving(false)}
          onDone={(i) => {
            setLeaving(false);
            onInfo(i);
            nav.toast(`This phone has left ${label}`);
          }}
        />
      )}
    </>
  );
}

/**
 * What this phone shares, changed later. 0.9.5 (save): held until Save settings, with the "Also
 * take it off the server" question still asked when a switch goes off; both are done on Save.
 */
export function SharesEditor({ info, onInfo }: { info: SyncInfo; onInfo: (i: SyncInfo) => void }) {
  const nav = useNav();
  const draft = useDraftState();
  const [value, setValue] = useState<Shares>(sharesOf(info));
  const takeBacks = useRef<Set<TakeBack>>(new Set());
  useEffect(() => {
    setValue(sharesOf(info));
    takeBacks.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.myTabs?.join(), info.shareReceipts, info.shareCards, draft.epoch]);
  const change = async (v: Shares, takeBack?: TakeBack) => {
    setValue(v);
    for (const t of [...takeBacks.current]) if (stillShared(v, t)) takeBacks.current.delete(t);
    if (takeBack) takeBacks.current.add(takeBack);
    const tbs = [...takeBacks.current];
    await stage(
      'shares',
      v,
      async () => {
        const i = await saveShares(v, tbs, info);
        await showSharedTabs(v);
        onInfo(i);
        if (tbs.length) nav.toast('Saved. It comes off the server at the next sync');
      },
      sharesOf(info),
    );
  };
  return (
    <>
      <div className="eyebrow">What this phone shares</div>
      <SharesPicker value={value} onChange={(v, t) => void change(v, t)} />
      <p className="small group-note">
        Not shared stays on this phone only. Turning something off keeps what it already shared on the server, unless you also take it off there.
      </p>
    </>
  );
}

// ---------- the owner phone on a 0.9.3-style server: hand the household over (section 7) ----------

function HandoverCard({ info, onInfo }: { info: SyncInfo; onInfo: (i: SyncInfo) => void }) {
  const nav = useNav();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const hh = info.household ?? 'your household';
  const go = async () => {
    setError(undefined);
    const out = await scanBarcode("Scan the code on your server's Take this household page", {
      accept: handoverCode,
      qr: true,
      wrong: "That isn't the server's Take this household code. On the server's page, open Server and phones → Take this household.",
      typeHint: 'Or paste the code',
    });
    if (!out.ok) return;
    const ok = await confirmAction(`Hand ${hh} to your server?`, {
      detail:
        "The server becomes the household's owner: it adds and removes phones, and keeps the household's key, so it can read what the phones share with it (to merge it, keep history and show Restock in a browser). The other phones carry on; each one updates to Restock 0.9.4 or newer to keep syncing with the server.",
      action: 'Hand it over',
      danger: false,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const i = await RestockNative.syncHandOverServer({ code: out.code });
      onInfo(i);
      nav.toast(i.house ? `${hh} is on your server now` : 'Handed over. This phone lets go once the server says so, at the next sync');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ gap: 8, borderColor: 'var(--green)' }}>
      <span className="eyebrow green" style={{ margin: 0 }}>
        Your server can do more
      </span>
      <strong style={{ fontSize: 15 }}>Hand this household to the server</strong>
      <span className="small">
        Your server can be the house: it does the owner phone's job around the clock, keeps years of prices, and gives you Restock in a browser with no
        linking. This phone stays the owner until the server has taken over, so nothing is lost if something goes wrong part way.
      </span>
      <ol className="small" style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <li>On a computer, sign in on the server's page.</li>
        <li>Open Server and phones → Take this household.</li>
        <li>Scan the code it shows with this phone.</li>
      </ol>
      {info.serverHandover && !info.house && (
        <span className="small" role="status">
          Handed over {agoText(new Date(Number(info.serverHandover)).toISOString())}. Waiting for the server's change to reach this phone; it does at the next sync.
        </span>
      )}
      <button className="btn primary" disabled={busy || !syncAvailable()} onClick={() => void go()}>
        <Icon name="scan" size={18} /> {busy ? 'Handing over…' : "Scan the server's code"}
      </button>
      {busy && <LoadingBar seconds={10} />}
      {error && (
        <div className="banner amber" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

// ---------- the screen ----------

export function RestockServerScreen() {
  useSettingsDraft(); // 0.9.5 (save): what this phone shares waits for Save settings
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const [info, setInfo] = useState<SyncInfo>();
  const [joined, setJoined] = useState<{ label?: string | null; houseName?: string | null } | undefined>(() => demoSync()?._joined);
  const [choice, setChoice] = useState<HouseChoice>();
  const [working, setWorking] = useState<string>();
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<string>();
  useEffect(() => {
    let live = true;
    const load = () => void syncInfo().then((i) => live && setInfo(i));
    load();
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  // The owner phone on a 0.9.3-style server: is it a 0.9.4 server waiting for the household?
  const v2Owner = !!info?.server && info.serverApi === 2 && !!info.isOwner;
  useEffect(() => {
    if (!v2Owner || !syncAvailable() || demoSync()) return;
    void RestockNative.syncServerHealth().then((h) => setMode(h.mode), () => undefined);
  }, [v2Owner]);
  const p = settings && info ? protection(settings.autoBackup.enabled, info) : undefined;

  const run = async (what: string, job: () => Promise<void>) => {
    setError(undefined);
    setWorking(what);
    try {
      await job();
    } catch (e) {
      setError(errText(e));
    } finally {
      setWorking(undefined);
    }
  };

  const join3 = (code: string, how: 'join' | 'bring' | 'leave') =>
    run(how === 'bring' ? 'Bringing your household onto the server…' : how === 'leave' ? 'Leaving your household, then joining the server…' : 'Joining your server…', async () => {
      const r = await RestockNative.syncJoinServer3({ code, how });
      if (r.notEmpty) {
        // The server already has a house: this phone can leave its household and join that instead.
        const c = await RestockNative.syncCheckServer({ code });
        setChoice({ check: { ...c, empty: false }, code, where: serverCodeAddresses(code)[0] ?? 'your server' });
        return;
      }
      setInfo(r);
      if (r.member) {
        // The household already lives on this server: connected as the member it is, sharing what it shares.
        const s = await RestockNative.syncNow();
        setInfo(s);
        nav.toast('Connected to your server');
        return;
      }
      if (how === 'bring') {
        // The household's own sharing carries on; a sync now lets the server see it.
        const s = await RestockNative.syncNow();
        setInfo(s);
        nav.toast(syncNowMessage(s));
      } else setJoined({ label: r.label, houseName: r.houseName });
    });

  /** A phone with no household joining a 0.9.3-style (v2) server: it starts one first, as in 0.9.3. */
  const joinV2 = async (code: string, where: string[]) => {
    if (!info?.paired) {
      const name = info?.household ?? settings?.household.name ?? 'Our house';
      const sure = await confirmAction(`Start your household, "${name}"?`, {
        detail: "This phone isn't in a household yet, so it becomes the owner. This server is an older one (Restock server 0.9.3); updating it lets the server be the house instead.",
        action: 'Start it',
        danger: false,
      });
      if (!sure) return;
      const tabs = settings ? SECTIONS.filter((t) => t === 'pantry' || sectionOn(settings, t)) : (['pantry'] as Section[]);
      setInfo(await RestockNative.syncStartHousehold({ household: name, shareCards: false, tabs }));
    }
    const sure = await confirmAction(`Connect to the Restock server at ${where[0]}?`, {
      detail:
        (where[1] ? `Away from home: ${where[1]}. ` : '') +
        "Your household's list, pantry and recent prices go there, sealed so the server can't read them. Only connect to a server you or your household run.",
      action: 'Connect',
      danger: false,
    });
    if (!sure) return;
    await run('Joining your Restock server…', async () => {
      const i = await RestockNative.syncJoinServer({ code });
      setInfo(i);
      nav.toast(i.serverError ?? 'Connected to your Restock server');
    });
  };

  const scan = async () => {
    setError(undefined);
    const out = await scanBarcode("Scan the code on your server's Add a phone page", {
      accept: serverCode,
      qr: true,
      wrong: "That isn't a Restock server code. On a computer, sign in to your server's page and choose Add a phone.",
      typeHint: 'Or paste the code',
    });
    if (!out.ok) return;
    const where = serverCodeAddresses(out.code);
    if (serverCodeVersion(out.code) === 2) return joinV2(out.code, where.length ? where : ['your server']);
    let check: ServerCodeCheck;
    try {
      setWorking('Checking the code…');
      check = await RestockNative.syncCheckServer({ code: out.code });
    } catch (e) {
      setError(errText(e));
      return;
    } finally {
      setWorking(undefined);
    }
    const at = where[0] ?? 'your server';
    if (check.inHousehold && check.sameHouse) {
      return run('Connecting to your server…', async () => {
        setInfo(await RestockNative.syncJoinHouse());
        nav.toast('Connected to your server');
      });
    }
    if (check.inHousehold) return setChoice({ check, code: out.code, where: at });
    const sure = await confirmAction(`Join ${check.house ? `${check.house}'s server` : `the server at ${at}`}?`, {
      detail:
        (where[1] ? `Away from home: ${where[1]}. ` : '') +
        "This phone joins the server's house. Next you pick what it shares; until then only groceries. Only join a server you or your household run.",
      action: 'Join',
      danger: false,
    });
    if (sure) await join3(out.code, 'join');
  };

  const connectHouse = () =>
    run('Connecting to your server…', async () => {
      setInfo(await RestockNative.syncJoinHouse());
      nav.toast('Connected to your server');
    });

  const v3 = !!info?.server && info.serverApi === 3;
  return (
    <div className="screen">
      <TopBar title={joined ? 'Join your server' : v3 ? serverName(info) : 'Restock server'} />

      {!syncAvailable() && (
        <div className="banner grey">
          <strong>The Restock server works in the Android app</strong>
          <span style={{ fontSize: 13 }}>In this preview everything stays in this browser.</span>
        </div>
      )}

      {info?.notice === 'server-removed' && (
        <div className="banner amber" role="status">
          <strong>This phone was taken off your server</strong>
          <span style={{ fontSize: 13 }}>It kept everything it had. To come back, scan a new code from the server's Add a phone page.</span>
          <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => void RestockNative.syncDismissNotice().then(() => syncInfo().then(setInfo))}>
            OK
          </button>
        </div>
      )}

      {info && joined && (
        <JoinedPage
          joined={joined}
          info={info}
          onDone={(i, msg) => {
            setJoined(undefined);
            setInfo(i);
            nav.toast(msg);
          }}
        />
      )}

      {info && !joined && v3 && <HouseCard info={info} onInfo={setInfo} />}

      {info && !joined && info.server && !v3 && (
        <>
          {v2Owner && (mode === 'v2' || !!info.serverHandover || !!demoSync()) && <HandoverCard info={info} onInfo={setInfo} />}
          <div className="eyebrow">Connected</div>
          <ServerCard info={info} busy={false} onInfo={setInfo} />
        </>
      )}

      {info && !joined && !info.server && (
        <>
          {info.serverOffer && (
            <div className="banner green" role="status" style={{ gap: 8 }}>
              <strong>Your household now lives on {info.household ? `${info.household}'s` : 'its'} server</strong>
              <span style={{ fontSize: 13 }}>Connect this phone? It keeps sharing what it shares now, and syncs at home and away.</span>
              <button className="btn small primary" style={{ alignSelf: 'flex-start' }} disabled={!!working} onClick={() => void connectHouse()}>
                Connect this phone
              </button>
            </div>
          )}
          <div className="card" style={{ gap: 8 }}>
            <span className="eyebrow green" style={{ margin: 0 }}>
              Recommended
            </span>
            <strong style={{ fontSize: 17 }}>Your Restock server</strong>
            <span className="small">
              Your server is the house: phones join it. It syncs around the clock, at home and away, keeps everything for years, and gives you Restock
              on your computer. It runs on a NAS, mini PC, Raspberry Pi or Home Assistant. Still no account, and the makers of Restock never see any of it.
            </span>
            <button className="btn primary" disabled={!syncAvailable() || !!working} onClick={() => void scan()}>
              <Icon name="scan" size={18} /> Scan the code from your server's Add a phone page
            </button>
            <span className="small">On a computer, open your server's page, sign in and choose Add a phone. Each code works once, for 10 minutes.</span>
          </div>
          <div className="card" style={{ gap: 6 }}>
            <strong>Don't have a server yet?</strong>
            <span className="small">
              One <code>docker run</code> command sets it up on a NAS or home server, or install it as an app in Home Assistant:{' '}
              <a href="https://github.com/d-plenty/restock-server" target="_blank" rel="noreferrer">
                how to set up a Restock server
              </a>
              .
            </span>
          </div>
        </>
      )}

      {working && (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="small">{working}</span>
          <LoadingBar seconds={10} />
        </div>
      )}
      {error && (
        <div className="banner amber" role="alert">
          {error}
        </div>
      )}

      {p?.server && p.suggestLocal && !joined && <SuggestLocalBackup text={suggestLocalText(p)} />}

      <SaveBar onlyWhenChanged />
      {choice && (
        <HouseChoiceSheet
          choice={choice}
          onClose={() => setChoice(undefined)}
          onPick={(how) => {
            const c = choice;
            setChoice(undefined);
            void join3(c.code, how);
          }}
        />
      )}
    </div>
  );
}
