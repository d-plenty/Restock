import { useRef, useState, type ReactNode } from 'react';
import type { BackupSummary } from '../../lib/backup';
import { getSettings, updateSettings } from '../../lib/db';
import legal from '../../lib/legal.json';
import { downloadMarket, MARKET_SIZE_TEXT, MARKET_SOURCE } from '../../lib/market';
import { useLive } from '../../lib/useLive';
import { enabledIn } from '../../shops';
import { isNative } from '../../stores/http';
import type { Settings } from '../../types';
import { Icon, Logo, TopBar } from '../components';
import { useNav } from '../nav';
import { AutoBackupSettings } from './Backups';
import { LegalSheet } from './Legal';
import { AccessibilitySettings, LookSettings } from './Look';
import { PermissionList } from './Permissions';
import { RecallSettings } from './Recalls';
import { ReceiptsSettings } from './Receipts';
import { ADDON_SIZE_TEXT } from '../../lib/receiptReader';
import { readBackupFile, RestoreSheet } from './Restore';
import { StoreFields } from './Stores';

// Setup: a welcome screen, the privacy step (the only one that's required), then a page of
// tiles. Each tile can be done in any order, or Continue goes through the unfinished ones.
// Anything left can be finished later from Settings → Setup.

export type TileId = 'pantry' | 'keg' | 'pharmacy' | 'permissions' | 'receipts' | 'recalls' | 'backups' | 'history' | 'look' | 'a11y';

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
    sub: 'Woolworths, Coles, Aldi',
    icon: 'cart',
    heading: 'Where do you shop?',
    intro: 'Pick your supermarkets and nearest stores.',
  },
  {
    id: 'keg',
    title: 'Bottle shops',
    sub: 'Keg tab · 18+',
    icon: 'keg',
    heading: 'Track bottle shops too?',
    intro: 'Beer, wine and spirits on a Keg tab of their own, kept apart from groceries, so a search for chips never goes to a bottle shop.',
  },
  {
    id: 'pharmacy',
    title: 'Pharmacies',
    sub: 'Pharmacy tab',
    icon: 'pharmacy',
    heading: 'Track pharmacies too?',
    intro: 'Medicine, first aid and personal care on a Pharmacy tab of its own, kept apart from groceries.',
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
    sub: `Scan and keep · ${ADDON_SIZE_TEXT.replace('about ', '')}`,
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
    title: 'Auto backups',
    sub: 'A copy to a folder',
    icon: 'download',
    heading: 'Back up automatically?',
    intro: 'Save a backup file into a folder on your phone every week, so a wrong uninstall never wipes your history.',
  },
  {
    id: 'history',
    title: 'Price history',
    sub: 'Judge deals from day one',
    icon: 'chart',
    heading: 'Judge deals from day one?',
    intro:
      "On its own, Restock needs about 4 to 8 weeks of watching an item before it knows its normal price. It still tells you about specials straight away, but can't say how good they are.",
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
    id: 'a11y',
    title: 'Accessibility',
    sub: 'Text size, contrast, motion',
    icon: 'access',
    heading: 'Accessibility',
    intro: 'Bigger text, stronger contrast, less motion and bigger buttons.',
  },
];

/**
 * The order setup goes through them: how Restock looks and works for you first (text size,
 * permissions, colours, backups, price history), then your shops, then the add-ons.
 */
const TILE_ORDER: TileId[] = ['a11y', 'permissions', 'look', 'backups', 'history', 'pantry', 'keg', 'pharmacy', 'receipts', 'recalls'];
export const TILES: Tile[] = TILE_ORDER.map((id) => ALL_TILES.find((t) => t.id === id)!);

