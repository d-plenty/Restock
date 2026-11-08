import { useEffect, useState } from 'react';
import { scanBarcode } from '../../lib/barcode';
import { saveCopyInApp } from '../../lib/backup';
import { confirmAction } from '../../lib/confirm';
import { allGroups, allProducts, getSettings, updateSettings } from '../../lib/db';
import { CARRIED_TILES, householdSettingsFor } from '../../lib/household';
import { SECTIONS, sectionOn, shopDef, type Section } from '../../shops';
import type { Settings } from '../../types';
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
  const [known, setKnown] = useState<string[]>(info.members?.map((m) => m.device) ?? []);
  const [joined, setJoined] = useState<string>();
  const [tabs, setTabs] = useState<Section[]>();
  const name = household ?? info.household ?? settings?.household.name ?? 'Our house';
  const left = useCountdown(until);
  // Starting a household: share groceries, and Keg and Pharmacy if this phone uses them.
  const shared = tabs ?? (settings ? SECTIONS.filter((t) => t === 'pantry' || sectionOn(settings, t)) : ['pantry' as Section]);

  const make = async (shareCards: boolean) => {
    setError(undefined);
    try {
      const r = await RestockNative.syncInvite({ household: name, shareCards, tabs: shared });
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
  // Notice when the other phone has joined: a phone that wasn't in the household before, or one
  // rejoining whose old entry was still there (it has just synced).
  useEffect(() => {
    if (!code) return;
    const started = new Date().toISOString();
    const t = setInterval(() => {
      void syncInfo().then((i) => {
        const fresh = i.members?.find((m) => !m.me && !known.includes(m.device));
        const back = i.members?.find((m) => !m.me && (i.peers?.find((p) => p.device === m.device)?.syncedAt ?? '') > started && !fresh);
        const who = fresh ?? (i.lastSyncAt && i.lastSyncAt > started ? back : undefined);
        if (who) {
          setJoined(who.name);
          setKnown(i.members?.map((m) => m.device) ?? []);
          setCode(undefined);
        }
      });
    }, 2000);
    return () => clearInterval(t);
  }, [code, known]);
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
          <div className="eyebrow">What the household shares</div>
          <TabsPicker offered={SECTIONS} value={shared} onChange={setTabs} />
          <p className="small" style={{ marginTop: -4 }}>
            Each phone that joins picks from these. Not shared stays on each phone, like bottle shops in a share house. You can change it later.
          </p>
          {shared.length ? <CardsQuestion onAnswer={(share) => void make(share)} /> : <div className="banner amber">Pick at least one thing to share.</div>}
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
            <li>On the other phone (Restock 0.8.5 or newer), tap Join your household on the first screen, or Settings → Local sync → Join a household.</li>
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

/** The tabs a household can share, in plain words. */
export const SHARE_TABS: { tab: Section; title: string; sub: string }[] = [
  { tab: 'pantry', title: 'Groceries', sub: 'Pantry, its shopping list and prices' },
  { tab: 'keg', title: 'Bottle shops', sub: 'Keg tab · 18+' },
  { tab: 'pharmacy', title: 'Pharmacy', sub: 'Pharmacy tab' },
];

/** Ask "18 or over?" before anything Keg is shared to or from this phone. */
export async function askAdult(): Promise<boolean> {
  const s = await getSettings();
  if (s.adultConfirmed) return true;
  const yes = await confirmAction('Are you 18 or over?', {
    detail: 'The Keg tab tracks bottle shops, so it is only for adults.',
    action: "Yes, I'm 18 or over",
    danger: false,
  });
  if (yes) await updateSettings({ adultConfirmed: true });
  return yes;
}

/** Checkboxes for what to share: `offered` are the choices, `value` the ones ticked. */
export function TabsPicker({ offered, value, onChange, disabled }: { offered: Section[]; value: Section[]; onChange: (v: Section[]) => void; disabled?: boolean }) {
  return (
    <div className="card flush">
      {SHARE_TABS.filter((t) => offered.includes(t.tab)).map((t) => (
        <label key={t.tab} className="check">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.includes(t.tab)}
            onChange={async (e) => {
              if (e.target.checked && t.tab === 'keg' && !(await askAdult())) return;
              onChange(e.target.checked ? SECTIONS.filter((x) => x === t.tab || value.includes(x)) : value.filter((x) => x !== t.tab));
            }}
          />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 14 }}>
              {t.title}
            </span>
            <span className="small">{t.sub}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** After joining: take the household's shops and settings, and start what they turn on. */
export async function applyHouseholdSettings(json: string | undefined, opts: { tabs: Section[]; replace: boolean }): Promise<void> {
  try {
    const current = await getSettings();
    const next = json ? householdSettingsFor(current, JSON.parse(json) as Partial<Settings>, opts) : current;
    if (!json) {
      // An owner on 0.8.4 or older didn't send its settings: still mark the shared tiles done.
      const done = new Set([...current.setup.done, ...CARRIED_TILES, ...opts.tabs]);
      next.setup = { ...current.setup, done: [...done], skipped: current.setup.skipped.filter((t) => !done.has(t)) };
      for (const t of opts.tabs) if (t !== 'pantry') next.sections = { ...next.sections, [t]: true };
    }
    const s = await updateSettings(next);
    await syncBackgroundSchedule(s).catch(() => undefined);
    await scheduleReminders(s).catch(() => undefined);
    if (syncAvailable()) await RestockNative.scheduleRecalls({ enabled: s.recalls.enabled }).catch(() => undefined);
  } catch (e) {
    console.error('household settings', e);
  }
}

/**
 * This phone starts sharing `tab` (0.8.5): turns the tab on here, with the shops the household's
 * things on it come from, so it shows up without picking shops by hand.
 */
export async function shareTab(info: SyncInfo, tab: Section): Promise<SyncInfo | undefined> {
  if (tab === 'keg' && !(await askAdult())) return undefined;
  const mine = SECTIONS.filter((t) => t === tab || (info.tabs ?? info.myTabs ?? []).includes(t));
  const next = await RestockNative.syncSet({ tabs: mine });
  const s = await getSettings();
  const used = [...new Set((await allProducts()).map((p) => p.chain))].filter((c) => (shopDef(c)?.section ?? customShopTab(s, c)) === tab);
  await updateSettings({
    sections: tab === 'pantry' ? s.sections : { ...s.sections, [tab]: true },
    hiddenTabs: (s.hiddenTabs ?? []).filter((t) => t !== tab),
    enabledChains: [...new Set([...s.enabledChains, ...(used as Settings['enabledChains'])])],
    seenTabOffers: [...new Set([...(s.seenTabOffers ?? []), tab])],
  });
  return next;
}

const customShopTab = (s: Settings, chain: string) => s.customShops.find((c) => c.id === chain)?.section;

type JoinStep = 'look' | 'age' | 'tabs' | 'things' | 'cards';

/**
 * Joining with a code (0.8.5): asks the owner phone what the household shares, then
 * 18 or over (if it shares Keg), what this phone shares, what to do with this phone's own
 * things on those tabs, and whether to share loyalty cards. Then joins and takes the
 * household's shops and settings for the tabs it shares.
 */
export function JoinSheet({
  code,
  fresh,
  onClose,
  onJoined,
}: {
  code: string;
  /** From the first screen: nothing here yet, so no question about this phone's things. */
  fresh?: boolean;
  onClose: () => void;
  onJoined: (msg: string) => void;
}) {
  const groups = useLive(allGroups, []);
  const [step, setStep] = useState<JoinStep>('look');
  const [peek, setPeek] = useState<{ household?: string; ownerName?: string; tabs: Section[]; settings?: string }>();
  const [tabs, setTabs] = useState<Section[]>([]);
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const p = await RestockNative.syncPeek({ code });
        if (!alive) return;
        setPeek(p);
        const s = await getSettings();
        const offered = p.tabs.length ? p.tabs : SECTIONS;
        setTabs(offered);
        setStep(offered.includes('keg') && !s.adultConfirmed ? 'age' : 'tabs');
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [code]);

  const offered = peek?.tabs.length ? peek.tabs : SECTIONS;
  const mineInTabs = (groups ?? []).filter((g) => tabs.includes(g.section ?? 'pantry')).length;
  const where = peek?.household ?? 'the household';

  const answerAge = async (adult: boolean) => {
    if (adult) await updateSettings({ adultConfirmed: true });
    else {
      // Not 18: no Keg on this phone, whatever the household does.
      const s = await getSettings();
      await updateSettings({ sections: { ...s.sections, keg: false } });
      setTabs((t) => t.filter((x) => x !== 'keg'));
    }
    setStep('tabs');
  };

  const join = async (shareCards: boolean) => {
    setBusy(true);
    setError(undefined);
    const useTheirs = fresh || !mineInTabs || replace;
    try {
      // "Use the household's things" empties this phone's shared tabs first: keep a copy, just in case.
      if (useTheirs && !fresh && mineInTabs) await saveCopyInApp('backups/before-joining.json');
      const r = await RestockNative.syncJoin({ code, replace: useTheirs, shareCards, tabs });
      await applyHouseholdSettings(r.settings ?? peek?.settings, { tabs, replace: useTheirs });
      // What the household shared when joining was answered here: don't ask again on Home.
      const s = await getSettings();
      await updateSettings({ seenTabOffers: [...new Set([...(s.seenTabOffers ?? []), ...offered])] });
      onJoined(
        r.reached > 0
          ? `Joined ${r.household ?? where}. Synced with ${r.ownerName ?? 'the owner phone'}.`
          : `Joined ${r.household ?? where}. Syncing as soon as the phones find each other.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const keg = offered.includes('keg');
  return (
    <Sheet title={peek?.household ? `Join ${peek.household}` : 'Join your household'} onClose={busy ? () => undefined : onClose}>
      {busy ? (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="small">Joining and syncing with the owner phone…</span>
          <LoadingBar seconds={15} />
        </div>
      ) : step === 'look' ? (
        !error && (
          <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="small">Finding the owner phone…</span>
            <LoadingBar seconds={8} />
          </div>
        )
      ) : step === 'age' ? (
        <div className="card" style={{ gap: 10 }}>
          <strong>Are you 18 or over?</strong>
          <span className="small">
            {peek?.ownerName ?? 'The owner phone'} shares bottle shops (the Keg tab), which is only for adults. If not, this phone joins without it.
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" style={{ flex: 1 }} onClick={() => void answerAge(true)}>
              Yes, 18 or over
            </button>
            <button className="btn" style={{ flex: 1 }} onClick={() => void answerAge(false)}>
              No
            </button>
          </div>
        </div>
      ) : step === 'tabs' ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            {where} shares {offered.map((t) => SHARE_TABS.find((x) => x.tab === t)!.title.toLowerCase()).join(', ')}. Pick what this phone shares; the
            rest stays on this phone only. You can change it later in Settings → Local sync.
          </p>
          <TabsPicker offered={keg ? offered : offered.filter((t) => t !== 'keg')} value={tabs} onChange={setTabs} />
          <button className="btn primary block" disabled={!tabs.length} onClick={() => setStep(!fresh && mineInTabs ? 'things' : 'cards')}>
            Continue
          </button>
        </>
      ) : step === 'things' ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            This phone already has {mineInTabs} item{mineInTabs === 1 ? '' : 's'} in what it will share. What should happen to them?
          </p>
          <div className="card flush">
            <button className={`row choice${replace ? ' picked' : ''}`} aria-pressed={replace} onClick={() => setReplace(true)}>
              <Icon name="refresh" size={18} />
              <span className="grow">
                <span className="title" style={{ fontSize: 14, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  Use the household's things <span className="tag great">Recommended</span>
                </span>
                <span className="small">
                  No doubles. This phone's items, lists and prices in what it shares are swapped for the household's. A backup is saved first, and
                  the other phones aren't changed. Loyalty cards stay.
                </span>
              </span>
              {replace && <Icon name="check" size={18} stroke={3} />}
            </button>
            <button className={`row choice${!replace ? ' picked' : ''}`} aria-pressed={!replace} onClick={() => setReplace(false)}>
              <Icon name="plus" size={18} />
              <span className="grow">
                <span className="title" style={{ fontSize: 14 }}>
                  Combine with the household
                </span>
                <span className="small">Both keep their things and get each other's. You might see a few doubles to tidy up.</span>
              </span>
              {!replace && <Icon name="check" size={18} stroke={3} />}
            </button>
          </div>
          <button className="btn primary block" onClick={() => setStep('cards')}>
            Continue
          </button>
        </>
      ) : (
        <CardsQuestion onAnswer={(share) => void join(share)} />
      )}
      {error && (
        <div className="banner amber" role="alert">
          {error}
        </div>
      )}
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
          : 'It will be the one that adds and removes phones, and this phone becomes an ordinary member. That happens when the two phones next sync; until then this phone stays the owner, and you can cancel.',
      action: what === 'remove' ? 'Remove' : 'Make owner',
      danger: what === 'remove',
    });
    if (!ok) return;
    try {
      const info =
        what === 'remove' ? await RestockNative.syncRemove({ device: member.device }) : await RestockNative.syncHandOver({ device: member.device });
      onDone(info, what === 'remove' ? `${member.name} removed` : `${member.name} takes over as owner at the next sync`);
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

  const set = async (patch: { name?: string; shareCards?: boolean; keepReady?: boolean; tabs?: Section[]; householdTabs?: Section[] }) => {
    try {
      setInfo(await RestockNative.syncSet(patch));
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : String(e));
    }
  };

  const leave = async () => {
    const others = (info?.members ?? []).filter((m) => !m.me);
    if (info?.isOwner && others.length) {
      await confirmAction('Make another phone the owner first', {
        detail: info.handoverTo
          ? `Waiting for ${others.find((m) => m.device === info.handoverTo)?.name ?? 'the other phone'} to take over. Sync with it once (both phones on the same Wi-Fi), then stop syncing this phone.`
          : `This is the owner phone. Tap ${others[0].name} in the list above and choose "Make this the owner phone", sync once, then stop syncing this phone.`,
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

          {info.isOwner && info.handoverTo && (
            <div className="banner grey" role="status" style={{ gap: 8 }}>
              <strong>Waiting for {info.members?.find((m) => m.device === info.handoverTo)?.name ?? 'the other phone'} to take over</strong>
              <span style={{ fontSize: 13 }}>
                It becomes the owner next time it syncs with this phone. Until then, this phone stays the owner.
              </span>
              <button
                className="btn small"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => void RestockNative.syncCancelHandOver().then(setInfo, (e) => nav.toast(e instanceof Error ? e.message : String(e)))}
              >
                Cancel, stay the owner
              </button>
            </div>
          )}

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
                      {m.device === info.handoverTo && <span className="tag normal">Taking over</span>}
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

          <div className="eyebrow">What's shared</div>
          {info.isOwner && (
            <>
              <span className="small">The household shares:</span>
              <TabsPicker
                offered={SECTIONS}
                value={info.householdTabs ?? SECTIONS}
                onChange={(v) => {
                  if (!v.length) return nav.toast('Pick at least one thing to share.');
                  void set({ householdTabs: v });
                }}
              />
            </>
          )}
          <span className="small">
            {info.isOwner ? 'This phone shares:' : `${info.household ?? 'The household'} shares these. This phone shares the ticked ones:`}
          </span>
          <TabsPicker
            offered={info.householdTabs ?? SECTIONS}
            value={(info.myTabs ?? SECTIONS).filter((t) => (info.householdTabs ?? SECTIONS).includes(t))}
            onChange={(v) => {
              if (!v.length) return nav.toast('Pick at least one, or stop syncing this phone.');
              const added = v.find((t) => !(info.tabs ?? []).includes(t));
              if (added) void shareTab(info, added).then((i) => i && setInfo(i));
              else void set({ tabs: v });
            }}
          />
          <p className="small" style={{ marginTop: -4 }}>
            What isn't shared stays on this phone only. Turning one on brings the household's things for it across at the next sync.
          </p>

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
