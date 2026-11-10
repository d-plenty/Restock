import { useEffect, useState } from 'react';
import { scanBarcode } from '../../lib/barcode';
import { saveCopyInApp } from '../../lib/backup';
import { confirmAction } from '../../lib/confirm';
import { allGroups, allProducts, getSettings, reapplyHouseholdSettings, updateSettings } from '../../lib/db';
import { CARRIED_TILES, householdSettingsFor } from '../../lib/household';
import { chainName, enabledIn, SECTIONS, sectionOn, shopDef, type Section } from '../../shops';
import type { Settings } from '../../types';
import { RestockNative, type TakeBack } from '../../lib/sql/native';
import {
  agoText,
  MAX_SYNC_PHONES,
  pairingCode,
  serverCode,
  serverCodeAddresses,
  serverName,
  strictBatteryMaker,
  syncAvailable,
  syncInfo,
  syncNowMessage,
  webPageCode,
  type SyncInfo,
} from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { syncBackgroundSchedule } from '../../lib/check';
import { scheduleReminders } from '../../lib/notify';
import { Icon, LoadingBar, Sheet, TopBar } from '../components';
import { useNav } from '../nav';
// 0.9.5 (save): the sharing switches and this phone's name wait for Save settings.
import { stage } from '../../lib/settingsDraft';
import { SaveBar, useDraftState, useSettingsDraft } from '../SaveBar';

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
function PairingQr({ code, label = 'Pairing QR code' }: { code: string; label?: string }) {
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
    <div className="sync-qr" role="img" aria-label={label}>
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
            <li>On the other phone (Restock 0.8.5 or newer), tap Join your household on the first screen, or Settings → Sync and backups → Join a household.</li>
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
  { tab: 'pantry', title: 'Groceries', sub: 'Pantry, its shopping list (and General) and prices' },
  { tab: 'keg', title: 'Bottle shops', sub: 'Keg tab · 18+' },
  { tab: 'pharmacy', title: 'Health', sub: 'Health tab' },
];

/** 0.9.5 (save): changes to this phone's sync settings, held until Save (SyncScreen). */
type SyncPatch = {
  name?: string;
  shareCards?: boolean;
  keepReady?: boolean;
  tabs?: Section[];
  householdTabs?: Section[];
  householdReceipts?: boolean;
  /** Tabs turned on: their shops and settings come across too (shareTab). */
  addTabs?: Section[];
};

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
            <span className="title" style={{ fontSize: 15 }}>
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
    // 0.9.3: taken from the household, so this phone's only (never sent back as its own change),
    // then the household's settings as they are now (they came with the first sync).
    await updateSettings(next, { local: true });
    await reapplyHouseholdSettings().catch(() => false);
    const s = await getSettings();
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
  // 0.9.3: fitted to what's there on this phone only; the household's own shops for the tab win after.
  await updateSettings(
    {
      sections: tab === 'pantry' ? s.sections : { ...s.sections, [tab]: true },
      hiddenTabs: (s.hiddenTabs ?? []).filter((t) => t !== tab),
      enabledChains: [...new Set([...s.enabledChains, ...(used as Settings['enabledChains'])])],
      seenTabOffers: [...new Set([...(s.seenTabOffers ?? []), tab])],
    },
    { local: true },
  );
  await reapplyHouseholdSettings().catch(() => false);
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
            rest stays on this phone only. You can change it later in Settings → Sync and backups → Phones and sharing.
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
                <span className="title" style={{ fontSize: 15, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
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
                <span className="title" style={{ fontSize: 15 }}>
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
    wrong: "That isn't a Restock sync code. On the owner phone, open Settings → Sync and backups → Add a phone.",
    typeHint: 'Or paste the code',
  });
  return out.ok ? out.code : undefined;
}

// ---------- 0.9.0: the recovery key ----------

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Owner: the household's recovery key, to write down or keep in a password manager. */
function RecoverySheet({ saved, onClose, onDone }: { saved: boolean; onClose: () => void; onDone: (info: SyncInfo, msg?: string) => void }) {
  const nav = useNav();
  const [key, setKey] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    RestockNative.syncRecovery().then(
      (r) => setKey(r.key),
      (e) => setError(errText(e) === 'Not unlocked' ? 'Unlock the phone to see the recovery key.' : errText(e)),
    );
  }, []);
  const copy = async () => {
    if (!key) return;
    try {
      // 0.9.0: on the phone, marked sensitive (kept out of the clipboard preview and keyboards' history).
      await (syncAvailable() ? RestockNative.copyText({ text: key, sensitive: true }) : navigator.clipboard.writeText(key));
      nav.toast('Recovery key copied');
    } catch {
      nav.toast("Couldn't copy it. Write it down instead.");
    }
  };
  const fresh = async () => {
    const ok = await confirmAction('Make a new recovery key?', {
      detail: 'The one you have now stops working. Save the new one straight away.',
      action: 'Make a new one',
    });
    if (!ok) return;
    try {
      onDone(await RestockNative.syncRecoverySaved({ fresh: true }));
      setKey((await RestockNative.syncRecovery()).key);
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Sheet title="Recovery key" onClose={onClose}>
      <p className="small">
        If this phone is lost, broken or wiped, another phone in the household can take over as the owner with this key, and then add and remove
        phones again. Keep it somewhere safe that isn't this phone: a password manager, or written down at home.
      </p>
      <div className="banner amber" style={{ gap: 4 }}>
        <strong>Keep it private</strong>
        <span style={{ fontSize: 13 }}>Anyone with it and a phone in your household can take the household over.</span>
      </div>
      {error && <div className="banner amber">{error}</div>}
      {key ? (
        <>
          <code className="recovery-key" aria-label="Recovery key">
            {key}
          </code>
          <details className="sync-code">
            <summary className="small">Show it as a QR code</summary>
            <PairingQr code={`RESTOCK-RECOVERY:${key}`} label="Recovery key QR code" />
          </details>
          <button className="btn" onClick={() => void copy()}>
            Copy
          </button>
          <button
            className="btn primary"
            onClick={() =>
              void RestockNative.syncRecoverySaved({ key }).then(
                (i) => onDone(i, saved ? undefined : 'Recovery key saved'),
                (e) => setError(errText(e)),
              )
            }
          >
            <Icon name="check" size={18} /> {saved ? 'Done' : "I've saved it"}
          </button>
          <button className="btn ghost small" onClick={() => void fresh()}>
            Make a new recovery key
          </button>
        </>
      ) : (
        !error && <LoadingBar seconds={2} />
      )}
    </Sheet>
  );
}

