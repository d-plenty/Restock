import { askChoice } from '../../lib/confirm';
import { isIos } from '../../lib/platform';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { applyTheme } from '../../lib/theme';
import type { BackupSummary } from '../../lib/backup';
import { allCards, getSettings, updateSettings } from '../../lib/db';
import { canSync, syncInfo } from '../../lib/sync';
import legal from '../../lib/legal.json';
import { downloadMarket } from '../../lib/market';
import { HistoryLengths } from './DayOne';
import { SHARED_ONE_LINE, SHARED_TITLE, TurnOffShared } from './SharedPrices';
import { shareFromNow, sharedOn } from '../../lib/priceShare';
import { useLive, useSettings } from '../../lib/useLive';
import { NameFields } from '../NameAsk';
import { enabledIn, SECTION_NAMES, sectionOn, type MadeSection } from '../../shops';
import { CustomStarts, madeInUse } from './CustomSections';
import { checkAll } from '../../lib/permissions';
import { ensureNotificationPermission } from '../../lib/notify';
import { SELF_UPDATE } from '../../lib/updates';
import { DEFAULT_SETTINGS } from '../../types';
import { isNative } from '../../stores/http';
import type { Settings } from '../../types';
import { BETA_NOTE, CUSTOM_BETA_NOTE, Icon, Logo, TopBar, useBackHandler, More, ScreenWaiting } from '../components';
import { useNav } from '../nav';
import { AutoBackupSettings, SuggestLocalBackup } from './Backups';
import { protection, suggestLocalText } from '../../lib/protection';
import { LegalSheet } from './Legal';
import { AccessibilitySettings, LookSettings } from './Look';
import { PermissionList } from './Permissions';
import { RecallSettings } from './Recalls';
import { ReceiptsSettings } from './Receipts';
import { readBackupFile, RestoreSheet } from './Restore';
import { StoreFields } from './Stores';
import { JoinSheet, scanJoinCode } from './Sync';
import { NotificationSettings, PriceCheckSettings, UpdateRows } from './SettingsParts';
import { syncSummary } from './Sync';
import { WidgetSettings } from './WidgetSettings';

// Setup: a welcome screen, the privacy step (the only one that's required), then a page of
// tiles. Each tile can be done in any order, or Continue goes through the unfinished ones.
// Anything left can be finished later from Settings → Setup.

export type TileId =
  | 'pantry'
  | 'keg'
  | 'pharmacy'
  // 0.10.3 (beta): the Baby and Pets tabs. 0.10.7: custom sections in their place (old tiles stay readable).
  | 'baby'
  | 'pets'
  | 'custom'
  | 'permissions'
  | 'receipts'
  | 'recalls'
  | 'backups'
  | 'history'
  | 'look'
  | 'a11y'
  // 0.8.0: everything else in Settings, so people know it's there.
  | 'accounts'
  | 'checks'
  | 'alerts'
  | 'household'
  | 'sync'
  | 'widgets'
  | 'updates';

interface Tile {
  id: TileId;
  title: string;
  sub: string;
  icon: string;
  heading: string;
  intro: string;
}

const ALL_TILES: Tile[] = [
  {
    id: 'pantry',
    title: 'Supermarkets',
    sub: 'Pantry tab · Woolworths, Coles, Aldi, IGA and more',
    icon: 'cart',
    heading: 'Where do you shop?',
    intro:
      "Tick the shops your Pantry searches and compares: supermarkets, or any shop below. Nothing's ticked to start with. Each shop has its sign-in (optional) and what works under its tick.",
  },
  {
    id: 'keg',
    title: 'Bottle shops',
    sub: 'Beer, wine and spirits · 18+ · Beta',
    icon: 'keg',
    heading: 'Track bottle shops too?',
    intro: `Beer, wine and spirits on a Bottle shop tab of their own, kept apart from groceries, so a search for chips never goes to a bottle shop. ${BETA_NOTE}`,
  },
  {
    id: 'pharmacy',
    title: 'Chemists',
    sub: 'Medicine and personal care · Beta',
    icon: 'pharmacy',
    heading: 'Track chemists too?',
    intro: `Medicine, first aid and personal care on a Chemist tab of its own, kept apart from groceries. ${BETA_NOTE}`,
  },
  {
    id: 'custom',
    title: 'Custom tabs',
    sub: 'Pets, tools, automotive, baby and more · Beta',
    icon: 'pack:star',
    heading: 'Compare other kinds of shops?',
    intro:
      "Make a section for anything else you buy: pet shops, tools, automotive, baby things. Each gets its own name, colour, icon and shops. Skip it if it's not for you; you can make one later from More. " + CUSTOM_BETA_NOTE,
  },
  {
    id: 'permissions',
    title: 'Permissions',
    sub: 'Camera, location, alerts',
    icon: 'shield',
    heading: 'Allow what Restock needs',
    intro: "Tap Allow all and you're set. Or skip this: Restock asks for each one the first time it's needed, like the camera when you first scan.",
  },
  {
    id: 'receipts',
    title: 'Receipts',
    sub: 'Scan and keep, read on your phone',
    icon: 'receipt',
    heading: 'Keep your receipts?',
    intro: 'Scan receipts into Restock and keep them for as long as you choose.',
  },
  {
    id: 'recalls',
    title: 'Recall alerts',
    sub: 'Checked every day',
    icon: 'bell',
    heading: 'Recall alerts',
    intro: 'Restock checks the official Australian recall lists once a day and tells you if something you have might be affected.',
  },
  {
    id: 'backups',
    title: 'Backups',
    sub: 'A copy somewhere else',
    icon: 'download',
    heading: 'Keep a copy somewhere else?',
    intro:
      'So a lost phone or a wrong uninstall never wipes your pantry, list and price history. Any one of these counts: a backup on this phone, phone-to-phone sync, or your own Restock server. Use one, two or all three.',
  },
  {
    id: 'history',
    title: 'Shared prices',
    sub: 'Judge new items from day one',
    icon: 'chart',
    heading: 'Share prices, and judge new items from day one',
    intro:
      "On its own, Restock needs about 4 to 8 weeks of watching an item before it knows its usual price. With shared prices, it knows from day one.",
  },
  {
    id: 'look',
    title: 'Look and colours',
    sub: 'Theme, accent, icon',
    icon: 'palette',
    heading: 'Look and colours',
    intro: 'Australian green and gold by default. Make it yours.',
  },
  {
    id: 'accounts',
    title: 'Cards and shop accounts',
    sub: 'Member prices, your own branch',
    icon: 'card',
    heading: 'Cards and shop accounts',
    intro:
      'Add your Flybuys and Everyday Rewards cards so member prices count. Sign in to Woolworths or Costco, or pick your Coles branch, and prices and stock are for your local shop.',
  },
  {
    id: 'checks',
    title: 'Price checks',
    sub: 'How often, which day',
    icon: 'refresh',
    heading: 'Checking prices for you',
    intro: 'Restock checks your items in the background, even while it is closed. Pick how often.',
  },
  {
    id: 'alerts',
    title: 'Notifications',
    sub: 'Which deals tell you',
    icon: 'bell',
    heading: 'Which alerts do you want?',
    intro: 'Restock only tells you about deals you care about. Each pantry item can also have its own alert level.',
  },
  {
    id: 'household',
    title: 'Household',
    sub: 'Your household’s name',
    icon: 'home',
    heading: 'Name your household',
    intro: "Your household's name, used by local sync so the phones in your house know they belong together.",
  },
  {
    id: 'sync',
    title: 'Sync',
    sub: 'Your server, Wi-Fi or a drive folder',
    icon: 'swap',
    heading: 'Share with your household?',
    intro:
      "Phones in the same house can share one pantry and shopping list. Best is your own Restock server: it's the house, and phones join it. No server? Phones on the same Wi-Fi swap changes straight to each other, or use a cloud drive folder. No account either way. Skip this if it's just you.",
  },
  {
    id: 'widgets',
    title: 'Widgets',
    sub: 'Deals and list on your home screen',
    icon: 'phone',
    heading: 'Home screen widgets',
    intro:
      "Restock has three: this week's deals, your shopping list, and quick actions (scan, list, receipt). To add one, press and hold an empty spot on your home screen, tap Widgets, and find Restock.",
  },
  {
    id: 'updates',
    title: 'Updates',
    sub: 'Hear about new versions',
    icon: 'up',
    heading: 'Stay up to date',
    intro: 'New versions of Restock come from GitHub. Restock can check every 24 hours (or every 7 days, if you’d rather) and tell you when there is one.',
  },
  {
    id: 'a11y',
    title: 'Accessibility',
    sub: 'Text size, contrast, motion',
    icon: 'access',
    heading: 'Accessibility',
    intro: 'Bigger text, stronger contrast, less motion and bigger buttons.',
  },
];