/** A tile's status, as shown on it. */
export function tileStatus(s: Settings, id: TileId): { text: string; ok: boolean } {
  if (id === 'recalls') return { text: s.recalls.enabled ? 'On' : 'Off', ok: s.recalls.enabled };
  if (id === 'backups' && s.setup.done.includes(id)) return { text: s.autoBackup.enabled ? 'On' : 'Off', ok: true };
  if (id === 'receipts' && s.setup.done.includes(id)) return { text: s.receipts.enabled ? 'On' : 'Off', ok: true };
  // Shop tiles count as done when the shops are there (after a restore, say), not only when set up here.
  if (id === 'keg' && s.sections.keg) return { text: 'On', ok: true };
  if (id === 'pharmacy' && s.sections.pharmacy) return { text: 'On', ok: true };
  if (id === 'pantry' && !s.setup.done.includes(id) && Object.values(s.stores).some((c) => c?.primary || c?.storeId))
    return { text: 'Done ✓', ok: true };
  if (s.setup.done.includes(id)) return { text: 'Done ✓', ok: true };
  if (s.setup.skipped.includes(id)) return { text: 'Skipped', ok: false };
  return { text: id === 'backups' ? 'Off' : 'Not set up', ok: false };
}

/** Tiles that still need a look: not done and not skipped. (Recall alerts are on by default, so they count as done.) */
// Tiles still to go: not done, skipped, or already showing as set up (Keg on after a restore, say).
export const tilesLeft = (s: Settings) =>
  TILES.filter((t) => t.id !== 'recalls' && !s.setup.done.includes(t.id) && !s.setup.skipped.includes(t.id) && !tileStatus(s, t.id).ok);

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