/** Another phone: take over as the owner with the recovery key (the owner phone was lost). */
function TakeOverSheet({ ownerName, onClose, onDone }: { ownerName?: string; onClose: () => void; onDone: (info: SyncInfo) => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    const out = await scanBarcode('Scan the recovery key', {
      accept: (t: string) => (/^RESTOCK-RECOVERY:/i.test(t.trim()) ? t.trim() : undefined),
      qr: true,
      wrong: "That isn't a Restock recovery key.",
      typeHint: 'Or type it',
    });
    if (out.ok) setKey(out.code.replace(/^RESTOCK-RECOVERY:/i, ''));
  };
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await RestockNative.syncTakeOver({ key }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Take over as the owner" onClose={onClose}>
      <p className="small">
        For when the owner phone{ownerName ? ` (${ownerName})` : ''} is lost, broken or wiped. Enter the household's recovery key and this phone
        becomes the owner: it can add and remove phones. Then remove the lost phone, so it can't sync again.
      </p>
      <p className="small">Every phone in the household needs Restock 0.9.0 or newer to see the change.</p>
      <label className="field">
        <span>Recovery key</span>
        <input
          className="input"
          value={key}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="ABCD-EFGH-…"
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <button className="btn" onClick={() => void scan()}>
        <Icon name="scan" size={18} /> Scan its QR code
      </button>
      {error && <div className="banner amber">{error}</div>}
      <button className="btn primary" disabled={busy || key.replace(/[^a-z0-9]/gi, '').length < 32} onClick={() => void go()}>
        {busy ? 'Taking over…' : 'Take over'}
      </button>
    </Sheet>
  );
}