/**
 * The order setup goes through them: text size first, then your shops, how deals are judged and
 * told, keeping it safe and shared, then the add-ons.
 */
// 0.9.11: price checks, look and colours, household name, widgets and updates aren't asked in setup
// any more: they start on their defaults (checks once a day at 5:00 am, updates every 24 hours,
// "Our house") and are all in Settings. The household's name is set in Sync and backups.
// 0.9.12: what a new person cares about first: their shops, then how deals are judged and told,
// then keeping it safe and shared, then the extras.
const TILE_ORDER: TileId[] = ['a11y', 'pantry', 'history', 'alerts', 'accounts', 'permissions', 'backups', 'sync', 'keg', 'pharmacy', 'custom', 'receipts', 'recalls'];
const TAB_TILES: readonly string[] = ['keg', 'pharmacy'];
const isTabTile = (id: TileId): id is 'keg' | 'pharmacy' => TAB_TILES.includes(id);
// The Updates tile only where Restock updates itself from GitHub (not F-Droid builds).
/**
 * 0.10.10: the three that matter on day one: your shops (and branch), which deals tell you, and
 * what Restock may use (camera, location, alerts). Setup asks for these; the other ten are
 * "More, when you want it", and Home only reminds you about these three.
 */
const ESSENTIAL: readonly TileId[] = ['pantry', 'alerts', 'permissions'];
export const isEssential = (id: TileId) => ESSENTIAL.includes(id);
export const TILES: Tile[] = TILE_ORDER.filter((id) => SELF_UPDATE || id !== 'updates').map((id) => ALL_TILES.find((t) => t.id === id)!);

/** 0.9.3: what this phone syncs with, for the Backups tile (any of backup, phone sync or server counts). */
export type Cover = { paired?: boolean; server?: boolean; members?: unknown[] } | null | undefined;

/** A tile's status, as shown on it. */
export function tileStatus(s: Settings, id: TileId, cover?: Cover): { text: string; ok: boolean } {
  if (id === 'recalls') return { text: s.recalls.enabled ? 'On' : 'Off', ok: s.recalls.enabled };
  if (id === 'backups') {
    const p = protection(s.autoBackup.enabled, cover);
    if (p.covered) return { text: p.short, ok: true };
  }
  if (id === 'backups' && (s.autoBackup.enabled || s.setup.done.includes(id))) return { text: s.autoBackup.enabled ? 'On' : 'Off', ok: true };
  if (id === 'receipts' && (s.receipts.enabled || s.setup.done.includes(id))) return { text: s.receipts.enabled ? 'On' : 'Off', ok: true };
  // Shop tiles count as done when the tab is really on (shops picked), after a restore or joining a
  // household, say, not only when set up here. Decided to leave it off: "Off", done.
  if (isTabTile(id) && sectionOn(s, id)) return { text: 'On', ok: true };
  if (isTabTile(id) && s.setup.done.includes(id)) return { text: 'Off', ok: true };
  // 0.10.7: custom sections: done once one's made (or the tile's been passed)
  if (id === 'custom' && madeInUse(s).length) return { text: `${madeInUse(s).length} made`, ok: true };
  if (id === 'custom' && s.setup.done.includes(id)) return { text: 'None', ok: true };
  if (id === 'pantry' && !s.setup.done.includes(id) && Object.values(s.stores).some((c) => c?.primary || c?.storeId))
    return { text: 'Done ✓', ok: true };
  if (s.setup.done.includes(id)) return { text: 'Done ✓', ok: true };
  if (s.setup.skipped.includes(id)) return { text: 'Skipped', ok: false };
  return { text: id === 'backups' ? 'Off' : 'Not set up', ok: false };
}