function Welcome({ onSetUp, onRestore }: { onSetUp: () => void; onRestore: () => void }) {
  return (
    <div className="welcome">
      <FlagBackground />
      <div className="welcome-shade" aria-hidden="true" />
      <div className="welcome-body">
        <Logo size={104} />
        <div className="welcome-hello">Welcome to</div>
        <h1 className="welcome-brand">Restock</h1>
        <p className="welcome-tag">
          Half price?
          <br />
          Prove it.
        </p>
        <p className="welcome-desc">
          Restock watches prices at the stores you choose, and tells you when a special is real, when to wait, and when to swap.
        </p>
        <p className="welcome-tag2">Find out if the special is really special.</p>
        <p className="welcome-made">Made in Australia, for Australian shoppers</p>
        <p className="welcome-free">Free · no ads · no account</p>
        <div className="welcome-actions">
          <button className="welcome-go" onClick={onSetUp}>
            Set up
          </button>
          <button className="welcome-restore" onClick={onRestore}>
            Restore from a backup
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- tile pages ----------

function MarketSetup({ settings }: { settings: Settings }) {
  return (
    <div className="card">
      <div className="title">Download shared price history</div>
      <p className="small">
        Restock can download months of real Coles and Woolworths prices collected by public price trackers (for now, {MARKET_SOURCE}, an open-source
        project that records both stores every day). From that it works out each product's normal price, usual sale price and how often it goes on
        sale, so new items get a proper verdict straight away. Aldi isn't covered yet.
      </p>
      <ul className="ticks">
        <li>
          <Icon name="check" size={16} />
          <span>
            <strong>Size:</strong> {MARKET_SIZE_TEXT} the first time, then about once a week. Only a small summary is kept on your phone.
          </span>
        </li>
        <li>
          <Icon name="check" size={16} />
          <span>
            <strong>Private:</strong> everyone downloads the same file, so it can't tell what you buy or track.
          </span>
        </li>
        <li>
          <Icon name="check" size={16} />
          <span>
            <strong>Testing:</strong> this is new. Turn it on or off any time in Settings → Shared price history.
          </span>
        </li>
      </ul>
      <label className="check" style={{ padding: 0 }}>
        <input
          type="checkbox"
          checked={settings.marketData.enabled}
          onChange={(e) => updateSettings({ marketData: { ...settings.marketData, enabled: e.target.checked } })}
          aria-label="Download shared price history"
        />
        <span className="title" style={{ fontSize: 15 }}>
          Download shared price history
        </span>
      </label>
      <label className="check" style={{ padding: 0 }}>
        <input
          type="checkbox"
          checked={settings.marketData.wifiOnly}
          onChange={(e) => updateSettings({ marketData: { ...settings.marketData, wifiOnly: e.target.checked } })}
        />
        <span className="small">Only download on Wi-Fi</span>
      </label>
    </div>
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
    case 'permissions':
      return (
        <>
          <PermissionList hideNote />
          <p className="small">
            Each one is only used for what it says. For location, "While using the app" is plenty. Allow all asks for alarms last: Android opens its
            settings page, so turn on "Allow setting alarms and reminders" and come back. Change these later in Settings → Troubleshooting →
            Permissions.
          </p>
        </>
      );
    case 'receipts':
      return <ReceiptsSettings settings={settings} inSetup />;
    case 'recalls':
      return <RecallSettings settings={settings} inSetup />;
    case 'backups':
      return <AutoBackupSettings settings={settings} inSetup />;
    case 'history':
      return <MarketSetup settings={settings} />;
    case 'look':
      return <LookSettings settings={settings} />;
    case 'a11y':
      return <AccessibilitySettings settings={settings} />;
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
  const needsShop = tile.id === 'pantry' && !enabledIn(settings.enabledChains, 'pantry').length;
  return (
    <>
      <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
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
        <button className="btn" onClick={() => onNext('skipped')}>
          Skip
        </button>
        <button className="btn primary" disabled={needsShop} onClick={() => onNext('done')}>
          Next
        </button>
      </div>
    </>
  );
}

/** The page of tiles (in setup, and in Settings → Setup). */
export function SetupTiles({
  settings,
  onOpen,
  onLater,
  onContinue,
  inSettings,
}: {
  settings: Settings;
  onOpen: (id: TileId) => void;
  onLater?: () => void;
  onContinue: () => void;
  inSettings?: boolean;
}) {
  const doneCount = TILES.filter((t) => tileStatus(settings, t.id).ok).length;
  return (
    <>
      {!inSettings && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="eyebrow green">Setup</div>
          <h1>Set up Restock</h1>
          <p className="sub">Tap any tile, or press Continue to go through them in order. You can change all of it later in Settings.</p>
        </div>
      )}
      <div className="setup-progress" aria-label={`${doneCount} of ${TILES.length} done`}>
        <div className="loading-bar">
          <span style={{ width: `${(doneCount / TILES.length) * 100}%` }} />
        </div>
        <span className="small">
          {doneCount} of {TILES.length} done
        </span>
      </div>
      {settings.privacyAccepted && (
        <div className="setup-done-strip">
          <Icon name="check" size={18} stroke={3} /> Privacy and security · done
        </div>
      )}
      <div className="setup-grid">
        {TILES.map((t) => {
          const st = tileStatus(settings, t.id);
          return (
            <button key={t.id} className={`setup-tile${st.ok ? ' done' : ''}`} onClick={() => onOpen(t.id)} aria-label={`${t.title}: ${st.text}`}>
              <span className="setup-ic">
                <Icon name={t.icon} size={20} />
              </span>
              <span className="setup-tt">{t.title}</span>
              <span className="setup-td">{t.sub}</span>
              <span className={`setup-st${st.ok ? ' ok' : ''}`}>{st.text}</span>
            </button>
          );
        })}
      </div>
      <div className="setup-foot sticky">
        {onLater && (
          <button className="btn" onClick={onLater}>
            Set up later
          </button>
        )}
        <button className="btn primary" onClick={onContinue}>
          Continue →
        </button>
      </div>
    </>
  );
}

/** Going through the tiles, one after another: in setup, and from Settings → Setup. */
function useTileWalk(onFinished: () => void) {
  const [open, setOpen] = useState<TileId>();
  const next = async (from: TileId | undefined, how?: 'done' | 'skipped') => {
    if (from && how) await mark(from, how);
    const s = await getSettings();
    const left = tilesLeft(s);
    const after = from ? TILES.findIndex((t) => t.id === from) : -1;
    const upcoming = left.find((t) => TILES.findIndex((x) => x.id === t.id) > after) ?? (from ? undefined : left[0]);
    if (upcoming) setOpen(upcoming.id);
    else {
      setOpen(undefined);
      onFinished();
    }
  };
  return { open, setOpen, next };
}

// ---------- setup (first run) ----------

export function Onboarding() {
  const settings = useLive(getSettings, []);
  const [stage, setStage] = useState<'welcome' | 'privacy' | 'tiles' | 'restored'>('welcome');
  const [reading, setReading] = useState<'privacy' | 'disclaimer'>();
  const [picking, setPicking] = useState<BackupSummary>();
  const nav = useNav();
  const fileRef = useRef<HTMLInputElement>(null);
  const finish = async () => {
    await updateSettings({ onboarded: true });
    // Chose shared price history: start the first download now (it waits for Wi-Fi if asked).
    const md = (await getSettings()).marketData;
    if (md.enabled && isNative()) {
      downloadMarket(undefined, { onlyUnmetered: md.wifiOnly })
        .then((r) =>
          nav.toast(
            r.waitingForWifi
              ? 'Shared price history will download next time you are on Wi-Fi.'
              : `Shared price history ready for ${r.products.toLocaleString()} products`,
          ),
        )
        .catch((e) => nav.toast(e instanceof Error ? e.message : String(e)));
    }
  };
  const walk = useTileWalk(() => void finish());
  if (!settings) return null;

  const restore = async (file: File) => {
    try {
      setPicking(await readBackupFile(file));
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : 'Could not read that file');
    }
  };

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="application/json,.json"
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) void restore(file);
      }}
    />
  );

  const sheets = (
    <>
      {reading && <LegalSheet doc={reading} onClose={() => setReading(undefined)} />}
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
        <Welcome onSetUp={() => setStage('privacy')} onRestore={() => fileRef.current?.click()} />
        {fileInput}
        {sheets}
      </>
    );

  const tile = walk.open && TILES.find((t) => t.id === walk.open);
  return (
    <div className="screen" style={{ gap: 16 }}>
      {stage === 'privacy' && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="eyebrow green">Privacy and security</div>
            <h1>Your data stays yours</h1>
            <p style={{ fontWeight: 600, margin: 0 }}>{legal.privacy.tagline}</p>
            <p className="sub">{legal.privacy.intro}</p>
          </div>
          <div className="card">
            <div className="title">In short</div>
            <ul className="ticks">
              {legal.privacy.summary.map((s) => (
                <li key={s}>
                  <Icon name="check" size={16} />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
            <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setReading('privacy')}>
              Read the full privacy policy
            </button>
          </div>
          <div className="card">
            <div className="title">The fine print</div>
            <ul className="ticks">
              {legal.disclaimer.summary.map((s) => (
                <li key={s}>
                  <Icon name="info" size={16} />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
            <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setReading('disclaimer')}>
              Read the fine print
            </button>
          </div>
          <div className="spacer" />
          <div className="two">
            <button className="btn" onClick={() => setStage('welcome')}>
              Back
            </button>
            <button
              className="btn primary"
              onClick={async () => {
                await updateSettings({ privacyAccepted: legal.updated });
                setStage('tiles');
              }}
            >
              I understand
            </button>
          </div>
        </>
      )}

      {stage === 'tiles' && !tile && (
        <SetupTiles settings={settings} onOpen={walk.setOpen} onLater={() => void finish()} onContinue={() => void walk.next(undefined)} />
      )}
      {stage === 'tiles' && tile && (
        <TilePage tile={tile} settings={settings} onBack={() => walk.setOpen(undefined)} onNext={(how) => void walk.next(tile.id, how)} />
      )}

      {stage === 'restored' && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="eyebrow green">Nearly there</div>
            <h1>Allow what Restock needs</h1>
            <p className="sub">Your things are back. Allow what this phone needs, or skip: Restock asks for each one the first time it's needed.</p>
          </div>
          <PermissionList hideNote />
          <div className="spacer" />
          <button className="btn primary block" onClick={() => updateSettings({ onboarded: true })}>
            Open Restock
          </button>
        </>
      )}
      {fileInput}
      {sheets}
    </div>
  );
}

// ---------- Settings → Setup ----------

export function SetupScreen() {
  const settings = useLive(getSettings, []);
  const nav = useNav();
  // Nothing left to set up: back to Settings.
  const walk = useTileWalk(() => {
    nav.toast('All set up.');
    nav.pop();
  });
  if (!settings) return <div className="screen" />;
  const tile = walk.open && TILES.find((t) => t.id === walk.open);
  return (
    <div className="screen" style={{ gap: 16 }}>
      {!tile && (
        <>
          <TopBar title="Setup" />
          <p className="sub">Everything from first setup, in one place. Tap a tile to change it.</p>
          <SetupTiles settings={settings} inSettings onOpen={walk.setOpen} onContinue={() => void walk.next(undefined)} />
        </>
      )}
      {tile && <TilePage tile={tile} settings={settings} onBack={() => walk.setOpen(undefined)} onNext={(how) => void walk.next(tile.id, how)} />}
    </div>
  );
}