/** What the owner can do with another phone. */
function MemberSheet({
  member,
  server,
  onClose,
  onDone,
}: {
  member: { device: string; name: string };
  /** 0.9.2: this phone uses a Restock server. */
  server?: boolean;
  onClose: () => void;
  onDone: (info: SyncInfo, msg: string) => void;
}) {
  const [error, setError] = useState<string>();
  const run = async (what: 'remove' | 'owner') => {
    const ok = await confirmAction(what === 'remove' ? `Remove ${member.name} from the household?` : `Make ${member.name} the owner?`, {
      detail:
        what === 'remove'
          ? "It stops syncing straight away, and the household's key changes so it can't sync again, even with an old code. It keeps what it has now. The other phones get the new key next time they sync with this one." +
            (server ? " It can't open anything new on your Restock server either; to take it off the server's list too, remove it on the server's Phones page." : '')
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

// ---------- 0.9.1: sync away from home ----------

/** The three ways to sync away from home. */
function AwayChoices({ disabled, onPick }: { disabled?: boolean; onPick: (kind: 'nextcloud' | 'webdav' | 'folder') => void }) {
  return (
    <div className="card flush">
      <button className="row" disabled={disabled} onClick={() => onPick('nextcloud')}>
        <Icon name="external" size={18} />
        <span className="grow">
          <span className="title" style={{ fontSize: 15 }}>
            Sign in to Nextcloud
          </span>
          <span className="small">Your own Nextcloud, or one from a provider. Restock gets a password of its own.</span>
        </span>
        <Icon name="chevron" size={18} />
      </button>
      <button className="row" disabled={disabled} onClick={() => onPick('webdav')}>
        <Icon name="box" size={18} />
        <span className="grow">
          <span className="title" style={{ fontSize: 15 }}>
            Other WebDAV server
          </span>
          <span className="small">ownCloud, Synology, QNAP, TrueNAS, Koofr, pCloud, kDrive, Box and others.</span>
        </span>
        <Icon name="chevron" size={18} />
      </button>
      <button className="row" disabled={disabled} onClick={() => onPick('folder')}>
        <Icon name="folder" size={18} />
        <span className="grow">
          <span className="title" style={{ fontSize: 15 }}>
            Pick a folder on this phone
          </span>
          <span className="small">One that Syncthing (or a similar app) keeps the same on every phone.</span>
        </span>
        <Icon name="chevron" size={18} />
      </button>
    </div>
  );
}

/** The folder name field, the same for Nextcloud and other servers. */
function FolderField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>Folder for Restock</span>
      <input className="input" value={value} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/**
 * "Sign in to Nextcloud" (Nextcloud's Login Flow v2): Restock opens the sign-in page in the
 * browser, the person signs in there and allows Restock, and Nextcloud gives Restock an app
 * password of its own.
 */
function NextcloudSheet({ onClose, onDone }: { onClose: () => void; onDone: (info: SyncInfo) => void }) {
  const [server, setServer] = useState('');
  const [folder, setFolder] = useState('Restock');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const go = async () => {
    setError(undefined);
    setWaiting(true);
    try {
      const r = await RestockNative.syncNextcloud({ server: server.trim(), folder: folder.trim() });
      if (r.cancelled) setWaiting(false);
      else onDone(r);
    } catch (e) {
      setError(errText(e));
      setWaiting(false);
    }
  };
  const cancel = () => void RestockNative.syncNextcloudCancel().catch(() => undefined);
  return (
    <Sheet
      title="Sign in to Nextcloud"
      onClose={() => {
        if (waiting) cancel();
        onClose();
      }}
    >
      {waiting ? (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <strong>Finish signing in in your browser</strong>
          <span className="small">Sign in to your Nextcloud there and tap Grant access. Then come back to Restock; it carries on by itself.</span>
          <LoadingBar seconds={60} />
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <p className="small" style={{ margin: 0 }}>
            Restock opens your Nextcloud's sign-in page in your browser. Nextcloud then gives Restock a password of its own, so your own password
            never reaches Restock. You can take it away any time in Nextcloud's settings, under Security.
          </p>
          <label className="field">
            <span>Your Nextcloud's address</span>
            <input
              className="input"
              value={server}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="cloud.example.com"
              onChange={(e) => setServer(e.target.value)}
            />
          </label>
          <FolderField value={folder} onChange={setFolder} />
          <p className="small" style={{ marginTop: -4 }}>
            Made if it isn't there. Every phone in the household needs the same folder: sign in with the same Nextcloud account, or share the folder
            with each other in Nextcloud.
          </p>
          {error && (
            <div className="banner amber" role="alert">
              {error}
            </div>
          )}
          <button className="btn primary" disabled={!server.trim()} onClick={() => void go()}>
            <Icon name="external" size={18} /> Sign in
          </button>
        </>
      )}
    </Sheet>
  );
}

/** Other WebDAV servers: an address, a user name and a password. */
function WebDavSheet({ onClose, onDone }: { onClose: () => void; onDone: (info: SyncInfo) => void }) {
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [folder, setFolder] = useState('Restock');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = async () => {
    setError(undefined);
    setBusy(true);
    try {
      onDone(await RestockNative.syncSetWebDav({ url: url.trim(), user: user.trim(), password, folder: folder.trim() }));
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title="Other WebDAV server" onClose={busy ? () => undefined : onClose}>
      <p className="small" style={{ margin: 0 }}>
        For ownCloud, Synology, QNAP, TrueNAS, Koofr, pCloud, kDrive, Box and other servers with WebDAV. Your server's or provider's help pages give
        its WebDAV address.
      </p>
      <label className="field">
        <span>WebDAV address</span>
        <input
          className="input"
          value={url}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://dav.example.com/"
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="field">
        <span>User name</span>
        <input
          className="input"
          value={user}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
          onChange={(e) => setUser(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Password</span>
        <input className="input" type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
      </label>
      <p className="small" style={{ marginTop: -4 }}>
        Many providers want an app password here (you make one in their settings), not your main one. It stays on this phone only, locked away,
        and is never synced or put in a backup.
      </p>
      <FolderField value={folder} onChange={setFolder} />
      <p className="small" style={{ marginTop: -4 }}>
        Made if it isn't there. Use https:// unless the server is at home (like 192.168.1.20) or on Tailscale.
      </p>
      {error && (
        <div className="banner amber" role="alert">
          {error}
        </div>
      )}
      <button className="btn primary" disabled={busy || !url.trim() || !user.trim()} onClick={() => void go()}>
        {busy ? 'Checking the server…' : 'Connect'}
      </button>
      {busy && <LoadingBar seconds={10} />}
    </Sheet>
  );
}

// ---------- 0.9.2: the Restock server ----------

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const addressText = (a?: string | null) => (a ?? '').replace(/^https?:\/\//i, '');

/**
 * The Restock server: a card of its own, so a phone can use it alongside Wi-Fi sync and the
 * away-from-home choice. Join with the code on the server's Add a phone page; once joined, scan the
 * web page's code to let a browser see the household (or sign in there).
 */
export function ServerCard({ info, busy, onInfo }: { info: SyncInfo; busy: boolean; onInfo: (i: SyncInfo) => void }) {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  // 0.9.3: a phone that isn't in a household starts one first (it becomes the owner); the server
  // seals everything with the household's key.
  const householdName = info.household ?? settings?.household.name ?? 'Our house';
  const [working, setWorking] = useState<string>();
  const [error, setError] = useState<string>();
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

  const startHousehold = async (): Promise<boolean> => {
    const sure = await confirmAction(`Start your household, "${householdName}"?`, {
      detail:
        "This phone isn't in a household yet, so it becomes the owner: it adds and removes the other phones. Your pantry, list and prices are shared; loyalty cards stay on each phone. Change the name or what's shared later in Sync and backups.",
      action: 'Start it',
      danger: false,
    });
    if (!sure) return false;
    try {
      const tabs = settings ? SECTIONS.filter((t) => t === 'pantry' || sectionOn(settings, t)) : (['pantry'] as Section[]);
      const i = await RestockNative.syncStartHousehold({ household: householdName, shareCards: false, tabs });
      if (settings && !settings.household.name) await updateSettings({ household: { name: householdName } });
      onInfo(i);
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  };

  const join = async () => {
    setError(undefined);
    if (!info.paired && !(await startHousehold())) return;
    const out = await scanBarcode("Scan the code on your server's Add a phone page", {
      accept: serverCode,
      qr: true,
      wrong: "That isn't a Restock server code. On a computer, sign in to your server's page and choose Add a phone.",
      typeHint: 'Or paste the code',
    });
    if (!out.ok) return;
    // Say where it goes first: a code someone else made could point at their server.
    const where = serverCodeAddresses(out.code);
    if (where.length) {
      const sure = await confirmAction(`Connect to the Restock server at ${where[0]}?`, {
        detail:
          (where[1] ? `Away from home: ${where[1]}. ` : '') +
          "Your household's list, pantry and recent prices go there, sealed so the server can't read them, and older prices and receipt photos move there. Only connect to a server you or your household run.",
        action: 'Connect',
        danger: false,
      });
      if (!sure) return;
    }
    await run('Joining your Restock server…', async () => {
      const i = await RestockNative.syncJoinServer({ code: out.code });
      onInfo(i);
      nav.toast(i.serverError ?? 'Connected to your Restock server');
    });
  };

  const scanWeb = async () => {
    setError(undefined);
    const out = await scanBarcode("Scan the code on your server's web page", {
      accept: webPageCode,
      qr: true,
      wrong: "That isn't a code from your Restock server's web page. Open the page on the computer and scan the code it shows.",
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
    const ok = await confirmAction(w.kind === 'link' ? 'Let this browser see your household?' : `Sign in to Restock on ${w.host}?`, {
      detail:
        w.kind === 'link'
          ? `The browser showing the code (at ${w.host}) gets the key to your household's files on the server, so it can show and change your list, pantry and prices. It keeps it, locked with your passphrase. Only say yes for a browser you're using right now. If someone sent you this code or asked you to scan it, say no.`
          : `The browser showing the code (at ${w.host}) can see and change your household's list, pantry and prices until it signs out. Only say yes if you're signing in on that page yourself, right now. If someone sent you this code or asked you to scan it, say no.`,
      action: w.kind === 'link' ? 'Let it see' : 'Sign in',
    });
    if (!ok) return;
    await run(w.kind === 'link' ? 'Passing the key to the browser…' : 'Signing the browser in…', async () => {
      await RestockNative.syncWebApprove({ code: out.code });
      nav.toast(w.kind === 'link' ? 'Done. That browser can see your household now' : `Signed in on ${w.host}`);
    });
  };

  const stop = async () => {
    const photos = info.serverPhotos ?? 0;
    const ok = await confirmAction('Stop syncing through the Restock server?', {
      detail:
        (photos ? `${plural(photos, 'receipt photo')} kept on the server come back onto this phone first. ` : '') +
        "Older prices this phone moved there stay on the server. This phone comes off the server's list; Wi-Fi sync and sync away from home carry on.",
      action: 'Stop',
    });
    if (!ok) return;
    setError(undefined);
    setWorking(photos ? 'Bringing the photos back…' : 'Stopping…');
    try {
      onInfo(await RestockNative.syncStopServer({ bringBack: true }));
      nav.toast('Stopped using the Restock server');
    } catch (e) {
      setWorking(undefined);
      const anyway = await confirmAction("Couldn't bring the photos back", {
        detail: `${errText(e)} If you stop anyway, those photos stay on the server and this phone can't show them.`,
        action: 'Stop anyway',
        danger: true,
      });
      if (anyway) {
        try {
          onInfo(await RestockNative.syncStopServer({ bringBack: false }));
          nav.toast('Stopped using the Restock server');
        } catch (e2) {
          setError(errText(e2));
        }
      }
    } finally {
      setWorking(undefined);
    }
  };

  const moved = [info.serverPrices ? plural(info.serverPrices, 'older price') : '', info.serverPhotos ? plural(info.serverPhotos, 'receipt photo') : '']
    .filter(Boolean)
    .join(' and ');
  return (
    <div className="card" style={{ gap: 8 }}>
      {info.server ? (
        <>
          <span className="title" style={{ fontSize: 15 }}>
            Syncing through your Restock server
          </span>
          <span className="small">
            {info.serverError ??
              (info.serverAt
                ? `Last synced through the server ${agoText(info.serverAt)}${info.serverReached && info.serverReached === info.serverAway ? ' (away address)' : ''}.`
                : "Connected. No other phone's file there yet: add each phone in the household on the server's Add a phone page.")}
          </span>
          <span className="small">
            At home: {addressText(info.serverHome) || 'not set'}
            {info.serverAway ? ` · Away: ${addressText(info.serverAway)}` : ''}
            {info.serverFiles ? ` · ${plural(info.serverFiles, 'file')} there` : ''}
          </span>
          <span className="small">
            {moved
              ? `${moved} moved there from this phone. `
              : ''}
            Prices and receipt photos older than your "Keep price history for" setting move to the server, and only come off this phone once
            the server has them. Receipts stay here.
          </span>
          {!!info.serverWaiting && !info.serverError && (
            <span className="small">{plural(info.serverWaiting, 'thing')} saved on the server, waiting for it to confirm before they come off this phone.</span>
          )}
          {!!info.serverUnread && !info.serverError && (
            <span className="small">
              {info.serverUnread === 1 ? "1 file on the server couldn't be opened" : `${info.serverUnread} files on the server couldn't be opened`}: from a phone
              that needs the household's new key (it gets it next time it syncs).
            </span>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn small primary" disabled={busy || !!working} onClick={() => void scanWeb()}>
              <Icon name="scan" size={16} /> Scan the web page's code
            </button>
            <button className="btn small" disabled={busy || !!working} onClick={() => void stop()}>
              Stop
            </button>
          </div>
          <span className="small">
            On a computer, open your server's page. To see your household there, link it once with this phone; any time after, you can sign in by
            scanning its code instead of typing your passphrase.
          </span>
        </>
      ) : (
        <>
          <span className="title" style={{ fontSize: 15 }}>
            Restock server
          </span>
          <span className="small">
            A small server you run yourself (in Docker on a NAS or home server, or as an app in Home Assistant). Phones sync through it at home and away,
            prices included, and you can use Restock in a browser too. It only ever keeps sealed files: still no account, and the makers of
            Restock never see any of it. It works alongside Wi-Fi sync and sync away from home.
          </span>
          {!info.paired && (
            <ol className="small" style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <li>
                <strong>Start your household.</strong> This phone isn't in one yet, so it becomes the owner of "{householdName}". The server uses the
                household's key to seal everything.
              </li>
              <li>
                <strong>Scan the server's code.</strong> On a computer, open your server's page, sign in and choose Add a phone.
              </li>
              <li>
                <strong>Link the web page</strong> (optional): scan its second code, so the browser can show your household.
              </li>
            </ol>
          )}
          <button className="btn primary" disabled={!syncAvailable() || busy || !!working} onClick={() => void join()}>
            <Icon name="scan" size={18} /> {info.paired ? "Scan the code from your server's Add a phone page" : 'Connect'}
          </button>
          <span className="small">
            {info.paired
              ? "On a computer, open your server's page, sign in and choose Add a phone. Each code works once, for 10 minutes."
              : 'Connect does steps 1 and 2, asking first. Each code works once, for 10 minutes.'}
          </span>
          {!info.paired && (
            <span className="small">
              Adding more phones later: each one joins the household from this phone first (Sync and backups → Add a phone), then scans its own code
              from the server's page.
            </span>
          )}
        </>
      )}
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
  );
}

/** "Syncing through Nextcloud", "… a WebDAV server", "… <folder>". */
function awayTitle(info: SyncInfo): string {
  if (info.folderKind === 'nextcloud') return 'Syncing through Nextcloud';
  if (info.folderKind === 'webdav') return 'Syncing through a WebDAV server';
  return `Syncing through ${info.folderName ?? 'a folder'}`;
}

/** 0.9.3: one line about the Restock server, for rows that lead to its screen. */
export function serverSummary(info: SyncInfo | undefined): string {
  if (!info?.server) return 'Sync at home and away through a small server you run yourself, and use Restock in a browser';
  if (info.serverError) return info.serverError;
  const where = addressText(info.serverReached ?? info.serverHome ?? info.serverAway);
  return [where, info.serverAt ? `synced ${agoText(info.serverAt)}` : 'connected', info.serverApi === 3 ? 'anywhere, around the clock' : ''].filter(Boolean).join(' · ');
}

// ---------- 0.9.4: adding a phone, and leaving the server (the "Restock sync redesign" canvas) ----------

/**
 * Add a phone: to the Restock server (on the server's page: the server decides who's in the house),
 * or, with no server, a code on this Wi-Fi only. Opens InviteSheet for the Wi-Fi way.
 */
export function AddPhoneSheet({ info, onClose, onWifi }: { info: SyncInfo; onClose: () => void; onWifi: () => void }) {
  const nav = useNav();
  const house = !!info.house || info.serverApi === 3;
  // Only the owner of a household without a server (or a phone not in one) shows a Wi-Fi code.
  const wifiOk = !house && (!info.paired || !!info.isOwner);
  const page = info.serverHome ?? info.serverRow?.home;
  return (
    <Sheet title="Add a phone" onClose={onClose}>
      {info.server || house ? (
        <div className="sync-choice recommended">
          <span className="eyebrow green" style={{ margin: 0 }}>
            To your Restock server
          </span>
          <strong style={{ fontSize: 17 }}>Add it on the server's page</strong>
          <span className="small">
            Your server decides who's in the house. On a computer, open the server's page, choose <strong>Add a phone</strong>, name it (like
            "Sister's phone"), and scan the code with the new phone. Works anywhere, around the clock.
          </span>
          {page && (
            <a href={page} target="_blank" rel="noreferrer" style={{ minHeight: 40, display: 'flex', alignItems: 'center' }}>
              Open the server's page
            </a>
          )}
        </div>
      ) : (
        <button className="sync-choice" onClick={() => nav.push({ name: 'restockServer' })}>
          <strong style={{ fontSize: 17 }}>Use your Restock server</strong>
          <span className="small">Have a server at home? Join it first; then phones are added on its page, and sync at home and away.</span>
        </button>
      )}
      {wifiOk ? (
        <button className="sync-choice" disabled={!syncAvailable()} onClick={onWifi}>
          <strong style={{ fontSize: 17 }}>On this Wi-Fi only</strong>
          <span className="small">
            No server. Phones swap changes straight to each other, only at home. Both phones need to be on this Wi-Fi now. This phone shows a code
            for the other to scan.
          </span>
        </button>
      ) : (
        !house &&
        info.paired && (
          <p className="small" style={{ margin: 0 }}>
            On this Wi-Fi only: the owner phone{info.members?.find((m) => m.owner) ? ` (${info.members.find((m) => m.owner)!.name})` : ''} shows the
            code for a new phone.
          </p>
        )
      )}
      {house && (
        <p className="small" style={{ margin: 0 }}>
          Once a phone has joined the server, phones on your Wi-Fi can also swap changes straight to each other at home (Phones on your Wi-Fi).
        </p>
      )}
      <button className="btn block" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}

/**
 * Leave the server's house: this phone stops syncing with it and keeps everything it has now.
 * Nothing is deleted on the server (it shows this phone as Left).
 */
// ---------- 0.9.4: what stays on the server when a phone stops sharing something, or leaves ----------

/** The personal things a phone can take back off a v3 server (never groceries). */
export const PERSONAL: { kind: TakeBack; title: string }[] = [
  { kind: 'keg', title: 'Keg' },
  { kind: 'pharmacy', title: 'Health' },
  { kind: 'receipts', title: 'Receipts' },
  { kind: 'cards', title: 'Loyalty cards' },
];

/** The personal things this phone shares with its server now. */
export function personalShared(info: SyncInfo | undefined): TakeBack[] {
  const tabs = info?.tabs ?? info?.myTabs ?? [];
  return PERSONAL.map((p) => p.kind).filter((k) => (k === 'receipts' ? !!info?.shareReceipts : k === 'cards' ? !!info?.shareCards : tabs.includes(k)));
}

/** "Coles, Woolworths and Aldi": a list in words. */
const andList = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The grocery shops this phone follows, by name ("Coles, Woolworths and Aldi"), or the general words. */
export function shopsText(s: Settings | undefined): string {
  const names = s ? [...new Set(enabledIn(s.enabledChains, 'pantry').map((c) => chainName(c)))] : [];
  if (!names.length || names.length > 6) return 'Coles, Woolworths, Aldi and the others';
  return andList(names);
}

/** Always said when a phone stops sharing something or leaves: shop data isn't personal, and it stays. */
export function ShopDataStays() {
  const settings = useLive(getSettings, []);
  return (
    <span className="small">
      <strong style={{ color: 'var(--ink)' }}>Prices and product details</strong> your phone found at your shops ({shopsText(settings)}) stay on the server
      for the household, with the shared shopping list and pantry. They're about the shops, not about you.
    </span>
  );
}

/** What a take-back tick removes, in words (TurnOffSheet and the Leave sheet). */
export const TAKE_BACK_NOTE =
  "Only what this phone added comes off the server and the house's other phones. Other people's things stay, and this phone keeps its own copy.";

/**
 * Leaves the server (0.9.4): the ticked personal kinds this phone shares come off the server first
 * (only what it added), as turning each off with its box ticked; groceries never. Rejects (and the
 * phone stays) if they can't be taken back or its photos can't come back.
 */
export function leaveServer(info: SyncInfo, ticked: TakeBack[], bringBack = true): Promise<SyncInfo> {
  const offered = info.house || info.serverApi === 3 ? [...personalShared(info), ...(info.takeBack ?? [])] : [];
  return RestockNative.syncStopServer({ bringBack, takeBack: ticked.filter((k) => offered.includes(k)) });
}

export function LeaveServerSheet({ info, onClose, onDone }: { info: SyncInfo; onClose: () => void; onDone: (i: SyncInfo) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const label = info.serverLabel?.trim() || 'the server';
  // 0.9.4: the receipt photos this phone moved to the server come back first; if they can't (out of
  // reach), it doesn't leave, and the person can try again or leave them there.
  const [photosStuck, setPhotosStuck] = useState(false);
  // 0.9.4: the personal things it shares, each with an unticked "take it back" box (as turning it off).
  // Review fix: a kind ticked here stays offered (and ticked) after a try that couldn't reach the
  // server, which already turned it off and is taking it back (info.takeBack), so trying again
  // still takes it back first.
  const [back, setBack] = useState<TakeBack[]>([]);
  const shared = info.house || info.serverApi === 3 ? personalShared(info) : [];
  const personal = [...shared, ...back.filter((k) => !shared.includes(k) && (info.takeBack ?? []).includes(k))];
  const allTicked = personal.length > 0 && personal.every((k) => back.includes(k));
  const flip = (k: TakeBack, on: boolean) => setBack((b) => (on ? [...new Set([...b, k])] : b.filter((x) => x !== k)));
  const leave = async (bringBack = true, takeBack: TakeBack[] = back) => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await leaveServer(info, takeBack, bringBack));
    } catch (e) {
      const m = errText(e);
      setError(m);
      setPhotosStuck(/receipt photos back/i.test(m));
      setBusy(false);
    }
  };
  return (
    <Sheet title={`Leave ${label}?`} onClose={busy ? () => undefined : onClose}>
      <p className="small" style={{ margin: 0, fontSize: 15 }}>
        This phone stops syncing with the server and keeps everything it has now.
      </p>
      <div className="card" style={{ gap: 8 }}>
        <ShopDataStays />
        <span className="small">
          {personal.length ? (
            <>
              <strong style={{ color: 'var(--ink)' }}>Your personal things stay too, unless you tick them below</strong>: what this phone shared of{' '}
              {andList(PERSONAL.filter((p) => personal.includes(p.kind)).map((p) => (p.kind === 'cards' ? 'loyalty cards' : p.kind === 'receipts' ? 'receipts' : p.title)))}.
            </>
          ) : info.house || info.serverApi === 3 ? (
            "This phone didn't share anything personal (Keg, Health, receipts or loyalty cards)."
          ) : (
            <>
              <strong style={{ color: 'var(--ink)' }}>On the server, nothing is deleted.</strong> What this phone shared stays there for the house: prices,
              history, receipts.
            </>
          )}
        </span>
        <span className="small">
          The server's page shows this phone as <strong style={{ color: 'var(--ink)' }}>Left</strong>. To come back, scan a new code from the server's
          page.
        </span>
        <span className="small">Ending the whole house, or removing someone else's phone, is done on the server's page.</span>
      </div>
      {personal.length > 0 && (
        <div className="card flush">
          <div className="section-head">
            <span className="title">Also take these off the server</span>
            <button className="linkish small" type="button" disabled={busy} onClick={() => setBack(allTicked ? [] : personal)}>
              {allTicked ? 'Select none' : 'Select all'}
            </button>
          </div>
          {PERSONAL.filter((p) => personal.includes(p.kind)).map((p) => (
            <label key={p.kind} className="check">
              <input type="checkbox" checked={back.includes(p.kind)} disabled={busy} onChange={(e) => flip(p.kind, e.target.checked)} />
              <span className="title" style={{ fontSize: 15, flex: 1 }}>
                {p.title}
              </span>
            </label>
          ))}
          <p className="small" style={{ margin: 0, padding: '0 16px 12px' }}>
            {TAKE_BACK_NOTE}
          </p>
        </div>
      )}
      {error && (
        <div className="banner amber" role="alert">
          {error}
        </div>
      )}
      <button className="btn block danger" disabled={busy} onClick={() => void leave()}>
        {busy ? 'Leaving…' : back.some((k) => personal.includes(k)) ? `Take those back and leave ${label}` : `Leave ${label}`}
      </button>
      {photosStuck && !busy && (
        <button className="btn block" onClick={() => void leave(false)}>
          Leave without the photos (they stay on the server)
        </button>
      )}
      {/Couldn't take those things off the server/i.test(error ?? '') && !busy && (
        <button className="btn block" onClick={() => void leave(true, [])}>
          Leave without taking them back (they stay on the server)
        </button>
      )}
      {busy && <LoadingBar seconds={6} />}
      <button className="btn block" disabled={busy} onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}

export function SyncScreen({ invite }: { invite?: boolean } = {}) {
  useSettingsDraft(); // 0.9.5 (save)
  const nav = useNav();
  const [info, setInfo] = useState<SyncInfo>();
  // 0.9.5 (save): changes waiting for Save, shown in place of what's set now (sh).
  const draft = useDraftState();
  const [pending, setPending] = useState<SyncPatch>({});
  const [wifiPending, setWifiPending] = useState<boolean>();
  useEffect(() => {
    setPending({});
    setWifiPending(undefined);
  }, [draft.epoch]);
  const sh = (i: SyncInfo): SyncInfo => ({
    ...i,
    ...(pending.name !== undefined ? { name: pending.name } : {}),
    ...(pending.shareCards !== undefined ? { shareCards: pending.shareCards } : {}),
    ...(pending.keepReady !== undefined ? { keepReady: pending.keepReady } : {}),
    ...(pending.tabs !== undefined ? { myTabs: pending.tabs, tabs: pending.tabs } : {}),
    ...(pending.householdTabs !== undefined ? { householdTabs: pending.householdTabs } : {}),
    ...(pending.householdReceipts !== undefined ? { shareReceipts: pending.householdReceipts } : {}),
    ...(wifiPending !== undefined ? { wifiSync: wifiPending } : {}),
  });
  // 0.9.3: Settings' Start a household and Add a phone open the code straight away.
  const [inviting, setInviting] = useState(!!invite);
  const [joining, setJoining] = useState<string>();
  const [member, setMember] = useState<{ device: string; name: string }>();
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [takeOver, setTakeOver] = useState(false);
  // 0.9.1: sync away from home: the choice being set up, the chooser (Change), and a problem setting it up.
  const [away, setAway] = useState<'nextcloud' | 'webdav'>();
  const [choosing, setChoosing] = useState(false);
  const [awayError, setAwayError] = useState<string>();
  const [, tick] = useState(0);
  // 0.9.4: Add a phone (server or Wi-Fi), and leaving the server's house.
  const [adding, setAdding] = useState(false);
  const [leavingServer, setLeavingServer] = useState(false);

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
      // 0.9.4: what it did, and never about the Wi-Fi's phones unless Wi-Fi sync is on.
      nav.toast(syncNowMessage(r));
    } finally {
      setBusy(false);
    }
  };

  /** 0.9.5 (save): held until Save settings; then sent in one go. */
  const set = async (patch: SyncPatch, addTab?: Section) => {
    if (!info) return;
    const next = { ...pending, ...patch };
    const tabsAdded = addTab ? [...new Set([...(pending.addTabs ?? []), addTab])] : pending.addTabs;
    const all: SyncPatch = { ...next, ...(tabsAdded?.length ? { addTabs: tabsAdded } : {}) };
    setPending(all);
    const was = info;
    const now: SyncPatch = {
      name: was.name,
      shareCards: !!was.shareCards,
      keepReady: was.keepReady !== false,
      tabs: was.tabs ?? was.myTabs,
      householdTabs: was.householdTabs,
      householdReceipts: !!was.shareReceipts,
    };
    const { addTabs, ...plain } = all;
    const current = Object.fromEntries(Object.keys(all).map((k) => [k, (now as Record<string, unknown>)[k]]));
    await stage(
      'sync-set',
      all,
      async () => {
        let i = was;
        // A tab turned on brings its shops and settings across (shareTab), as it did straight away before.
        for (const t of addTabs ?? []) i = (await shareTab(i, t)) ?? i;
        if (Object.keys(plain).length) i = await RestockNative.syncSet(plain);
        setInfo(i);
        setPending({});
      },
      current as SyncPatch,
    );
  };
  const setWifi = async (on: boolean) => {
    setWifiPending(on);
    await stage(
      'sync-wifi',
      on,
      async () => {
        setInfo(await RestockNative.syncSetWifi({ on }));
        setWifiPending(undefined);
      },
      info?.wifiSync !== false,
    );
  };

  const leave = async () => {
    // 0.9.4: in a server's house, leaving is leaving the server (nothing is deleted there).
    if (info?.house || info?.serverApi === 3) return setLeavingServer(true);
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
    // 0.9.2: receipt photos this phone moved to the Restock server come back first (it can't reach them after).
    const photos = info?.server ? (info.serverPhotos ?? 0) : 0;
    const ok = await confirmAction('Stop syncing this phone?', {
      detail:
        "This phone keeps everything it has now, and nothing is deleted on the household's other phones. Changes just stop going between them. To join again, you'll need a new code from the owner phone." +
        (info?.server ? ` It stops using your Restock server too${photos ? `: the ${plural(photos, 'receipt photo')} kept there come back onto this phone first` : ''}.` : ''),
      action: 'Stop syncing',
    });
    if (!ok) return;
    if (photos) {
      try {
        setInfo(await RestockNative.syncStopServer({ bringBack: true }));
      } catch (e) {
        const anyway = await confirmAction("Couldn't bring the photos back", {
          detail: `${errText(e)} If you stop anyway, those photos stay on the server and this phone can't show them.`,
          action: 'Stop anyway',
          danger: true,
        });
        if (!anyway) return;
      }
    }
    const r = await RestockNative.syncLeave();
    setInfo(r);
    if (r.left) nav.toast('This phone has stopped syncing');
  };

  const pickFolder = async () => {
    setAwayError(undefined);
    try {
      const f = await RestockNative.pickFolder();
      setBusy(true);
      // 0.9.1: the folder is tried out first; one an app can't really hold is turned down.
      const i = await RestockNative.syncSetFolder({ uri: f.uri });
      setInfo(i);
      setChoosing(false);
      nav.toast(i.folderError ?? `Syncing through ${f.name}`);
    } catch (e) {
      if (errText(e) !== 'No folder picked') setAwayError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const pickAway = (kind: 'nextcloud' | 'webdav' | 'folder') => {
    setAwayError(undefined);
    if (kind === 'folder') void pickFolder();
    else setAway(kind);
  };
  const awayDone = (i: SyncInfo) => {
    setAway(undefined);
    setChoosing(false);
    setInfo(i);
    nav.toast(i.folderError ?? (i.folderKind === 'nextcloud' ? 'Signed in. Syncing through Nextcloud' : `Syncing through ${i.folderName ?? 'the server'}`));
  };
  const stopFolder = async () => {
    const server = info?.folderKind === 'nextcloud' || info?.folderKind === 'webdav';
    const ok = await confirmAction(server ? 'Stop syncing through the server?' : 'Stop syncing through the folder?', {
      detail: server
        ? "This phone stops using the server and forgets its sign-in. Its file stays there; delete it yourself if you like. Wi-Fi sync carries on."
        : "This phone stops reading and writing the folder. Its file stays there; delete it yourself if you like. Wi-Fi sync carries on.",
      action: 'Stop',
    });
    if (ok) {
      setInfo(await RestockNative.syncSetFolder({}));
      setChoosing(false);
    }
  };

  const synced = (device: string) => info?.peers?.find((p) => p.device === device)?.syncedAt;
  const owner = info?.members?.find((m) => m.owner);

  return (
    <div className="screen">
      <TopBar title="Phones and sharing" />

      {!syncAvailable() && (
        <div className="banner grey">
          <strong>Sync works in the Android app</strong>
          <span style={{ fontSize: 13 }}>In this preview everything stays in this browser.</span>
        </div>
      )}

      {info?.notice && !info.paired && (
        <div className="banner amber" role="status">
          <strong>
            {info.notice === 'removed'
              ? 'This phone was removed from the household'
              : info.notice === 'keys'
                ? 'Join your household again'
                : 'Pair your phones again'}
          </strong>
          <span style={{ fontSize: 13 }}>
            {info.notice === 'removed'
              ? 'The owner phone took it out. It kept everything it had. To join again, ask the owner for a new code.'
              : info.notice === 'keys'
                ? 'This phone couldn\'t open its sync keys. That happens when Restock\'s data is moved to another phone. Everything else is still here. Ask the owner phone for a new code and join again, and choose "Combine" so nothing is lost.'
                : 'Restock 0.8.2 adds an owner phone and one-time codes. Everything is still on this phone. On the phone that will be the owner, tap Start a household; on the other, tap Join a household and scan the code. Choose "Combine" so nothing is lost.'}
          </span>
          <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => void RestockNative.syncDismissNotice().then(refresh)}>
            OK
          </button>
        </div>
      )}

      <div className="card" style={{ gap: 8 }}>
        <strong>Phones on your Wi-Fi: one pantry and list for the whole house</strong>
        <span className="small">
          Phones in your household swap changes <strong>straight from one phone to another</strong> on your own Wi-Fi: pantry, shopping list (ticks
          too), prices, categories and alerts. With your own Restock server they also sync anywhere, around the clock; without one, a cloud drive
          folder works away from home.
        </span>
        <ul className="ticks">
          <li>
            <Icon name="check" size={16} />
            <span>No account and no sign-up. No server, unless you run your own.</span>
          </li>
          <li>
            <Icon name="check" size={16} />
            <span>
              On your Wi-Fi it never goes over the internet. Away from home, it's sealed on the way, wherever it's kept. The makers of Restock never
              see it.
            </span>
          </li>
          <li>
            <Icon name="check" size={16} />
            <span>
              Up to {MAX_SYNC_PHONES} phones on the Wi-Fi. Each keeps its own look, backups and shop sign-ins, and its receipts unless it shares them.
            </span>
          </li>
        </ul>
      </div>

      {info && !info.paired && (
        <div className="card flush">
          <button className="row" disabled={!syncAvailable()} onClick={() => nav.push({ name: 'restockServer' })}>
            <Icon name="server" size={18} />
            <span className="grow">
              <span className="title" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                Join your Restock server <span className="tag great">Recommended</span>
              </span>
              <span className="small">Your server is the house: phones join it, at home and away.</span>
            </span>
            <Icon name="chevron" size={18} />
          </button>
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
      {info && !info.paired && (
        <p className="small group-note">A cloud drive folder (for phones away from home without a server) is set up here once this phone is in a household.</p>
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
                <span className="title" style={{ fontSize: 15 }}>
                  Stop syncing this phone
                </span>
                <span className="small">This phone keeps everything. Nothing is deleted on the other phones.</span>
              </span>
            </button>
          </div>

          {/* 0.9.4: Wi-Fi sync can be off (a phone in a server's house starts with it off). */}
          <div className="card flush">
            <label className="check">
              <input type="checkbox" className="switch" checked={sh(info).wifiSync !== false} onChange={(e) => void setWifi(e.target.checked)} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span className="title" style={{ fontSize: 15 }}>
                  Phones on your Wi-Fi
                </span>
                <span className="small">
                  {sh(info).wifiSync !== false
                    ? 'On: swaps changes straight with the household\'s phones on this Wi-Fi, even when the internet is down.'
                    : 'Off · turn on to also swap changes at home when the internet is down.'}
                </span>
              </span>
            </label>
          </div>

          {info.clockWarning && (
            <div className="banner amber" role="status" style={{ gap: 8 }}>
              <strong>{info.clockWarning}'s date looks wrong</strong>
              <span style={{ fontSize: 13 }}>
                Its changes are stamped more than a day ahead, so they'd beat everyone else's. On that phone, open Android's Settings → System → Date and
                time and turn on the automatic date and time.
              </span>
              <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => void RestockNative.syncDismissNotice().then(refresh)}>
                OK
              </button>
            </div>
          )}

          {info.isOwner && info.hasRecovery && !info.recoverySaved && (
            <div className="banner amber" role="status" style={{ gap: 8 }}>
              <strong>Save your household's recovery key</strong>
              <span style={{ fontSize: 13 }}>
                If this phone is lost, another phone can take over as the owner with it. Without it, nobody can add or remove phones again.
              </span>
              <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setRecovery(true)}>
                Show the recovery key
              </button>
            </div>
          )}

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
            {(info.members ?? []).filter((m) => !m.device.startsWith('srv-')).map((m) => {
              const canManage = info.isOwner && !m.me;
              const body = (
                <>
                  <Icon name="phone" size={18} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
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
            {info.house ? (
              <button className="row" onClick={() => setAdding(true)}>
                <Icon name="plus" size={18} />
                <span className="grow">
                  <span className="title" style={{ fontSize: 15, color: 'var(--green)' }}>
                    Add a phone
                  </span>
                  <span className="small">In a server's house, phones are added and removed on the server's page.</span>
                </span>
              </button>
            ) : info.isOwner && (info.members?.length ?? 1) >= MAX_SYNC_PHONES ? (
              <p className="small" style={{ padding: '4px 14px 12px', margin: 0 }}>
                That's the most local sync allows ({MAX_SYNC_PHONES} phones). To add another, remove one first.
              </p>
            ) : info.isOwner ? (
              <button className="row" onClick={() => (info.server ? setAdding(true) : setInviting(true))}>
                <Icon name="plus" size={18} />
                <span className="grow">
                  <span className="title" style={{ fontSize: 15, color: 'var(--green)' }}>
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

          <div className="card flush">
            {info.isOwner ? (
              <button className="row" onClick={() => setRecovery(true)}>
                <Icon name="lock" size={18} />
                <span className="grow">
                  <span className="title" style={{ fontSize: 15 }}>
                    Recovery key
                  </span>
                  <span className="small">
                    {info.recoverySaved ? 'Saved. If this phone is lost, another phone takes over with it.' : 'Not saved yet. Tap to see it and save it.'}
                  </span>
                </span>
                <Icon name="chevron" size={18} />
              </button>
            ) : (
              <button className="row" disabled={!info.canRecover} onClick={() => setTakeOver(true)}>
                <Icon name="lock" size={18} />
                <span className="grow">
                  <span className="title" style={{ fontSize: 15 }}>
                    Owner phone lost?
                  </span>
                  <span className="small">
                    {info.canRecover
                      ? "Take over as the owner with the household's recovery key."
                      : "Once the owner phone has Restock 0.9.0 and syncs, this phone can take over with the recovery key if it's ever lost."}
                  </span>
                </span>
                <Icon name="chevron" size={18} />
              </button>
            )}
          </div>

          <div className="eyebrow">Cloud drive folder</div>
          <div className="card" style={{ gap: 8 }}>
            {info.house || info.serverApi === 3 ? (
              <span className="small">Not used with your Restock server: the server already syncs away from home, and hands out new keys itself.</span>
            ) : info.folder ? (
              <>
                <span className="title" style={{ fontSize: 15 }}>
                  {awayTitle(info)}
                </span>
                {info.folderKind !== 'folder' && info.folderName && <span className="small">{info.folderName}</span>}
                <span className="small">
                  {info.folderError ??
                    (info.folderAt
                      ? `Last synced away from home ${agoText(info.folderAt)}.`
                      : info.folderKind === 'folder'
                        ? "No other phone's file here yet. Pick the same folder on each phone in the household."
                        : "No other phone's file here yet. Set up the same folder on each phone in the household.")}
                </span>
                {!!info.folderUnread && !info.folderError && (
                  <span className="small">
                    {info.folderUnread === 1 ? "1 file in the folder couldn't be opened" : `${info.folderUnread} files in the folder couldn't be opened`}: from
                    another household, or a phone that needs the household's new key (it gets it next time it syncs with the owner).
                  </span>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn small" disabled={busy} onClick={() => setChoosing((c) => !c)}>
                    Change
                  </button>
                  <button className="btn small" onClick={() => void stopFolder()}>
                    Stop
                  </button>
                </div>
              </>
            ) : (
              <span className="small">
                For phones away from home, without a server: a folder your drive app keeps in step, like Google Drive, Dropbox, OneDrive, Syncthing or
                Nextcloud, or a WebDAV server. Each phone leaves its changes there, sealed with the household's key, and picks up the others'. Your list,
                pantry and ticks go this way; prices and photos stay on the Wi-Fi to keep it small. Slower, and depends on the drive app.
              </span>
            )}
            {awayError && (
              <div className="banner amber" role="alert">
                {awayError}
              </div>
            )}
          </div>
          {(!info.folder || choosing) && !info.house && info.serverApi !== 3 && <AwayChoices disabled={!syncAvailable() || busy} onPick={pickAway} />}

          <div className="eyebrow">Restock server</div>
          <div className="card flush">
            <button className="row" onClick={() => nav.push({ name: 'restockServer' })}>
              <Icon name="refresh" size={18} />
              <span className="grow">
                <span className="title">{info.server ? 'Syncing through your Restock server' : 'Restock server'}</span>
                <span className="small">{serverSummary(info)}</span>
              </span>
              <Icon name="chevron" size={18} />
            </button>
          </div>

          <div className="eyebrow">What's shared</div>
          {info.house || info.serverApi === 3 ? (
            <div className="card flush">
              <button className="row" onClick={() => nav.push({ name: 'restockServer' })}>
                <Icon name="server" size={18} />
                <span className="grow">
                  <span className="title" style={{ fontSize: 15 }}>
                    What this phone shares with {serverName(info)}
                  </span>
                  <span className="small">Groceries, Keg, Health, receipts and loyalty cards: each on or off for this phone.</span>
                </span>
                <Icon name="chevron" size={18} />
              </button>
            </div>
          ) : (
            <>
          {info.isOwner && (
            <>
              <span className="small">The household shares:</span>
              <TabsPicker
                offered={SECTIONS}
                value={sh(info).householdTabs ?? SECTIONS}
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
            offered={sh(info).householdTabs ?? SECTIONS}
            value={(sh(info).myTabs ?? SECTIONS).filter((t) => (sh(info).householdTabs ?? SECTIONS).includes(t))}
            onChange={(v) => {
              if (!v.length) return nav.toast('Pick at least one, or stop syncing this phone.');
              // 0.9.5 (save): a tab turned on still asks 18 or over (Keg) now; it comes across on Save.
              const added = v.find((t) => !(sh(info).tabs ?? []).includes(t));
              if (added === 'keg')
                void askAdult().then((ok) => {
                  if (ok) void set({ tabs: v }, added);
                });
              else void set({ tabs: v }, added && !(info.tabs ?? []).includes(added) ? added : undefined);
            }}
          />
          <p className="small" style={{ marginTop: -4 }}>
            What isn't shared stays on this phone only. Turning one on brings the household's things for it across at the next sync.
          </p>
          <div className="card flush">
            <label className="check">
              <input
                type="checkbox"
                className="switch"
                checked={!!sh(info).shareReceipts}
                disabled={!info.isOwner}
                onChange={(e) => void set({ householdReceipts: e.target.checked })}
              />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span className="title" style={{ fontSize: 15 }}>
                  Share receipts with the household
                </span>
                <span className="small">
                  {info.isOwner
                    ? 'Kept receipts go to every phone, for the tabs each one shares. Photos only go over the Wi-Fi; until one arrives, the receipt shows without it.'
                    : `Only the owner phone${owner ? ` (${owner.name})` : ''} can change this.${info.shareReceipts ? ' Photos only go over the Wi-Fi.' : ''}`}
                </span>
              </span>
            </label>
          </div>

          <label className="field">
            <span>This phone's name</span>
            <input
              className="input"
              key={`name-${draft.epoch}`}
              defaultValue={sh(info).name}
              onChange={(e) => e.target.value.trim() && void set({ name: e.target.value.trim() })}
            />
          </label>
          <p className="small" style={{ marginTop: -6 }}>
            What the other phones call this one, like "Declan's phone".
          </p>

            </>
          )}

          <div className="card flush">
            {!(info.house || info.serverApi === 3) && <label className="check">
              <input type="checkbox" className="switch" checked={!!sh(info).shareCards} onChange={(e) => void set({ shareCards: e.target.checked })} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span className="title" style={{ fontSize: 15 }}>
                  Share my loyalty cards
                </span>
                <span className="small">Copies this phone's Flybuys and Everyday Rewards numbers to the household's other phones.</span>
              </span>
            </label>}
            <label className="check">
              <input type="checkbox" className="switch" checked={sh(info).keepReady !== false} onChange={(e) => void set({ keepReady: e.target.checked })} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span className="title" style={{ fontSize: 15 }}>
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
          On the Wi-Fi, both phones need to be there at the same time; whatever changed while apart catches up then (or away from home, if you've
          set that up). Phones only look for each other on Wi-Fi (or a network cable), never over mobile data. Some routers and guest networks
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

      {adding && info && (
        <AddPhoneSheet
          info={info}
          onClose={() => setAdding(false)}
          onWifi={() => {
            setAdding(false);
            setInviting(true);
          }}
        />
      )}
      {leavingServer && info && (
        <LeaveServerSheet
          info={info}
          onClose={() => setLeavingServer(false)}
          onDone={(i) => {
            setLeavingServer(false);
            setInfo(i);
            nav.toast('This phone has left the server');
          }}
        />
      )}
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
      {recovery && (
        <RecoverySheet
          saved={!!info?.recoverySaved}
          onClose={() => setRecovery(false)}
          onDone={(i, msg) => {
            setInfo(i);
            if (msg) {
              setRecovery(false);
              nav.toast(msg);
            }
          }}
        />
      )}
      {takeOver && (
        <TakeOverSheet
          ownerName={owner?.name}
          onClose={() => setTakeOver(false)}
          onDone={(i) => {
            setTakeOver(false);
            setInfo(i);
            nav.toast('This phone is the owner now');
            void (async () => {
              // The lost phone still has the household's key: offer to remove it straight away.
              const lost = owner && (i.members ?? []).find((m) => m.device === owner.device && !m.me);
              if (
                lost &&
                (await confirmAction(`Remove ${lost.name} from the household?`, {
                  detail: "Recommended if it's lost or stolen: the household's key changes, so it can't sync again. It keeps what it has now.",
                  action: 'Remove it',
                }))
              ) {
                try {
                  setInfo(await RestockNative.syncRemove({ device: lost.device }));
                  nav.toast(`${lost.name} removed`);
                } catch (e) {
                  nav.toast(errText(e));
                }
              }
              // Then the new recovery key, to save.
              setRecovery(true);
            })();
          }}
        />
      )}
      <SaveBar onlyWhenChanged />
      {away === 'nextcloud' && <NextcloudSheet onClose={() => setAway(undefined)} onDone={awayDone} />}
      {away === 'webdav' && <WebDavSheet onClose={() => setAway(undefined)} onDone={awayDone} />}
      {member && (
        <MemberSheet
          member={member}
          server={!!info?.server}
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
  if (!info.paired) return info.notice === 'repair' ? 'Pair your phones again (0.8.2)' : 'Your server, phones on your Wi-Fi, or a drive folder';
  if (info.house || info.serverApi === 3) return `${serverName(info)} · ${info.serverError ?? (info.serverAt ? `synced ${agoText(info.serverAt)}` : 'connected')}`;
  const n = info.members?.length ?? 1;
  return n > 1
    ? `${info.household ?? 'Household'} · ${n} phones · synced ${agoText(info.lastSyncAt)}`
    : `${info.household ?? 'Household'} · waiting for another phone`;
}