/** 0.12.0: Bottle shop and Chemist have a tile only once they're switched on (they're starts under "Make a custom section" before that). */
// 0.13.0: they have no tile of their own at all: they're tabs you make, counted on the Custom tabs tile with the rest.
export const tilesFor = (_s: Settings) => TILES.filter((t) => !isTabTile(t.id));

/** Tiles that still need a look: not done and not skipped. (Recall alerts are on by default, so they count as done.) */
// Tiles still to go: not done, skipped, or already showing as set up (Keg on after a restore, say).
export const tilesLeft = (s: Settings, cover?: Cover) =>
  tilesFor(s).filter((t) => t.id !== 'recalls' && !s.setup.done.includes(t.id) && !s.setup.skipped.includes(t.id) && !tileStatus(s, t.id, cover).ok);

/**
 * 0.8.5: tiles that are set up, whether or not anyone tapped Next on them: every permission
 * allowed, auto backups, receipts or update alerts on, the look or accessibility changed, a
 * loyalty card added or a shop signed in. Checked when Restock opens and on the tiles page.
 */
export async function noticeSetUpTiles(): Promise<void> {
  try {
    const s = await getSettings();
    const found: TileId[] = [];
    const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
    if (s.autoBackup.enabled) found.push('backups');
    if (s.receipts.enabled) found.push('receipts');
    if (s.updates?.notify) found.push('updates');
    if (differs(s.look, DEFAULT_SETTINGS.look) || s.theme !== DEFAULT_SETTINGS.theme) found.push('look');
    if (differs(s.a11y, DEFAULT_SETTINGS.a11y)) found.push('a11y');
    const signedIn = Object.values(s.accounts ?? {}).some((a) => a?.signedIn) || !!s.stores.coles?.branchStoreNo;
    if (signedIn || (await allCards()).length) found.push('accounts');
    if (isNative()) {
      const p = await checkAll();
      if (Object.values(p).every((v) => v === 'granted' || v === 'unsupported')) found.push('permissions');
    }
    const fresh = found.filter((t) => !s.setup.done.includes(t));
    if (!fresh.length) return;
    const done = [...s.setup.done, ...fresh];
    await updateSettings({ setup: { ...s.setup, done, skipped: s.setup.skipped.filter((t) => !done.includes(t)) } });
  } catch (e) {
    console.error('setup check', e);
  }
}

async function mark(id: TileId, how: 'done' | 'skipped') {
  const s = await getSettings();
  const done = new Set(s.setup.done);
  const skipped = new Set(s.setup.skipped);
  if (how === 'done') {
    done.add(id);
    skipped.delete(id);
  } else if (!done.has(id)) skipped.add(id);
  await updateSettings({ setup: { ...s.setup, done: [...done], skipped: [...skipped] } });
}

// ---------- the welcome screen ----------

/** Seven-pointed (or five-pointed) star, as on the flag. */
function star(cx: number, cy: number, r: number, n: number): string {
  const inner = r * (n === 7 ? 0.44 : 0.4);
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const rr = i % 2 ? inner : r;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** The Australian flag hanging on its side (Union Jack top left), behind a navy wash. */
function FlagBackground() {
  const stars: [number, number, number, number][] = [
    [30, 45, 9, 7],
    [90, 10, 4.2, 7],
    [75.6, 26.2, 4.2, 7],
    [103, 22.5, 4.2, 7],
    [96, 34.5, 2.4, 5],
    [90, 52, 4.2, 7],
  ];
  return (
    <svg className="welcome-flag" viewBox="0 0 60 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <clipPath id="uj-s">
          <path d="M0,0 v30 h60 v-30 z" />
        </clipPath>
        <clipPath id="uj-t">
          <path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z" />
        </clipPath>
      </defs>
      <g transform="matrix(0 1 1 0 0 0)">
        <rect width="120" height="60" fill="#012169" />
        <g clipPath="url(#uj-s)">
          <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
          <path d="M0,0 L60,30 M60,0 L0,30" clipPath="url(#uj-t)" stroke="#C8102E" strokeWidth="4" />
          <path d="M30,0 v30 M0,15 h60" stroke="#fff" strokeWidth="10" />
          <path d="M30,0 v30 M0,15 h60" stroke="#C8102E" strokeWidth="6" />
        </g>
        {stars.map(([x, y, r, n]) => (
          <polygon key={`${x}-${y}`} points={star(x, y, r, n)} fill="#fff" />
        ))}
      </g>
    </svg>
  );
}

function Welcome({ onSetUp, onRestoreFile, onJoin, onA11y }: { onSetUp: () => void; /** A backup file was picked. */ onRestoreFile: (file: File) => void; onJoin: () => void; onA11y: () => void }) {
  // 0.9.10: navy behind the clock and the gesture bar, with light icons, while the welcome shows.
  useEffect(() => {
    document.documentElement.classList.add('on-welcome');
    if (Capacitor.isNativePlatform()) SystemBars.setStyle({ style: SystemBarsStyle.Dark }).catch(() => undefined);
    return () => {
      document.documentElement.classList.remove('on-welcome');
      void getSettings().then((s) => applyTheme(s)).catch(() => undefined);
    };
  }, []);
  return (
    <div className="welcome">
      <FlagBackground />
      <div className="welcome-shade" aria-hidden="true" />
      {/* 0.10.7: accessibility before anything else, for anyone who can't read the rest yet */}
      <button className="welcome-a11y" onClick={onA11y}>
        <Icon name="access" size={20} /> Accessibility
      </button>
      <div className="welcome-body">
        <Logo size={104} />
        <div className="welcome-hello">Welcome to</div>
        <h1 className="welcome-brand">Restock</h1>
        <p className="welcome-tag">
          Half price?
          <br />
          Prove it.
        </p>
        {/* 0.12.0: three short lines; the rest is in Settings and Help. */}
        <p className="welcome-desc">See if a special is really special, at the shops you use.</p>
        <p className="welcome-free">Free · no ads · no account</p>
        <div className="welcome-actions">
          <button className="welcome-go" onClick={onSetUp}>
            Set up
          </button>
          {/* 0.13.1: the file box itself is what's tapped (it lies over the words, unseen). Before, a button
              pressed a hidden file box from code, which on one phone opened nothing and left the screen stuck:
              a tap straight on a file box is the way every web view opens its picker. */}
          <label className="welcome-restore welcome-file">
            Restore from a backup
            <input
              type="file"
              accept="application/json,.json"
              aria-label="Restore from a backup"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) onRestoreFile(file);
              }}
            />
          </label>
          <button className="welcome-restore" onClick={onJoin}>
            Join your household
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- tile pages ----------

