import { NotHereBanner } from '../IosWhy';
import { useEffect, useState } from 'react';
import { scanBarcode } from '../../lib/barcode';
import { saveCopyInApp } from '../../lib/backup';
import { confirmAction } from '../../lib/confirm';
import { wifiSyncOn } from '../../lib/protection';
import { allGroups, allProducts, getSettings, reapplyHouseholdSettings, updateSettings } from '../../lib/db';
import { CARRIED_TILES, householdSettingsFor } from '../../lib/household';
import { SECTION_NAMES, SECTIONS, shopDef, type Section } from '../../shops';
import type { Settings } from '../../types';
import { RestockNative } from '../../lib/sql/native';
import {
  agoText,
  MAX_SYNC_PHONES,
  pairingCode,
  serverCode,
  serverName,
  strictBatteryMaker,
  syncAvailable,
  syncInfo,
  syncNowMessage,
  type SyncInfo,
} from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { syncBackgroundSchedule } from '../../lib/check';
import { scheduleReminders } from '../../lib/notify';
import { Icon, LoadingBar, Sheet, TopBar, More } from '../components';
import { useNav } from '../nav';
// 0.9.5 (save): the sharing switches and this phone's name wait for Save settings.
import { stage } from '../../lib/settingsDraft';
import { SaveBar, useDraftState, useSettingsDraft } from '../SaveBar';
import { CardsQuestion, InviteSheet } from './SyncCodes';
import { AddPhoneSheet } from './SyncServer';
import { RecoverySheet, TakeOverSheet, MemberSheet, AwayChoices, NextcloudSheet, WebDavSheet } from './SyncSheets';

// Settings → Sync (0.8.0): phones in the same household sync with each other on the same Wi-Fi.
// No server, no account: one phone shows a QR code, the other scans it.