function MarketSetup({ settings }: { settings: Settings }) {
  // 0.10.0: one switch, as in Settings → Privacy and sharing (SharedPrices.tsx), on to start with.
  const on = sharedOn(settings);
  const [asking, setAsking] = useState(false);
  const turn = async (want: boolean) => {
    if (want && settings.sharePrices === 'no') await shareFromNow();
    await updateSettings({ sharePrices: want ? 'yes' : 'no', marketData: { ...settings.marketData, enabled: want } });
  };
  return (
    <div className="card">
      <p className="small">{SHARED_ONE_LINE}</p>
      <ul className="ticks">
        <li>
          <Icon name="check" size={16} />
          <span>
            <strong>What goes:</strong> only what the shop's own website showed: product, size, barcode, price, specials and the day.
          </span>
        </li>
        <li>
          <Icon name="check" size={16} />
          <span>
            <strong>Never:</strong> you, your account, lists, pantry, cards, branch, location, receipts, searches or prices you type in.
          </span>
        </li>
        <li>
          <Icon name="check" size={16} />
          <span>
            <strong>Open:</strong> published on GitHub for anyone to use, never sold. Nothing in it identifies you.
          </span>
        </li>
        <li>
          <Icon name="check" size={16} />
          <span>
            <strong>Small:</strong> under a megabyte a week for the shops you use, a few kilobytes to send.
          </span>
        </li>
      </ul>
      <label className="check" style={{ padding: 0 }}>
        <input
          type="checkbox"
          className="switch"
          checked={on}
          onChange={(e) => (e.target.checked ? turn(true) : setAsking(true))}
          aria-label={SHARED_TITLE}
        />
        <span className="title" style={{ fontSize: 15 }}>
          {SHARED_TITLE} {on ? '(on)' : '(off)'}
        </span>
      </label>
      <span className="title" style={{ fontSize: 15 }}>
        How far back Restock looks
      </span>
      <HistoryLengths settings={settings} />
      <p className="small" style={{ margin: 0 }}>
        Change these any time in Settings → Privacy and sharing and Prices and deals.
      </p>
      {asking && (
        <TurnOffShared
          onKeep={() => setAsking(false)}
          onOff={() => {
            setAsking(false);
            turn(false);
          }}
        />
      )}
    </div>
  );
}

/** Cards and shop accounts: straight to where each is set up (0.8.0). */
function AccountsTile() {
  const nav = useNav();
  const cards = useLive(async () => (await allCards()).length, []);
  return (
    <div className="card flush">
      <button className="row" onClick={() => nav.push({ name: 'cards' })}>
        <Icon name="card" size={18} />
        <span className="grow">
          <span className="title">Cards</span>
          <span className="small">{cards ? `${cards} added` : 'Flybuys, Everyday Rewards'}</span>
        </span>
        <Icon name="chevron" size={18} />
      </button>
      <button className="row" onClick={() => nav.push({ name: 'stores', section: 'pantry' })}>
        <Icon name="cart" size={18} />
        <span className="grow">
          <span className="title">Shop sign-ins and your Coles branch</span>
          <span className="small">Woolworths, Coles and Costco: your local prices, stock and member prices</span>
        </span>
        <Icon name="chevron" size={18} />
      </button>
    </div>
  );
}

/**
 * 0.9.3: Backups. Any of a backup on this phone, phone-to-phone sync or a Restock server counts;
 * with only sync or a server, a backup on this phone is suggested as well.
 */
function BackupsTile({ settings }: { settings: Settings }) {
  const nav = useNav();
  const info = useLive(syncInfo, []);
  const p = protection(settings.autoBackup.enabled, info);
  return (
    <>
      <AutoBackupSettings settings={settings} inSetup />
      <div className="card flush">
        <button className="row" onClick={() => nav.push({ name: 'restockServer' })}>
          <Icon name="server" size={18} />
          <span className="grow">
            <span className="title">{p.server ? 'Your Restock server is on' : 'Your Restock server'}</span>
            <span className="small">Keeps a copy on your own server, syncs at home and away, and gives you Restock on your computer.</span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
        <button className="row" onClick={() => nav.push({ name: 'sync' })}>
          <Icon name="swap" size={18} />
          <span className="grow">
            <span className="title">{p.phones ? 'Phone sharing is on' : 'Phone sharing (no server, local Wi-Fi)'}</span>
            <span className="small">Your other phones keep a copy. Works with no internet and no server.</span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
      </div>
      {p.suggestLocal && <SuggestLocalBackup text={suggestLocalText(p)} />}
    </>
  );
}

/**
 * Sync: where it's at, and the way in (0.8.0). 0.13.2: Phone sharing first and "Recommended" (no
 * account, no server), then a cloud folder, then a Restock server for those who run one. On iPhone
 * and iPad, only the ways that build can do (the rest are in Sync and backups, greyed, with why).
 */
function SyncTile() {
  const nav = useNav();
  const info = useLive(syncInfo, []);
  const ios = isIos();
  const wifiOn = !!info?.paired && !info.house;
  /** Everywhere but an iPhone or iPad, every way is listed (the web preview's screens say where they work). */
  const shown = (w: 'wifi' | 'folder' | 'server') => !ios || canSync(w);
  return (
    <div className="card flush">
      {shown('wifi') && (
        <button className="row" onClick={() => nav.push({ name: 'sync' })}>
          <Icon name="refresh" size={18} />
          <span className="grow">
            <span className="title" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {wifiOn ? 'Phone sharing is on' : 'Phone sharing (no server, local Wi-Fi)'}
              {!wifiOn && !info?.server && !ios && <span className="tag great">Recommended</span>}
            </span>
            <span className="small">{wifiOn ? syncSummary(info) : 'Phones swap changes straight to each other on the same Wi-Fi. No account, and nothing leaves your home.'}</span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
      )}
      {shown('folder') && (
        <button className="row" onClick={() => nav.push({ name: 'sync' })}>
          <Icon name="folder" size={18} />
          <span className="grow">
            <span className="title">A cloud drive folder</span>
            <span className="small">Google Drive, Dropbox, OneDrive, Syncthing, Nextcloud or WebDAV, for phones away from home without a server.</span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
      )}
      {shown('server') && (
        <button className="row" onClick={() => nav.push({ name: 'restockServer' })}>
          <Icon name="server" size={18} />
          <span className="grow">
            <span className="title">{info?.server ? 'Your Restock server' : 'Join your Restock server'}</span>
            <span className="small">
              {info?.server ? syncSummary(info) : 'If you run one: phones join it, it syncs around the clock at home and away, and gives you Restock on your computer.'}
            </span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
      )}
      {ios && (
        <div className="row">
          <span className="grow">
            <span className="small">An iPhone or iPad syncs while Restock is open. Every way of sharing, and what isn't here yet, is in Settings → Sync.</span>
          </span>
        </div>
      )}
    </div>
  );
}

/** 0.10.7: setup's custom sections: the starts, then the shops for the one just made. */
function CustomTile({ settings }: { settings: Settings }) {
  const [made, setMade] = useState<MadeSection>();
  const mine = madeInUse(settings);
  return (
    <>
      {mine.length > 0 && <p className="small" style={{ margin: 0 }}>Made so far: {mine.map((c) => SECTION_NAMES[c]).join(', ')}.</p>}
      {made ? (
        <>
          <StoreFields settings={settings} section={made} inSetup />
          <button className="btn" onClick={() => setMade(undefined)}>
            Make another
          </button>
        </>
      ) : (
        <CustomStarts onMade={setMade} />
      )}
    </>
  );
}

function TileBody({ id, settings }: { id: TileId; settings: Settings }): ReactNode {
  switch (id) {
    case 'pantry':
      return <StoreFields settings={settings} section="pantry" inSetup />;
    case 'keg':
      return <StoreFields settings={settings} section="keg" inSetup />;
    case 'pharmacy':
      return <StoreFields settings={settings} section="pharmacy" inSetup />;
    case 'baby':
    case 'pets':
    case 'custom':
      return <CustomTile settings={settings} />;
    case 'permissions':
      return (
        <>
          <PermissionList hideNote />
          <p className="small">Each one is only used for what it says.{' '}<More title="Permissions"><p>Each one is only used for what it says. For location, "While using the app" is plenty. Allow all asks for alarms last: Android opens its
            settings page, so turn on "Allow setting alarms and reminders" and come back. Change these later in Settings → Privacy and
            sharing → Permissions.</p></More></p>
        </>
      );
    case 'receipts':
      return <ReceiptsSettings settings={settings} inSetup />;
    case 'recalls':
      return <RecallSettings settings={settings} inSetup />;
    case 'backups':
      return <BackupsTile settings={settings} />;
    case 'history':
      return <MarketSetup settings={settings} />;
    case 'look':
      return <LookSettings settings={settings} />;
    case 'a11y':
      return <AccessibilitySettings settings={settings} />;
    case 'accounts':
      return <AccountsTile />;
    case 'checks':
      return <PriceCheckSettings settings={settings} />;
    case 'alerts':
      return <NotificationSettings settings={settings} />;
    case 'household':
      return (
        <label className="field">
          <span>Household name</span>
          <input
            className="input"
            defaultValue={settings.household.name}
            onBlur={(e) => updateSettings({ household: { name: e.target.value.trim() || 'Our house' } })}
          />
        </label>
      );
    case 'sync':
      return <SyncTile />;
    case 'widgets':
      return <WidgetSettings settings={settings} />;
    case 'updates':
      return (
        <div className="card flush">
          <UpdateRows settings={settings} />
        </div>
      );
  }
}