/** The tabs a household can share, in plain words. */
export const SHARE_TABS: { tab: Section; title: string; sub: string }[] = [
  { tab: 'pantry', title: 'Groceries', sub: 'Pantry, its shopping list (and General, Baby and Pets) and prices' },
  { tab: 'keg', get title() { return SECTION_NAMES.keg; }, sub: '18+' },
  { tab: 'pharmacy', get title() { return SECTION_NAMES.pharmacy; }, sub: 'Its own tab' },
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
    detail: 'The Bottle shop tab tracks alcohol prices, so it is only for adults.',
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
async function applyHouseholdSettings(json: string | undefined, opts: { tabs: Section[]; replace: boolean }): Promise<void> {
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
            {peek?.ownerName ?? 'The owner phone'} shares the Bottle shop tab, which is only for adults. If not, this phone joins without it.
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
                <span className="small">No doubles: this phone's items in what it shares are swapped for the household's. A backup is saved first.</span>
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
async function scanPairingCode(): Promise<string | undefined> {
  const out = await scanBarcode('Scan the code on the owner phone', {
    accept: pairingCode,
    qr: true,
    wrong: "That isn't a Restock sync code. On the owner phone, open Settings → Sync and backups → Add a phone.",
    typeHint: 'Or paste the code',
  });
  return out.ok ? out.code : undefined;
}

/**
 * 0.15.0: the first screen's Join your household: either a phone's code (Phone sharing, Add a phone)
 * or a Restock server's Add a phone code. `kind` says which, so the right join follows.
 */
export async function scanJoinCode(): Promise<{ kind: 'phone' | 'server'; code: string } | undefined> {
  const out = await scanBarcode('Scan the code from your household', {
    accept: (t: string) => serverCode(t) ?? pairingCode(t),
    qr: true,
    wrong: "That isn't a Restock code. Scan the code on another phone's Add a phone, or on your server's Add a phone page.",
    typeHint: 'Or paste the code',
  });
  if (!out.ok) return undefined;
  return serverCode(out.code) ? { kind: 'server', code: out.code } : { kind: 'phone', code: out.code };
}

// ---------- 0.9.0: the recovery key ----------

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- 0.9.1: sync away from home ----------

// ---------- 0.9.2: the Restock server ----------

export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const addressText = (a?: string | null) => (a ?? '').replace(/^https?:\/\//i, '');

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
 * Leave the server's house: this phone stops syncing with it and keeps everything it has now.
 * Nothing is deleted on the server (it shows this phone as Left).
 */
// ---------- 0.9.4: what stays on the server when a phone stops sharing something, or leaves ----------

/** "Coles, Woolworths and Aldi": a list in words. */

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
      // 0.9.4: what it did, and never about the Wi-Fi's phones unless Phone sharing is on.
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
      wifiSyncOn(info),
    );
  };

  const leave = async () => {
    // 0.9.6: this is only for a household of phones. Leaving a server is on the server's screen (Leave this server).
    if (info?.house || info?.serverApi === 3) return;
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
        ? "This phone stops using the server and forgets its sign-in. Its file stays there; delete it yourself if you like. Phone sharing carries on."
        : "This phone stops reading and writing the folder. Its file stays there; delete it yourself if you like. Phone sharing carries on.",
      action: 'Stop',
    });
    if (ok) {
      setInfo(await RestockNative.syncSetFolder({}));
      setChoosing(false);
    }
  };

  const synced = (device: string) => info?.peers?.find((p) => p.device === device)?.syncedAt;
  const owner = info?.members?.find((m) => m.owner);
  // 0.9.6: in a server's house, Wi-Fi sync (phone to phone) is its own optional feature, off until set up.
  const isHouse = !!(info?.house || info?.serverApi === 3);
  const wifiOn = info ? wifiSyncOn(sh(info)) : true;
  const batteryBlock = info ? (
    <>
  {!info.batteryExempt && (
    <div className="banner amber" style={{ gap: 8 }}>
      <strong>Let Restock sync in the background</strong>
      <span style={{ fontSize: 13 }}>Android stops apps in the background, which stops sync. Tap Allow.{' '}<More title="Background sync"><p>Android saves battery by stopping apps in the background, which stops sync while Restock is closed. Tap Allow and choose "Allow" (or
        "Don't optimise"). It hardly uses any battery: Restock just waits quietly for the other phones.</p></More></span>
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
  ) : null;
  /** Sets Wi-Fi sync up, or stops it. Only ever Wi-Fi sync: the server is never touched. */
  const wifiNow = async (on: boolean) => {
    const ok = await confirmAction(on ? 'Set up Phone sharing?' : 'Stop Phone sharing?', {
      detail: on
        ? "This phone will announce itself on your Wi-Fi and swap changes straight with the house's other phones that have Phone sharing on, even when the internet is down. Your server carries on as it is. Turn it on in each phone that should do it."
        : `This phone stops looking for other phones on your Wi-Fi and stops announcing itself. It stays on ${serverName(info)}: nothing changes there, and this phone keeps everything.`,
      action: on ? 'Set up Phone sharing' : 'Stop Phone sharing',
      danger: false,
    });
    if (!ok) return;
    setBusy(true);
    try {
      setInfo(await RestockNative.syncSetWifi({ on }));
      nav.toast(on ? 'Phone sharing is on' : 'Phone sharing is off');
    } catch (e) {
      nav.toast(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <TopBar title={isHouse ? 'Phone sharing' : 'Phones and sharing'} />

      {!syncAvailable() && <NotHereBanner title="Sync works in the Android app" />}

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

      {!isHouse && (
      <div className="card" style={{ gap: 8 }}>
        <strong>Phone sharing (no server, local Wi-Fi): one pantry and list for the whole house</strong>
        <span className="small">Phones in your household swap changes straight to each other on your Wi-Fi.{' '}<More title="Phone sharing"><p>Phones in your household swap changes <strong>straight from one phone to another</strong> on your own Wi-Fi: pantry, shopping list (ticks
          too), prices, categories and alerts. With your own Restock server they also sync anywhere, around the clock; without one, a cloud drive
          folder works away from home.</p></More></span>
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
      )}

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

      {info?.paired && isHouse && (
        <>
          <div className="card flush">
            <button className="row" onClick={() => nav.push({ name: 'restockServer' })}>
              <Icon name="server" size={18} />
              <span className="grow">
                <span className="title">{serverName(info)}</span>
                <span className="small">{serverSummary(info)}. Its status, its phones and leaving it are on the server's screen.</span>
              </span>
              <Icon name="chevron" size={18} />
            </button>
          </div>

          <div className="eyebrow">Phone sharing (optional)</div>
          {!wifiOn ? (
            <div className="card" style={{ gap: 8 }}>
              <strong>Phone to phone on your Wi-Fi</strong>
              <span className="small">Your server already syncs this phone. Phone sharing is an extra for when the internet or the server is down.{' '}<More title="Phone sharing with a server"><p>Your server already syncs this phone at home and away. Phone sharing is a separate extra: phones swap changes straight to each other on the
                same Wi-Fi, even when the internet or the server is down.</p></More></span>
              <span className="small">It's off: this phone isn't announcing itself or looking for other phones.</span>
              <button className="btn primary block" disabled={!syncAvailable() || busy} onClick={() => void wifiNow(true)}>
                Set up Phone sharing
              </button>
            </div>
          ) : (
            <>
              <div className="card flush">
                <div className="row">
                  <span className="grow">
                    <span className="title">{!info.onWifi ? "This phone isn't on Wi-Fi" : info.lastSyncAt ? `Phone sharing is on · synced ${agoText(info.lastSyncAt)}` : 'Phone sharing is on · not synced yet'}</span>
                    <span className="small">
                      {info.lastError ??
                        (info.onWifi ? "Swaps changes with the house's other phones that have Phone sharing on, on this Wi-Fi." : 'It waits until this phone is on Wi-Fi.')}
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
                <button className="row" disabled={busy} onClick={() => void wifiNow(false)}>
                  <Icon name="close" size={18} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>
                      Stop Phone sharing
                    </span>
                    <span className="small">Only stops phone to phone sync on the Wi-Fi. This phone stays on {serverName(info)}.</span>
                  </span>
                </button>
              </div>

              <div className="eyebrow">Phones found on this Wi-Fi</div>
              <div className="card flush">
                {(info.members ?? []).filter((m) => !m.me && !m.device.startsWith('srv-') && synced(m.device)).map((m) => (
                  <div key={m.device} className="row">
                    <Icon name="phone" size={18} />
                    <span className="grow">
                      <span className="title" style={{ fontSize: 15 }}>
                        {m.name}
                      </span>
                      <span className="small">Last synced on the Wi-Fi {agoText(synced(m.device))}</span>
                    </span>
                  </div>
                ))}
                {!(info.members ?? []).some((m) => !m.me && !m.device.startsWith('srv-') && synced(m.device)) && (
                  <p className="small" style={{ padding: '4px 14px 12px', margin: 0 }}>
                    None yet. Set up Phone sharing on the house's other phones too, and keep them on the same Wi-Fi.
                  </p>
                )}
              </div>

              <div className="card flush">
                <label className="check">
                  <input type="checkbox" className="switch" checked={sh(info).keepReady !== false} onChange={(e) => void set({ keepReady: e.target.checked })} />
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <span className="title" style={{ fontSize: 15 }}>
                      Stay ready to sync
                    </span>
                    <span className="small">Lets other phones sync with this one while Restock is closed.{' '}<More title="Sync while closed"><p>Lets the other phones sync with this one while Restock is closed. Android shows a quiet "Ready to sync" notification for it. Off:
                      syncs only while Restock is open.</p></More></span>
                  </span>
                </label>
              </div>
              {batteryBlock}
              <p className="small">If the phones never find each other, your router may be keeping devices apart.{' '}<More title="Phones can't find each other"><p>Some routers and guest networks keep devices from seeing each other ("client isolation" or "AP isolation"). If the phones never find
                each other, that's the usual reason. Phones only look for each other on Wi-Fi, never over mobile data.</p></More></p>
            </>
          )}
        </>
      )}

      {info?.paired && !isHouse && (
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
              <input type="checkbox" className="switch" checked={wifiSyncOn(sh(info))} onChange={(e) => void setWifi(e.target.checked)} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span className="title" style={{ fontSize: 15 }}>
                  Phone sharing (no server, local Wi-Fi)
                </span>
                <span className="small">
                  {wifiSyncOn(sh(info))
                    ? 'On: swaps changes straight with the household\'s phones on this Wi-Fi, even when the internet is down.'
                    : 'Off · turn on to also swap changes at home when the internet is down.'}
                </span>
              </span>
            </label>
          </div>

          {info.clockWarning && (
            <div className="banner amber" role="status" style={{ gap: 8 }}>
              <strong>{info.clockWarning}'s date looks wrong</strong>
              <span style={{ fontSize: 13 }}>Its clock is more than a day ahead. Turn on automatic date and time on that phone.{' '}<More title="A phone's clock is wrong"><p>Its changes are stamped more than a day ahead, so they'd beat everyone else's. On that phone, open Android's Settings → System → Date and
                time and turn on the automatic date and time.</p></More></span>
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
              <span className="small">For phones away from home, without a server: a shared folder in your drive app.{' '}<More title="Syncing away from home"><p>For phones away from home, without a server: a folder your drive app keeps in step, like Google Drive, Dropbox, OneDrive, Syncthing or
                Nextcloud, or a WebDAV server. Each phone leaves its changes there, sealed with the household's key, and picks up the others'. Your list,
                pantry and ticks go this way; prices and photos stay on the Wi-Fi to keep it small. Slower, and depends on the drive app.</p></More></span>
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
                  <span className="small">Groceries, Bottle shop, Chemist, receipts and loyalty cards: each on or off for this phone.</span>
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
                <span className="small">Lets other phones sync with this one while Restock is closed.{' '}<More title="Sync while closed"><p>Lets the other phones sync with this one while Restock is closed. Android shows a quiet "Ready to sync" notification for it, which
                  you can hide in Android's notification settings. Off: syncs only while Restock is open.</p></More></span>
              </span>
            </label>
          </div>

          {batteryBlock}
        </>
      )}

      {!isHouse && (
      <div className="card" style={{ gap: 6 }}>
        <strong>Good to know</strong>
        <span className="small">On the Wi-Fi, both phones need to be there at the same time.{' '}<More title="How phones find each other"><p>On the Wi-Fi, both phones need to be there at the same time; whatever changed while apart catches up then (or away from home, if you've
          set that up). Phones only look for each other on Wi-Fi (or a network cable), never over mobile data. Some routers and guest networks
          keep devices from seeing each other ("client isolation" or "AP isolation"); if the phones never find each other, that's the usual reason.</p></More></span>
        <span className="small">Codes work once, for 10 minutes, and never contain the household's key.{' '}<More title="Codes and backups"><p>Codes work once and only for 10 minutes, and never contain the household's key, so a code that's been seen or shared can't be used later.
          Backups never include the household either: a phone restored from a backup joins again with a new code.</p></More></span>
        <span className="small">If both phones change the same thing, the later change wins.{' '}<More title="When two phones disagree"><p>If both phones change the same thing while apart, the later change wins. Restoring a backup on one phone changes the household's things to
          match it.</p></More></span>
      </div>
      )}

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