/** One tile's page, with Back to tiles, Skip and Next. */
function TilePage({
  tile,
  settings,
  onBack,
  onNext,
}: {
  tile: Tile;
  settings: Settings;
  onBack: () => void;
  onNext: (how: 'done' | 'skipped') => void;
}) {
  const needsShop = tile.id === 'pantry' && !enabledIn(settings.enabledChains, 'pantry', settings.shopTabs ?? {}).length;
  // 0.10.3: on a new phone nothing's ticked to start with: you pick your shops (Pantry needs one).
  // A phone that has shops already (restored, joined a household, set up before) keeps them.
  useEffect(() => {
    if (tile.id !== 'pantry' || settings.onboarded || settings.setup.done.includes('pantry')) return;
    const untouched = settings.enabledChains.join() === 'woolworths,coles,aldi' && !Object.values(settings.stores).some((c) => c?.primary || c?.storeId);
    if (untouched) void updateSettings({ enabledChains: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Changed something here and went back to the tiles without Next: that's set up, not skipped.
  const [opened] = useState(() => JSON.stringify(settings));
  const back = async () => {
    if (JSON.stringify(await getSettings()) !== opened) await mark(tile.id, 'done');
    onBack();
  };
  useBackHandler(() => {
    void back();
    return true;
  });
  return (
    <>
      <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => void back()}>
        <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
          <Icon name="chevron" size={16} />
        </span>
        All setup tiles
      </button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="eyebrow green">{tile.title}</div>
        <h1>{tile.heading}</h1>
        <p className="sub">{tile.intro}</p>
      </div>
      <TileBody id={tile.id} settings={settings} />
      <div className="spacer" />
      <div className="setup-foot">
        {/* 0.10.3: Pantry's shops can't be skipped (it's the heart of Restock); the other tabs can. */}
        {tile.id !== 'pantry' && (
          <button className="btn" onClick={() => onNext('skipped')}>
            Skip
          </button>
        )}
        <button className="btn primary" disabled={needsShop} onClick={() => onNext('done')}>
          Next
        </button>
      </div>
    </>
  );
}

/** The page of tiles (in setup, and in Settings → Setup). */
function SetupTiles({
  settings,
  onOpen,
  onLater,
  onContinue,
  onFinish,
  inSettings,
}: {
  settings: Settings;
  onOpen: (id: TileId) => void;
  onLater?: () => void;
  onContinue: () => void;
  /** Shown in place of Continue once every tile is done or skipped. */
  onFinish?: () => void;
  inSettings?: boolean;
}) {
  const cover = useLive(syncInfo, []);
  const nothingLeft = tilesLeft(settings, cover).length === 0;
  const essDone = TILES.filter((t) => isEssential(t.id) && tileStatus(settings, t.id, cover).ok).length;
  useEffect(() => {
    void noticeSetUpTiles();
  }, []);
  return (
    <>
      {!inSettings && (
        <div className="navy-top">
          <div className="eyebrow green">Setup</div>
          <h1>Set up Restock</h1>
          <p className="sub">Three things to start with. Continue goes through them; the rest can wait, and it's all in Settings later.</p>
        </div>
      )}
      {!inSettings && (
      <div className="setup-progress" aria-label={`${essDone} of ${ESSENTIAL.length} of the main three looked at`}>
        <div className="loading-bar">
          <span style={{ width: `${(essDone / ESSENTIAL.length) * 100}%` }} />
        </div>
        <span className="small">
          {essDone === ESSENTIAL.length ? 'All set' : `${essDone} of ${ESSENTIAL.length} looked at`}
        </span>
      </div>
      )}
      {settings.privacyAccepted && !inSettings && (
        <div className="setup-done-strip">
          <Icon name="check" size={18} stroke={3} /> Privacy and security · done
        </div>
      )}
      {/* 0.10.10: three to start with, then the rest (it was thirteen tiles in one grid).
          0.17.0: a checklist (it was a grid of tiles): one row each with what it's at. From
          Settings only what's still to do shows, and what's done folds away under it. */}
      {(() => {
        const rowOf = (t: Tile) => {
          const st = tileStatus(settings, t.id, cover);
          return (
            <button key={t.id} className={`row setup-row${st.ok ? ' done' : ''}`} onClick={() => onOpen(t.id)} aria-label={`${t.title}: ${st.text}`}>
              <span className="row-tile" data-tone={st.ok ? 'green' : 'slate'} aria-hidden="true">
                <Icon name={st.ok ? 'check' : t.icon} size={20} stroke={st.ok ? 3 : 2} />
              </span>
              <span className="grow">
                <span className="title">{t.title}</span>
                <span className="small">{t.sub}</span>
              </span>
              <span className={`setup-st${st.ok ? ' ok' : ''}`}>{st.text}</span>
              <Icon name="chevron" size={18} />
            </button>
          );
        };
        const all = tilesFor(settings);
        if (inSettings) {
          const left = all.filter((t) => !tileStatus(settings, t.id, cover).ok);
          const done = all.filter((t) => tileStatus(settings, t.id, cover).ok);
          return (
            <>
              {left.length > 0 ? <div className="card flush">{left.map(rowOf)}</div> : <p className="small">Everything&rsquo;s set up.</p>}
              {done.length > 0 && (
                <details className="card flush fold">
                  <summary className="row">
                    <span className="grow">
                      <span className="title">Done</span>
                      <span className="small">{done.length} set up</span>
                    </span>
                    <Icon name="chevron" size={18} />
                  </summary>
                  {done.map(rowOf)}
                </details>
              )}
            </>
          );
        }
        return [
          { label: 'The main three', tiles: all.filter((t) => isEssential(t.id)) },
          { label: 'More, when you want it', tiles: all.filter((t) => !isEssential(t.id)) },
        ].map((g) => (
          <div key={g.label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 className="eyebrow">{g.label}</h2>
            <div className="card flush">{g.tiles.map(rowOf)}</div>
          </div>
        ));
      })()}
      <div className="setup-foot sticky">
        {onLater && (
          <button className="btn" onClick={onLater}>
            Set up later
          </button>
        )}
        {/* 0.10.11: with nothing left to set up, the button finishes (Continue said "All set up." and left you to press Back) */}
        {nothingLeft && onFinish ? (
          <button className="btn primary" onClick={onFinish}>
            <Icon name="check" size={18} /> Finish setup
          </button>
        ) : (
          <button className="btn primary" onClick={onContinue}>
            Continue →
          </button>
        )}
      </div>
    </>
  );
}

/** Going through the tiles, one after another: in setup, and from Settings → Setup. */
function useTileWalk(onFinished: () => void) {
  const [open, setOpenState] = useState<TileId>();
  // Opened one tile from the page of tiles: Next or Skip goes back there. Continue goes through the rest.
  const [single, setSingle] = useState(false);
  const essentialsOnly = useRef(false);
  const setOpen = (id: TileId | undefined) => {
    setSingle(!!id);
    setOpenState(id);
  };
  const next = async (from: TileId | undefined, how?: 'done' | 'skipped') => {
    if (from && how) await mark(from, how);
    if (from && single) {
      setOpenState(undefined);
      setSingle(false);
      return;
    }
    const s = await getSettings();
    const every = tilesLeft(s, await syncInfo().catch(() => undefined));
    // 0.10.10: Continue goes through the three to start with; once they're done, through the rest.
    if (!from) essentialsOnly.current = every.some((t) => isEssential(t.id));
    const left = essentialsOnly.current ? every.filter((t) => isEssential(t.id)) : every;
    const after = from ? TILES.findIndex((t) => t.id === from) : -1;
    const upcoming = left.find((t) => TILES.findIndex((x) => x.id === t.id) > after) ?? (from ? undefined : left[0]);
    if (upcoming) setOpenState(upcoming.id);
    else {
      setOpenState(undefined);
      onFinished();
    }
  };
  return { open, setOpen, next };
}

// ---------- setup (first run) ----------

/** 0.12.0: the agreement in three lines. Shared prices are on to start with, so it says so here. */
const AGREE_POINTS: { icon: string; tone: string; title: string; text: string }[] = [
  { icon: 'phone', tone: 'green', title: 'Your stuff stays on your phone', text: 'Your list, pantry and anything you type in. No account.' },
  {
    icon: 'swap',
    tone: 'blue',
    title: 'Shop prices are shared',
    text: 'Shelf prices Restock reads from Coles, Woolworths and Aldi are sent on to help other shoppers. Nothing about you. You can turn it off in Settings.',
  },
  { icon: 'info', tone: 'amber', title: 'Prices can be wrong', text: "They come from the shops' websites. Check the shelf before you rely on one." },
];

export function Onboarding() {
  const settings = useSettings();
  // 0.10.7: accessibility comes straight after the welcome, before anything else is asked
  const [stage, setStage] = useState<'welcome' | 'a11y' | 'name' | 'privacy' | 'notify' | 'restored'>('welcome');
  // 0.8.2: joining a household from the first screen: privacy, then scan the owner phone's code.
  const [joiningHousehold, setJoiningHousehold] = useState(false);
  const [joinCode, setJoinCode] = useState<string>();
  const [joinedMsg, setJoinedMsg] = useState<string>();
  const [reading, setReading] = useState<'privacy' | 'disclaimer'>();
  const [picking, setPicking] = useState<BackupSummary>();
  const [asking, setAsking] = useState(false);
  const nav = useNav();
  const finish = async () => {
    await updateSettings({ onboarded: true });
    // Shared prices on (0.10.0: on to start with): the first download now (it waits for Wi-Fi if asked).
    const md = (await getSettings()).marketData;
    if (md.enabled && isNative()) {
      downloadMarket(undefined, { onlyUnmetered: md.wifiOnly })
        .then((r) =>
          nav.toast(
            r.waitingForWifi
              ? 'Shared prices will download next time you are on Wi-Fi.'
              : r.products
                ? `Shared prices ready for ${r.products.toLocaleString()} products`
                : "Shared prices for your shops aren't published yet. Restock gets them as soon as they are.",
          ),
        )
        .catch((e) => nav.toast(e instanceof Error ? e.message : String(e)));
    }
  };
  /** 0.12.0: the short setup's end: the rest is asked when it's first needed (your shops, on the first search). */
  const firstFinish = async () => {
    await updateSettings({ shopsAsked: false });
    await finish();
  };
  // Android's back button steps back through setup instead of closing Restock.
  useBackHandler(() => {
    if (stage === 'a11y' || stage === 'name' || stage === 'privacy' || stage === 'notify') {
      // 0.16.0: the name comes between the welcome and the agreement.
      setStage(stage === 'notify' ? 'privacy' : stage === 'privacy' ? 'name' : 'welcome');
      return true;
    }
    return false;
  });
  if (!settings) return null;

  /**
   * 0.15.0: Join your household, from the first screen or after a restore. A phone's code joins here
   * (JoinSheet). A server's code finishes the short setup and opens the server's page, which joins
   * with it straight away. On iPhone and iPad there's also the household's iCloud folder.
   */
  const joinHousehold = async () => {
    if (!isNative()) return nav.toast('Joining a household works in the app.');
    if (isIos()) {
      const how = await askChoice('How does your household sync?', 'Scan a code from your Restock server or an Android phone, or use your household’s iCloud folder.', [
        { id: 'scan', label: 'Scan a code', kind: 'primary' },
        { id: 'icloud', label: 'iCloud folder' },
      ]);
      if (!how) return;
      if (how === 'icloud') {
        // On iPhone and iPad, Sync is iCloud sync.
        nav.push({ name: 'sync' });
        await firstFinish();
        return;
      }
    }
    const got = await scanJoinCode();
    if (!got) return;
    if (got.kind === 'phone') return setJoinCode(got.code);
    nav.push({ name: 'restockServer', code: got.code });
    await firstFinish();
  };

  const restore = async (file: File) => {
    try {
      setPicking(await readBackupFile(file));
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : 'Could not read that file');
    }
  };

  const sheets = (
    <>
      {reading && <LegalSheet doc={reading} onClose={() => setReading(undefined)} />}
      {joinCode && (
        <JoinSheet
          code={joinCode}
          // From the first screen: a fresh phone takes the household's things. After a restore: ask.
          fresh={stage !== 'restored'}
          onClose={() => setJoinCode(undefined)}
          onJoined={(msg) => {
            setJoinCode(undefined);
            setJoinedMsg(msg);
            setStage('restored');
          }}
        />
      )}
      {picking && (
        <RestoreSheet
          summary={picking}
          // Stay in setup for one more step, so this phone can be given its permissions.
          inSetup={legal.updated}
          onClose={() => setPicking(undefined)}
          onDone={(what) => {
            setPicking(undefined);
            setStage('restored');
            nav.toast(`Restored your ${what}. Welcome back!`);
          }}
        />
      )}
    </>
  );

  if (stage === 'welcome')
    return (
      <>
        <Welcome
          onSetUp={() => {
            // 0.12.0: straight to the short agreement; accessibility is the button at the top.
            setJoiningHousehold(false);
            // 0.16.0: "What should we call you?" first.
            setStage('name');
          }}
          onRestoreFile={(file) => void restore(file)}
          onJoin={() => {
            setJoiningHousehold(true);
            setStage('name');
          }}
          onA11y={() => setStage('a11y')}
        />
        {sheets}
      </>
    );

  return (
    <div className="screen" style={{ gap: 16 }}>
      {stage === 'a11y' && (
        // 0.12.0: not a setup step any more: opened from the button on the welcome, and back to it.
        <>
          <div className="navy-top">
            <h1>Make Restock easier to see and use</h1>
            <p className="sub">You can change these any time in Settings → Accessibility.</p>
          </div>
          <AccessibilitySettings settings={settings} />
          <div className="spacer" />
          <button
            className="btn primary block"
            onClick={async () => {
              const s = await getSettings();
              if (!s.setup.done.includes('a11y')) await updateSettings({ setup: { ...s.setup, done: [...s.setup.done, 'a11y'] } });
              setStage('welcome');
            }}
          >
            Done
          </button>
        </>
      )}
      {stage === 'name' && (
        // 0.16.0: one box. The name goes with this phone into the household and its backups (myName.ts).
        <>
          <div className="navy-top">
            <h1>What should we call you?</h1>
          </div>
          <NameFields start={settings.myName ?? ''} onDone={() => setStage('privacy')} />
        </>
      )}
      {stage === 'privacy' && (
        // 0.12.0: the short version and one button; the full documents open from the two rows.
        <>
          {/* 0.12.4: the navy top every screen has */}
          <div className="navy-top">
            <h1>Before you start</h1>
            <p className="sub">The short version. The full documents are one tap away.</p>
          </div>
          <ul className="agree-points">
            {AGREE_POINTS.map((pt) => (
              <li key={pt.title}>
                <span className={`agree-ic ${pt.tone}`} aria-hidden="true">
                  <Icon name={pt.icon} size={22} />
                </span>
                <span>
                  <strong>{pt.title}</strong>
                  <span className="small">{pt.text}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="card flush">
            <button className="row" onClick={() => setReading('disclaimer')}>
              <span className="grow title">User agreement</span>
              <Icon name="chevron" size={18} />
            </button>
            <button className="row" onClick={() => setReading('privacy')}>
              <span className="grow title">Privacy policy</span>
              <Icon name="chevron" size={18} />
            </button>
          </div>
          <div className="spacer" />
          <button
            className="btn primary block agree-go"
            onClick={async () => {
              await updateSettings({ privacyAccepted: legal.updated });
              if (!joiningHousehold) return setStage('notify');
              await joinHousehold();
            }}
          >
            I agree
          </button>
          <p className="small" style={{ textAlign: 'center', margin: 0 }}>
            By tapping I agree, you accept the user agreement and privacy policy.
          </p>
        </>
      )}

      {stage === 'notify' && (
        // 0.12.0: the one permission asked up front. Camera and location are asked when first used.
        <>
          {/* 0.12.4: the navy top every screen has (the question was under the bell) */}
          <div className="navy-top">
            <h1>Want a heads-up on real specials?</h1>
            <p className="sub">Restock tells you when something you buy drops to a good price. Nothing else.</p>
          </div>
          <div className="notify-ask">
            <span className="notify-bell" aria-hidden="true">
              <Icon name="bell" size={44} />
            </span>
            <div className="card notify-eg" aria-label="Example notification">
              <Logo size={40} />
              <span>
                <span className="eyebrow">Example</span>
                <strong>Coffee beans 1kg is $18</strong>
                <span className="small">Lowest in 8 weeks at Coles</span>
              </span>
            </div>
          </div>
          <div className="spacer" />
          <button
            className="btn primary block agree-go"
            disabled={asking}
            onClick={async () => {
              setAsking(true);
              try {
                if (isNative()) await ensureNotificationPermission();
                const s = await getSettings();
                await updateSettings({ setup: { ...s.setup, done: [...new Set([...s.setup.done, 'alerts'])] } });
              } finally {
                setAsking(false);
              }
              await firstFinish();
            }}
          >
            Turn on notifications
          </button>
          <button className="btn ghost block" disabled={asking} onClick={() => void firstFinish()}>
            Not now
          </button>
          <p className="small" style={{ textAlign: 'center', margin: 0 }}>
            Change this any time in Settings.
          </p>
        </>
      )}

      {stage === 'restored' && (
        <>
          <div className="navy-top">
            <div className="eyebrow green">Nearly there</div>
            <h1>Allow what Restock needs</h1>
            <p className="sub">
              {joinedMsg
                ? `${joinedMsg} Your household's shops and settings are on this phone too. Allow what this phone needs, or skip: Restock asks for each one the first time it's needed.`
                : "Your things are back. Allow what this phone needs, or skip: Restock asks for each one the first time it's needed."}
            </p>
          </div>
          <PermissionList hideNote />
          {!joinedMsg && isNative() && (
            <div className="card" style={{ gap: 6 }}>
              <strong>Share with your household again?</strong>
              <span className="small">
                Backups don't include the household. To sync this phone, join with a new code from the owner phone (Settings → Sync → Add a phone
                there).
              </span>
              <button
                className="btn small"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => void joinHousehold()}
              >
                Join your household
              </button>
            </div>
          )}
          <div className="spacer" />
          <button className="btn primary block" onClick={() => void noticeSetUpTiles().then(finish)}>
            Open Restock
          </button>
        </>
      )}
      {sheets}
    </div>
  );
}

// ---------- Settings → Setup ----------

export function SetupScreen() {
  const settings = useSettings();
  const nav = useNav();
  // Went through everything: back to the tiles, which show what's done and what was skipped.
  const walk = useTileWalk(() => {
    void getSettings().then((s) => nav.toast(s.setup.skipped.length ? "That's all of them. Skipped ones are still here when you want them." : 'All set up.'));
  });
  if (!settings) return <ScreenWaiting title="Setup checklist" />;
  const tile = walk.open && TILES.find((t) => t.id === walk.open);
  return (
    <div className="screen" style={{ gap: 16 }}>
      {!tile && (
        <>
          <TopBar title="Setup checklist" />
          <p className="sub">What&rsquo;s still to set up. Nothing has to be done first: Restock asks for each thing when it&rsquo;s needed.</p>
          <SetupTiles
            settings={settings}
            inSettings
            onOpen={walk.setOpen}
            onContinue={() => void walk.next(undefined)}
            onFinish={() => {
              nav.toast('All set up.');
              nav.pop();
            }}
          />
        </>
      )}
      {tile && <TilePage tile={tile} settings={settings} onBack={() => walk.setOpen(undefined)} onNext={(how) => void walk.next(tile.id, how)} />}
    </div>
  );
}
