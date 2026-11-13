import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { version } from '../../../package.json';
import legal from '../../lib/legal.json';
import { confirmAction } from '../../lib/confirm';
import type { BackupSummary } from '../../lib/backup';
import { shareCsv } from '../../lib/csvExport';
import { RestockNative } from '../../lib/sql/native';
import { syncInfo, type SyncInfo } from '../../lib/sync';
import { isNative } from '../../stores/http';
import { allCards, allGiftCards, eraseEverything, getSettings as savedSettings, priceHistorySpan, updateSettings as saveNow } from '../../lib/db';
import { sharedOn } from '../../lib/priceShare';
import { SharedPricesSection } from './SharedPrices';
import { sendSpendingToServer, spendingOnServer } from '../../lib/spending';
// 0.9.5 (save): settings changed here wait for "Save settings" (settingsDraft.ts).
import { afterSave, getSettings, updateSettings } from '../../lib/settingsDraft';
import { PriceHelperSettings } from './PriceHelperSettings';
import { PriceHistorySettings } from './DayOne';
import { YourData } from './YourData';
import { Credits } from './Credits';
import { dailyTimes, DEFAULT_CHECK_TIME, isCheckTime } from '../../lib/checkSchedule';
import { SaveBar, useSettingsDraft } from '../SaveBar';
import { loadDemo, removeDemo } from '../../lib/demo';
import { syncBackgroundSchedule } from '../../lib/check';
import { ensureNotificationPermission, scheduleReminders } from '../../lib/notify';
import { useLive } from '../../lib/useLive';
import { money } from '../../lib/units';
import { STALE_DAYS } from '../../lib/verdict';
import { chainName, CHECK_INTERVALS, GOOD_SALE, GREAT_SALE, historyLabel, WEEKDAYS, type Settings } from '../../types';
import { ChainDot, Explain, Icon, Logo, Sheet, timeAgo, TopBar } from '../components';
import { UnblockButton } from '../Unblock';
import { AccessibilitySettings, LookSettings } from './Look';
import { AutoBackupSettings } from './Backups';
import { SyncOverview } from './SyncOverview';
import { ReceiptsSettings } from './Receipts';
import { recallSummary } from './Recalls';
import { ComingSoon } from './Soon';
import { WidgetSettings } from './WidgetSettings';
import { TILES, tileStatus } from './Setup';
import { startTour } from '../Tour';
import { getHealth, testConnections, type ConnectionTest, type StoreChain } from '../../lib/health';
import { useNav } from '../nav';
import { checkForUpdate, installUpdate, RELEASES, SELF_UPDATE, type UpdateInfo } from '../../lib/updates';
import { activeSections, searchChainsIn, type Section } from '../../shops';
import { shopSummary } from './Stores';
import { ExportSheet, pricesIn } from './BackupParts';
import { LegalSheet } from './Legal';
import { readBackupFile, RestoreSheet } from './Restore';
import { getHaConfig, haPhone, phoneLabel } from '../../lib/homeAssistant';
import { serverMode } from '../../server-mode/flag';
import { webLink } from '../../lib/site';

/** Settings → Shopping list: how much shopping around has to save (0.9.0). */
const SHOP_AROUND_MINS = [0, 0.5, 1, 2, 5, 10];

const intervalLabel = (h: number) => (h === 24 ? 'Once a day' : h === 48 ? 'Every 2 days' : h === 168 ? 'Once a week' : `Every ${h} hours`);

/**
 * Search: shows only the settings whose words match, by hiding the rest of the page (a heading
 * that matches shows its whole section). Returns how many settings matched.
 */
function filterSettings(root: HTMLElement, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (el: Element) => {
    const t = (el.textContent ?? '').toLowerCase() + ' ' + ((el as HTMLElement).getAttribute?.('aria-label') ?? '').toLowerCase();
    return words.every((w) => t.includes(w));
  };
  const all = [...root.children] as HTMLElement[];
  for (const el of root.querySelectorAll<HTMLElement>('[data-hide]')) delete el.dataset.hide;
  if (!words.length) return -1;
  let count = 0;
  let section: HTMLElement[] = [];
  let heading: HTMLElement | undefined;
  const finish = () => {
    const whole = heading ? hits(heading) : false;
    let any = false;
    for (const el of section) {
      if (whole) {
        any = true;
        count++;
        continue;
      }
      if (el.classList.contains('card')) {
        let inCard = false;
        for (const child of [...el.children] as HTMLElement[]) {
          if (hits(child)) {
            inCard = true;
            count++;
          } else child.dataset.hide = '1';
        }
        if (!inCard) el.dataset.hide = '1';
        any ||= inCard;
      } else if (hits(el)) {
        any = true;
        count++;
      } else el.dataset.hide = '1';
    }
    if (heading && !any) heading.dataset.hide = '1';
  };
  for (const el of all) {
    if (el.dataset.keep || el.tagName === 'HEADER' || el.classList.contains('topbar')) continue;
    if (el.dataset.searchHide) {
      el.dataset.hide = '1';
      continue;
    }
    if (el.classList.contains('eyebrow')) {
      finish();
      section = [];
      heading = el;
    } else section.push(el);
  }
  finish();
  return count;
}

/** "Erase everything and start fresh" (0.8.2): asks twice, then wipes this phone and reopens Restock. */
async function eraseAll() {
  // 0.8.5: the owner phone can't just vanish, or nobody could add or remove phones again.
  if (isNative()) {
    const info = await syncInfo().catch(() => undefined);
    if (info?.paired && info.isOwner && (info.members ?? []).some((m) => !m.me)) {
      await confirmAction('Make another phone the owner first', {
        detail:
          'This is the household\'s owner phone. In Settings → Sync and backups → Phones and sharing, tap another phone and choose "Make this the owner phone", sync once, then erase this one. Or remove the other phones first.',
        action: 'OK',
        danger: false,
      });
      return;
    }
  }
  const first = await confirmAction('Erase everything on this phone?', {
    detail:
      "Every item, list, price, card, receipt and setting is deleted from this phone, you're signed out of the shops inside Restock, and it leaves your household if it's in one (and your Restock server, where what it moved stays). Other phones keep their things. Export a backup first if you might want any of it back.",
    action: 'Continue',
  });
  if (!first) return;
  const second = await confirmAction('Are you sure? This deletes all your data', {
    detail: "Restock will start again from its first screen. This can't be undone.",
    action: 'Erase everything',
  });
  if (!second) return;
  if (isNative()) {
    // 0.9.2: off the Restock server first, without bringing its photos back (they'd only be erased).
    await RestockNative.syncStopServer({ bringBack: false }).catch(() => undefined);
    // Tell the household this phone is going, if it's here; then stop everything in the background.
    await RestockNative.syncLeave().catch(() => undefined);
    await RestockNative.eraseNative().catch(() => undefined);
    await RestockNative.scheduleChecks({ enabled: false, intervalHours: 12 }).catch(() => undefined);
    await RestockNative.scheduleRecalls({ enabled: false }).catch(() => undefined);
    for (const dir of ['receipts', 'backups', 'cards']) await RestockNative.deleteAppDir({ path: dir }).catch(() => undefined);
  }
  await eraseEverything();
  try {
    localStorage.clear();
  } catch {
    // nothing kept there
  }
  // Let the last write land (the browser preview saves a moment later), then open Restock fresh.
  await new Promise((r) => setTimeout(r, 800));
  window.location.reload();
}

/**
 * Settings' own pages, each opened from a row on the main list (0.9.13). 0.9.14: grouped for
 * someone who just wants it to work: Your shops, Everyday, Your phone, Help, then Advanced.
 */
export type SettingsPage = 'list' | 'prices' | 'alerts' | 'data' | 'sync' | 'look' | 'privacy' | 'help' | 'about' | 'advanced';
export const SETTINGS_PAGES: Record<SettingsPage, { title: string }> = {
  list: { title: 'Shopping list and receipts' },
  prices: { title: 'Prices and deals' },
  alerts: { title: 'Notifications' },
  data: { title: 'Your data' },
  sync: { title: 'Sync and backups' },
  look: { title: 'Look and accessibility' },
  privacy: { title: 'Privacy and sharing' },
  help: { title: 'Help' },
  about: { title: 'About' },
  advanced: { title: 'Advanced' },
};
/** The main list's groups of rows, in order (Feedback sits in Help; Advanced is last). */
const GROUPS: { title: string; pages: (SettingsPage | 'cards' | 'feedback')[] }[] = [
  { title: 'Everyday', pages: ['list', 'prices', 'alerts', 'cards'] },
  { title: 'Your phone', pages: ['data', 'sync', 'privacy', 'look'] },
  { title: 'Help', pages: ['help', 'feedback', 'about'] },
];

export function SettingsScreen({ page }: { page?: SettingsPage } = {}) {
  useSettingsDraft(); // 0.9.5 (save)
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const cardCount = useLive(async () => (await allCards()).length + (await allGiftCards()).length, []); // 0.9.6 (cards): loyalty and gift
  const sync = useLive(syncInfo, []);
  // 0.9.3: Sync now in Sync and backups shows its result straight away.
  const [syncNowInfo, setSyncShown] = useState<SyncInfo>();
  const syncShown = syncNowInfo ?? sync;
  // …until the next look: then what's live again (leaving the household, say, shows straight away).
  useEffect(() => setSyncShown(undefined), [sync]);
  // 0.9.1: how much price history a backup holds.
  const span = useLive(priceHistorySpan, []);
  const fileRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState<'privacy' | 'disclaimer'>();
  const [picking, setPicking] = useState<BackupSummary>();
  const [testing, setTesting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<number>();
  const screen = useRef<HTMLDivElement>(null);
  // 0.9.3: Home Assistant's row says whether it's on for this phone, or which phone does it.
  const ha = useLive(getHaConfig, []);
  const haWho = useLive(haPhone, []);
  const haSummary =
    haWho?.inHousehold && haWho.device && !haWho.mine
      ? `Syncs through ${phoneLabel(haWho.name)}`
      : ha?.enabled
        ? `On for this phone · ${ha.entity}`
        : 'Your shopping list in Home Assistant, both ways';
  useEffect(() => {
    if (!screen.current) return;
    // Searching looks inside the rows that fold away too.
    if (query.trim()) screen.current.querySelectorAll('details').forEach((d) => (d.open = true));
    setMatches(filterSettings(screen.current, query));
  }, [query, settings, cardCount]);
  if (!settings) return <div className="screen" />;
  // 0.9.13: searching the main list looks through every page (Advanced's testing features only once they're on).
  const all = !page && !!query.trim();
  const on = (p: SettingsPage | 'hub') => (p === 'hub' ? !page : page === p || all);
  const pageSub = (p: SettingsPage | 'cards' | 'feedback'): string => {
    switch (p) {
      case 'list':
        return `Shop around, receipts${settings.receipts.enabled ? ' (on)' : ''}`;
      case 'prices':
        return `Price checks, how far back (${historyLabel(settings.historyWeeks)}), how a sale is judged`;
      case 'alerts':
        return `Deals, catalogue day, recalls${settings.recalls?.enabled ? ' (on)' : ''}`;
      case 'cards':
        return cardCount ? `${cardCount} added` : 'Loyalty and gift cards';
      case 'data':
        return 'Spending, prices over time, what’s stored';
      case 'sync':
        return 'Household, Restock server, Phone sharing, Home Assistant, backups';
      case 'look':
        return 'Colours, app icon, text size, widgets';
      case 'privacy':
        return `What stays on this phone · Shared prices ${sharedOn(settings) ? 'on' : 'off'} · permissions`;
      case 'help':
        return 'Tour, sample items, check your shops are working';
      case 'feedback':
        return 'Good or bad, tell us what works and what doesn’t. Screenshots welcome.';
      case 'about':
        return `Restock ${version}, updates, credits, fine print`;
      default:
        return '';
    }
  };
  const open = (p: SettingsPage | 'cards' | 'feedback') =>
    p === 'cards' ? nav.push({ name: 'cards' }) : p === 'feedback' ? nav.push({ name: 'feedback' }) : nav.push({ name: 'settings', page: p });
  const titleOf = (p: SettingsPage | 'cards' | 'feedback') => (p === 'cards' ? 'Cards' : p === 'feedback' ? 'Send feedback' : SETTINGS_PAGES[p].title);

  const row = (title: string, sub: string, onClick: () => void) => (
    <button className="row" onClick={onClick}>
      <span className="grow">
        <span className="title">{title}</span>
        <span className="small">{sub}</span>
      </span>
      <Icon name="chevron" size={18} />
    </button>
  );

  return (
    <div className="screen" ref={screen}>
      <TopBar title={page ? SETTINGS_PAGES[page].title : 'Settings'} />
      {!page && (
        <>
          <div className="settings-search" data-keep="1">
            <Icon name="search" size={18} />
            <input
              className="input"
              type="search"
              placeholder="Search settings"
              aria-label="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="icon-btn" aria-label="Clear search" onClick={() => setQuery('')}>
                <Icon name="close" size={16} />
              </button>
            )}
          </div>
          {query.trim() && matches === 0 && (
            <p className="small" data-keep="1">
              No settings match "{query.trim()}". Try another word, like "alerts", "colour" or "backup".
            </p>
          )}
        </>
      )}
      {on('hub') && (
        <>
          <div className="card flush">
            {row('Setup', `${TILES.filter((t) => tileStatus(settings, t.id, syncShown).ok).length} of ${TILES.length} done`, () => nav.push({ name: 'setup' }))}
          </div>
          <div className="eyebrow" id="s-stores">
            Your shops
          </div>
          <div className="card flush">
            {/* 0.9.8: one row per tab of My shops; sign-ins and stock are on each shop's own row there. 0.9.14: each says its tab. */}
            {row('Supermarkets (Pantry tab)', `${shopSummary(settings, 'pantry')} · ${shopAccountsSummary(settings)}`, () => nav.push({ name: 'stores', section: 'pantry' }))}
            {/* 0.10.0: Keg and Health are beta (BETA_NOTE): the same as Groceries, less tested. */}
            {row('Bottle shops (Keg tab) · Beta', shopSummary(settings, 'keg'), () => nav.push({ name: 'stores', section: 'keg' }))}
            {row('Chemists (Health tab) · Beta', shopSummary(settings, 'pharmacy'), () => nav.push({ name: 'stores', section: 'pharmacy' }))}
            {/* 0.10.3 (beta): Baby and Pets, any shops. */}
            {row('Baby tab · Beta', shopSummary(settings, 'baby'), () => nav.push({ name: 'stores', section: 'baby' }))}
            {row('Pets tab · Beta', shopSummary(settings, 'pets'), () => nav.push({ name: 'stores', section: 'pets' }))}
          </div>
        </>
      )}
      {/* 0.9.13: everything else is a row that opens its own page. */}
      {!page && !query.trim() && (
        <>
          {GROUPS.map((g) => (
            <Fragment key={g.title}>
              <div className="eyebrow" data-search-hide="1">
                {g.title}
              </div>
              <div className="card flush" data-search-hide="1">
                {g.pages.map((p) => (
                  <Fragment key={p}>{row(titleOf(p), pageSub(p), () => open(p))}</Fragment>
                ))}
              </div>
            </Fragment>
          ))}
          <div className="card flush" data-search-hide="1">
            {row(SETTINGS_PAGES.advanced.title, settings.beta?.enabled ? 'Testing features on · diagnostics, price helper phone · erase everything' : 'Testing features and diagnostics · erase everything', () =>
              open('advanced'),
            )}
          </div>
        </>
      )}
      {on('list') && (
        <>
          <div className="eyebrow" id="s-list">
            Shopping list
          </div>
          <div className="card flush">
            <label className="row field-row">
              <span className="grow">
                <span className="title">Shop around if it saves at least</span>
                <span className="small">
                  Below this, a shop that has everything on your list is recommended instead, so you're not making extra stops for a few cents.
                </span>
                <select
                  className="input"
                  value={String(settings.shopAroundMin ?? 1)}
                  onChange={(e) => void updateSettings({ shopAroundMin: Number(e.target.value) })}
                  aria-label="Shop around if it saves at least"
                >
                  {SHOP_AROUND_MINS.map((v) => (
                    <option key={v} value={String(v)}>
                      {v === 0 ? 'Any saving' : money(v)}
                      {v === 1 ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            {/* 0.10.2: how shopping mode starts (picking one there saves it here too). */}
            <label className="row field-row">
              <span className="grow">
                <span className="title">In shopping mode, start with</span>
                <span className="small">How each shop's things are sorted when you start shopping. Aisle numbers come from your Coles branch.</span>
                <select
                  className="input"
                  value={settings.shopSort ? `${settings.shopSort.by}${settings.shopSort.down ? '-down' : ''}` : 'aisle'}
                  onChange={(e) => {
                    const v = e.target.value;
                    void updateSettings({ shopSort: { by: v.startsWith('aisle') ? 'aisle' : (v as 'category' | 'az'), ...(v === 'aisle-down' ? { down: true } : {}) } });
                  }}
                  aria-label="In shopping mode, start with"
                >
                  <option value="aisle">Aisle, 1 to 50 (default)</option>
                  <option value="aisle-down">Aisle, 50 to 1</option>
                  <option value="category">Category (your aisle groups)</option>
                  <option value="az">A–Z</option>
                </select>
              </span>
            </label>
          </div>
          <div className="eyebrow" id="s-receipts">
            Receipts
          </div>
          <ReceiptsSettings settings={settings} />
        </>
      )}
      {on('prices') && (
        <>
          <div className="eyebrow" id="s-checks">
            Price checks
          </div>
          <PriceCheckSettings settings={settings} />
          {/* 0.9.14: one setting for how far back, and Judge new items from day one under it (DayOne.tsx). */}
          <div className="eyebrow" id="s-history">
            Price history
          </div>
          <PriceHistorySettings settings={settings} />
          <Explain title="How Restock judges a sale">
            {/* 0.9.0: says what the code does (verdict.ts computeStats and judge). */}
            <p>
              Each product's <strong>usual price</strong> is the middle of the regular prices Restock has seen for it over the history you keep (
              {historyLabel(settings.historyWeeks)}
              {settings.historyWeeks === 8 ? ' unless you change it' : ''}). Until it has seen one at a regular price, it goes by the shop's "was" price.
              {sharedOn(settings) ? ' For its first 4 weeks or so, shared prices fill in.' : ''} Member prices only count if you've added that
              shop's card.
            </p>
            <p>
              Only this week's specials (Wednesday to Tuesday) count as on special. An older special, or a lower price last checked over {STALE_DAYS} days
              ago, isn't called a deal until prices are checked again.
            </p>
            <p>
              Small saving: any drop under {GOOD_SALE * 100}% · On special: {GOOD_SALE * 100}%+ · Great deal: {GREAT_SALE * 100}%+. "Wait" means it's been at
              least 5% cheaper recently (never at half price or better). Each pantry item picks which of these send an alert.
            </p>
            <p>
              Multi-buys like "2 for $5" count at their price each ($2.50), and your shopping list only uses that price when you're buying the full set.
              Swaps to bigger packs only happen for items you've said yes to bulk packs.
            </p>
          </Explain>
        </>
      )}
      {on('alerts') && (
        <>
          <div className="eyebrow" id="s-alerts">
            Notifications
          </div>
          <NotificationSettings settings={settings} />
          <div className="eyebrow" id="s-recalls">
            Recall alerts
          </div>
          <div className="card flush">{row('Recall alerts', recallSummary(settings), () => nav.push({ name: 'recalls' }))}</div>
        </>
      )}
      {/* 0.9.14: spending, prices over time and what's stored (YourData.tsx), as on the server's Data tab. */}
      {page === 'data' && <YourData />}
      {on('sync') && (
        <>
          {/* 0.9.1: sync and backups in one place. Sync keeps phones the same; backups are how you go back. */}
          <div className="eyebrow" id="s-sync">
            Sync and backups
          </div>
          {/* 0.9.3: the household on top, how the phones sync, then backups. Any of the three counts as kept elsewhere. */}
          <SyncOverview settings={settings} info={syncShown} onInfo={setSyncShown} haSummary={serverMode ? undefined : haSummary} />
          {/* 0.10.0: with a Restock server, Your data can show the household's figures from it. */}
          {syncShown?.server && syncShown.serverApi === 3 && (
            <div className="card flush">
              <label className="check">
                <input
                  type="checkbox"
                  className="switch"
                  checked={spendingOnServer(settings)}
                  onChange={async (e) => {
                    const server = e.target.checked;
                    await updateSettings({ yourData: { server } });
                    if (server)
                      await afterSave('spending', () =>
                        void sendSpendingToServer()
                          .then((n) => n && nav.toast(`Sent ${n} earlier purchase${n === 1 ? '' : 's'} to your Restock server`))
                          .catch((err) => nav.toast(err instanceof Error ? err.message : String(err))),
                      );
                  }}
                />
                <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <span className="title" style={{ fontSize: 15 }}>
                    Share my spending with the server
                  </span>
                  <span className="small">
                    {spendingOnServer(settings)
                      ? "On · Your data shows your household's spending from your Restock server, the same on every phone. This phone's earlier spending goes to it once."
                      : 'Off · Your data shows only what this phone worked out, and keeps it here.'}
                  </span>
                </span>
              </label>
            </div>
          )}
          <p className="small group-note">Sync keeps your phones the same, mistakes included. Backups let you go back.</p>

          <h3 className="group-head" id="s-backups">
            Backups
          </h3>
          <div className="card flush">
            <button className="row" onClick={() => setExporting(true)}>
              <span className="grow">
                <span className="title">Export a backup</span>
                <span className="small">
                  Pick what goes in: everything, or just some tabs, lists, cards or settings. {pricesIn(settings, span)} Keep it private.
                </span>
              </span>
            </button>
          </div>
          <AutoBackupSettings settings={settings} />
          <div className="card flush">
            <button className="row" onClick={() => fileRef.current?.click()}>
              <span className="grow">
                <span className="title">Restore a backup</span>
                <span className="small">Pick what to bring back: pantry, shopping list, cards or settings</span>
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                try {
                  setPicking(await readBackupFile(file));
                } catch (err) {
                  nav.toast(err instanceof Error ? err.message : 'Could not read that file');
                }
              }}
            />
            <button
              className="row"
              onClick={async () => {
                try {
                  await shareCsv();
                } catch (e) {
                  nav.toast(`Couldn't make the spreadsheets: ${e instanceof Error ? e.message : e}`);
                }
              }}
            >
              <span className="grow">
                <span className="title">Export as spreadsheets (CSV)</span>
                <span className="small">Your pantry, shopping list and price history, for Excel, Google Sheets, LibreOffice or Numbers.</span>
              </span>
            </button>
            {/* 0.9.8: what only the server's web page does is shown here too, greyed, saying where. */}
            {!serverMode && (
              <div className="row" aria-disabled="true" style={{ opacity: 0.55 }}>
                <span className="grow">
                  <span className="title">Import data</span>
                  <span className="small">On your Restock server's web page (Data tab): adds products and prices from a file.</span>
                </span>
              </div>
            )}
          </div>
        </>
      )}
      {on('look') && (
        <>
          <div className="eyebrow" id="s-look">
            Look and colours
          </div>
          <LookSettings settings={settings} />
          <div className="eyebrow" id="s-a11y">
            Accessibility
          </div>
          <AccessibilitySettings settings={settings} />
          <div className="eyebrow" id="s-widgets">
            Home screen widgets
          </div>
          <Fold title="Home screen widgets" sub="Deals, shopping list and quick actions">
            <WidgetSettings settings={settings} />
          </Fold>
        </>
      )}
      {on('privacy') && (
        <>
          <PrivacySharing settings={settings} />
          <div className="card flush">
            {row('Permissions', 'Notifications, alarms, camera, location', () => nav.push({ name: 'permissions' }))}
            {row('Privacy policy', `Updated ${legal.updated}`, () => setReading('privacy'))}
            {row('Fine print', 'Not affiliated with the shops, no warranty', () => setReading('disclaimer'))}
          </div>
        </>
      )}
      {on('help') && (
        <>
          <div className="eyebrow" id="s-tour">
            Try it out
          </div>
          <div className="card flush">
            {settings.demoLoaded ? (
              <button
                className="row"
                onClick={async () => {
                  await removeDemo();
                  nav.toast('Sample items removed');
                }}
              >
                <span className="grow">
                  <span className="title" style={{ color: 'var(--red-ink)' }}>
                    Remove sample items
                  </span>
                  <span className="small">Your own items stay</span>
                </span>
              </button>
            ) : (
              <button
                className="row"
                onClick={async () => {
                  await loadDemo();
                  nav.toast(serverMode ? 'Sample items added, in this browser only: they never go to your phones' : 'Sample items added');
                }}
              >
                <span className="grow">
                  <span className="title">Add sample items</span>
                  <span className="small">Seven made-up items with price history, to see how verdicts work</span>
                </span>
              </button>
            )}
            <button
              className="row"
              onClick={async () => {
                nav.pop();
                await startTour();
              }}
            >
              <span className="grow">
                <span className="title">Take the tour again</span>
                <span className="small">A look round with sample items, removed when it ends</span>
              </span>
            </button>
          </div>
          <div className="eyebrow" id="s-help">
            Something not working?
          </div>
          <div className="card flush">
            {row('Check my shops are working', 'Tries a search at each of your shops and shows what happens', () => setTesting(true))}
            {row('Send feedback', 'Good or bad, tell us what works and what doesn’t. Screenshots welcome.', () => nav.push({ name: 'feedback' }))}
            <a className="row" href="https://github.com/d-plenty/Restock/issues" target="_blank" rel="noreferrer">
              <span className="grow">
                <span className="title">Restock on GitHub</span>
                <span className="small">Known problems, and reporting one if you have a GitHub account</span>
              </span>
              <Icon name="external" size={18} />
            </a>
          </div>
        </>
      )}
      {on('about') && (
        <>
          <div className="eyebrow" id="s-about">
            Version and updates
          </div>
          <div className="card flush">
            <UpdateRows settings={settings} />
            {row('Privacy policy', `Updated ${legal.updated}`, () => setReading('privacy'))}
            {row('Fine print', 'Not affiliated with the shops, no warranty', () => setReading('disclaimer'))}
          </div>
          <div className="eyebrow" id="s-credits">
            Credits
          </div>
          <Fold title="Credits and thanks" sub="The open data and open-source code Restock is built with">
            <Credits />
          </Fold>
          <div className="eyebrow" id="s-soon">
            Coming soon
          </div>
          <Fold title="What's planned" sub="Stock at home, spending, hosted sync, iPhone and more">
            <ComingSoon />
          </Fold>
        </>
      )}
      {(page === 'advanced' || (all && settings.beta?.enabled)) && (
        <BetaGate settings={settings} searching={all}>
          <div className="eyebrow" id="s-diag">
            Diagnostics
          </div>
          <div className="card flush">
            {row('Diagnostics', 'Shop test, what went wrong lately, the search test and search details', () => nav.push({ name: 'diagnostics' }))}
            <details className="pick-more fold-inline">
              <summary>
                <span className="grow">Shop connections</span>
                <Icon name="chevron" size={18} />
              </summary>
              <label className="check">
                <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <span className="title" style={{ fontSize: 15 }}>
                    Shop connections
                  </span>
                  <span className="small">
                    Automatic asks shops directly and switches to a hidden in-app browser if that fails. Coles always uses the browser.
                  </span>
                </span>
                <select
                  className="input"
                  style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
                  value={settings.connection}
                  onChange={(e) => updateSettings({ connection: e.target.value as Settings['connection'] })}
                  aria-label="Shop connections"
                >
                  <option value="auto">Automatic</option>
                  <option value="browser">Always browser</option>
                </select>
              </label>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <span className="grow" style={{ minWidth: 200 }}>
                  <span className="title">Shop keeps saying it's blocked?</span>
                  <span className="small">Unblock it: open its website here once and do its check (a tick box or puzzle) yourself.</span>
                </span>
              </div>
              {shopGroups(settings).map(({ section, chains }) => (
                <div key={section} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 14px 12px' }}>
                  <span className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icon name={section} size={15} /> {GROUP_LABEL[section]}
                  </span>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {chains.map((c) => (
                      <UnblockButton key={c} chain={c} small label={chainName(c)} />
                    ))}
                  </span>
                </div>
              ))}
            </details>
          </div>
          {/* 0.9.11: a spare phone that collects Coles and Woolworths prices for the shared history. */}
          <Fold title="Price helper phone" sub={settings.priceHelper?.enabled ? 'On' : 'Off'}>
            <PriceHelperSettings settings={settings} />
          </Fold>
        </BetaGate>
      )}
      {(page === 'advanced' || all) && (
        <>
          <div className="eyebrow" id="s-erase">
            Start fresh
          </div>
          <div className="card flush">
            <button className="row" onClick={() => void eraseAll()}>
              <Icon name="trash" size={18} />
              <span className="grow">
                <span className="title" style={{ color: 'var(--red-ink)' }}>
                  Erase everything and start fresh
                </span>
                <span className="small">Deletes all your items, lists, prices, cards, receipts and settings from this phone. It can't be undone.</span>
              </span>
            </button>
          </div>
        </>
      )}
      {(!page || page === 'about') && (
        <>
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
            <Logo size={40} />
          </div>
          <p className="small" style={{ textAlign: 'center' }}>
            Restock {version} release candidate · free and open source
            <br />
            Your data stays on this phone, and your household's phones and server only if you share
            <br />
            <a href="https://github.com/d-plenty/Restock" target="_blank" rel="noreferrer">
              Source code and bug reports on GitHub
            </a>
          </p>
        </>
      )}
      {/* 0.9.5 (save): "Unsaved changes · Save settings", above the tabs. */}
      <SaveBar />
      {reading && <LegalSheet doc={reading} onClose={() => setReading(undefined)} />}
      {testing && <ConnectionsSheet settings={settings} onClose={() => setTesting(false)} />}
      {exporting && <ExportSheet onClose={() => setExporting(false)} onDone={(m) => nav.toast(m)} />}
      {picking && (
        <RestoreSheet
          summary={picking}
          onClose={() => setPicking(undefined)}
          onDone={(what) => {
            setPicking(undefined);
            nav.toast(`Restored your ${what}`);
            // 0.8.2: backups never hold the household; offer to join it again.
            void syncInfo().then(async (i) => {
              if (i.paired || !isNative()) return;
              const join = await confirmAction('Sync this phone with your household?', {
                detail: "Backups don't include the household, so a restored phone joins again with a new code from the owner phone.",
                action: 'Join a household',
                danger: false,
              });
              if (join) nav.push({ name: 'sync' });
            });
          }}
        />
      )}
    </div>
  );
}

/**
 * 0.9.13: Settings → Privacy and sharing. What stays on this phone, what goes where, and 0.10.0's
 * Shared prices (SharedPrices.tsx): one switch for Judge new items from day one and Send prices back.
 */
function PrivacySharing({ settings }: { settings: Settings }) {
  const nav = useNav();
  return (
    <>
      <div className="eyebrow" id="s-privacy">
        What stays on this phone
      </div>
      <div className="card">
        <p className="small" style={{ margin: 0 }}>
          Your pantry, shopping lists, cards, receipts, what you spend, the prices you type in and the items you track stay on this phone. They only go
          to your own household's phones, your own Restock server or Home Assistant if you set those up (Sync and backups), and into backups you make.
        </p>
      </div>
      {/* 0.10.0: one switch for getting and sending shared prices (SharedPrices.tsx). */}
      <SharedPricesSection settings={settings} />
      <div className="eyebrow">Feedback</div>
      <div className="card flush">
        <button className="row" onClick={() => nav.push({ name: 'feedback' })}>
          <span className="grow">
            <span className="title">Feedback</span>
            <span className="small">Only what you send, when you send it, to Restock's own server (restock-prices.plenty.family)</span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
      </div>
    </>
  );
}

/**
 * Settings → Advanced (0.9.13's Beta and development). A note, and Turn this on (this phone only);
 * then diagnostics, shop connections and the price helper phone. Erase everything is under it,
 * outside the switch, so it's always there.
 */
function BetaGate({ settings, searching, children }: { settings: Settings; searching: boolean; children: ReactNode }) {
  const on = !!settings.beta?.enabled;
  const set = (enabled: boolean) => void updateSettings({ beta: { enabled } }, { local: true });
  if (searching) return <>{on ? children : null}</>;
  return (
    <>
      <div className="card">
        <p className="small" style={{ margin: 0 }}>
          Testing features and tools for fixing problems. They may not always work right, and some are for people comfortable with the technical
          side: diagnostics, shop connections and the price helper phone. You don't need any of them to use Restock. Turn them off again any time.
        </p>
        {!on && (
          <button className="btn primary" style={{ marginTop: 12 }} onClick={() => set(true)}>
            Turn on testing features
          </button>
        )}
      </div>
      {on && (
        <>
          {children}
          <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={() => set(false)}>
            Turn testing features off
          </button>
        </>
      )}
    </>
  );
}

/** Try each store and show whether it works, how long it took, or what went wrong. */
const GROUP_LABEL: Record<Section, string> = { pantry: 'Groceries', keg: 'Keg', pharmacy: 'Health', baby: 'Baby', pets: 'Pets' };

/** The shops you use, by tab (one per website, so Liquorland's three shops show once). Tabs that are off are left out. */
function shopGroups(settings: Settings): { section: Section; chains: StoreChain[] }[] {
  return activeSections(settings)
    .map((section) => ({ section, chains: searchChainsIn(settings.enabledChains, section) }))
    .filter((g) => g.chains.length > 0);
}

export function ConnectionsSheet({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const groups = shopGroups(settings);
  const chains: StoreChain[] = groups.flatMap((g) => g.chains);
  const [results, setResults] = useState<ConnectionTest[]>();
  const health = useLive(getHealth, []);
  const run = async () => {
    setResults(undefined);
    setResults(await testConnections(chains, Object.fromEntries(chains.map((c) => [c, settings.stores[c]?.storeId]))));
  };
  useEffect(() => {
    void run();
  }, []);
  return (
    <Sheet title="Test connections" onClose={onClose}>
      <p className="small">
        Restock searches each shop the same way it does when you add an item: supermarkets for "milk", bottle shops for "beer" and chemists for
        "paracetamol".
      </p>
      {groups.map(({ section, chains: list }) => (
        <div key={section} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name={section} size={15} /> {GROUP_LABEL[section]}
          </div>
          <div className="card flush">
            {list.map((c) => {
              const r = results?.find((x) => x.chain === c);
              const h = health?.[c];
              return (
                <div key={c} className="row" style={{ alignItems: 'flex-start' }}>
                  <span style={{ width: 24, paddingTop: 2 }}>
                    {!r ? (
                      <span className="spinner" aria-label="Testing" />
                    ) : r.ok ? (
                      <Icon name="check" size={20} />
                    ) : (
                      <Icon name="close" size={20} />
                    )}
                  </span>
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ChainDot chain={c} /> {chainName(c)}
                    </span>
                    <span className="small">
                      {!r
                        ? 'Testing…'
                        : r.ok
                          ? `Working: ${r.count} products in ${(r.ms / 1000).toFixed(1)} s`
                          : r.blocked
                            ? "Blocked: its website is checking for bots. That's its check, not Restock's."
                            : `Not working: ${r.error}`}
                    </span>
                    {h?.lastOk && <span className="small">Last worked {timeAgo(h.lastOk)}</span>}
                    {r && r.blocked && <UnblockButton chain={c} small onWorked={run} />}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {!chains.length && <p className="small">No shops picked yet. Choose them in Settings → My shops.</p>}
      <button className="btn" disabled={!results} onClick={run}>
        <Icon name="refresh" size={18} /> Test again
      </button>
      <p className="small">
        Still failing? Try Shop connections → Always use the browser, or Unblock the shop and do its check if it asks. If a shop keeps
        failing, please{' '}
        <a href="https://github.com/d-plenty/Restock/issues/new/choose" target="_blank" rel="noreferrer">
          report it on GitHub
        </a>{' '}
        with the error above.
      </p>
    </Sheet>
  );
}

/** Background price checks: on or off, how often, which day (Settings, and the setup tile, 0.8.0). */
export function PriceCheckSettings({ settings }: { settings: Settings }) {
  const setChecks = async (patch: { hours?: number; on?: boolean; weekday?: number; time?: string }) => {
    const s = await updateSettings({
      ...(patch.hours !== undefined ? { checkIntervalHours: patch.hours } : {}),
      ...(patch.weekday !== undefined ? { checkWeekday: patch.weekday } : {}),
      ...(patch.time !== undefined ? { checkTime: patch.time } : {}),
      ...(patch.on !== undefined ? { sync: { ...settings.sync, backgroundActivity: patch.on } } : {}),
    });
    // 0.9.5 (save): on a settings screen, once it's saved.
    await afterSave('checks', (saved) => syncBackgroundSchedule(saved).catch(() => undefined), s);
  };

  return (
    <>
      <div className="card flush">
        <label className="check">
          <input type="checkbox" className="switch" checked={settings.sync.backgroundActivity} onChange={(e) => setChecks({ on: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Check prices in the background
            </span>
            <span className="small">Only on a network connection and when the battery isn't low.</span>
          </span>
        </label>
        <label
          className="check"
          style={settings.sync.backgroundActivity ? undefined : { opacity: 0.5 }}
          aria-disabled={!settings.sync.backgroundActivity || undefined}
        >
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              How often
            </span>
            <span className="small">Android may run it a few minutes late to save battery.</span>
          </span>
          <select
            className="input"
            style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
            value={settings.checkIntervalHours}
            disabled={!settings.sync.backgroundActivity}
            onChange={(e) => setChecks({ hours: parseInt(e.target.value, 10) })}
            aria-label="How often to check prices"
          >
            {CHECK_INTERVALS.map((h) => (
              <option key={h} value={h}>
                {intervalLabel(h)}
                {h === 24 ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label
          className="check"
          style={settings.sync.backgroundActivity ? undefined : { opacity: 0.5 }}
          aria-disabled={!settings.sync.backgroundActivity || undefined}
        >
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Price check time
            </span>
            <span className="small">
              {settings.checkIntervalHours === 6 || settings.checkIntervalHours === 12
                ? `Runs at ${dailyTimes({ intervalHours: settings.checkIntervalHours, time: settings.checkTime }).join(', ')}.`
                : 'Your phone\'s own time. If the phone is off then, it checks soon after it is back.'}{' '}
              Checking by hand doesn't change it.
            </span>
          </span>
          <input
            type="time"
            className="input"
            style={{ width: 'auto', height: 44, padding: '0 10px', fontSize: 15 }}
            value={settings.checkTime ?? DEFAULT_CHECK_TIME}
            disabled={!settings.sync.backgroundActivity}
            onChange={(e) => {
              if (isCheckTime(e.target.value)) void setChecks({ time: e.target.value });
            }}
            aria-label="Price check time"
          />
        </label>
        {settings.checkIntervalHours >= 168 && (
          <label
            className="check"
            style={settings.sync.backgroundActivity ? undefined : { opacity: 0.5 }}
            aria-disabled={!settings.sync.backgroundActivity || undefined}
          >
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Which day
              </span>
              <span className="small">Wednesday recommended: that's when new specials start.</span>
            </span>
            <select
              className="input"
              style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
              value={settings.checkWeekday}
              disabled={!settings.sync.backgroundActivity}
              onChange={(e) => setChecks({ weekday: parseInt(e.target.value, 10) })}
              aria-label="Day for weekly price checks"
            >
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </>
  );
}

/** Which alerts Restock sends (Settings, and the setup tile, 0.8.0). */
export function NotificationSettings({ settings }: { settings: Settings }) {
  const setAlerts = async (patch: Partial<Settings['alerts']>) => {
    // Turning an alert on is the moment to ask for notifications.
    if (Object.values(patch).some((v) => v === true)) await ensureNotificationPermission().catch(() => false);
    const s = await updateSettings({ alerts: { ...settings.alerts, ...patch } });
    // 0.9.5 (save): on a settings screen, once it's saved.
    await afterSave('reminders', (saved) => scheduleReminders(saved).catch(() => undefined), s);
  };

  return (
    <>
      <div className="card flush">
        <label className="check">
          <input type="checkbox" className="switch" checked={settings.alerts.catalogueDay} onChange={(e) => setAlerts({ catalogueDay: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Weekly deals summary
            </span>
            <span className="small">
              Which of your items are on special and roughly what you'd save, after the first price check that day. Wednesday is when new specials
              start.
            </span>
          </span>
          <select
            className="input"
            style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
            value={settings.alerts.catalogueWeekday}
            onChange={(e) => setAlerts({ catalogueWeekday: parseInt(e.target.value, 10) })}
            aria-label="Roundup day"
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d.slice(0, 3)}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" className="switch" checked={settings.alerts.daily} onChange={(e) => setAlerts({ daily: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Daily reminder
            </span>
            <span className="small">A nudge to open the app and check prices.</span>
          </span>
          <input
            type="time"
            className="input"
            style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
            value={settings.alerts.dailyTime}
            onChange={(e) => setAlerts({ dailyTime: e.target.value || '07:30' })}
            aria-label="Reminder time"
          />
        </label>
        <label className="check">
          <input type="checkbox" className="switch" checked={settings.alerts.greatDeals} onChange={(e) => setAlerts({ greatDeals: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Great deals, straight away
            </span>
            <span className="small">When a price check finds a deal that matches an item's alert setting, or an item is under its target price.</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" className="switch" checked={settings.alerts.stockUpTips} onChange={(e) => setAlerts({ stockUpTips: e.target.checked })} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Stock-up tips
            </span>
            <span className="small">On deals for things that only go on special every few weeks: "a good time to stock up".</span>
          </span>
        </label>
      </div>
    </>
  );
}

function shopAccountsSummary(settings: Settings): string {
  // 0.9.8: only the shops you're signed in to, so the line stays short.
  const on = (['woolworths', 'coles', 'costco'] as const).filter((c) => settings.enabledChains.includes(c) && settings.accounts?.[c]?.signedIn);
  return on.length ? `Signed in to ${on.map((c) => ({ woolworths: 'Woolworths', coles: 'Coles', costco: 'Costco' })[c]).join(', ')}` : 'Not signed in to any shop';
}

/** A settings card that folds away until you open it (0.7.3), so the page isn't a wall of options. */
function Fold({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <details className="card flush fold">
      <summary className="row">
        <span className="grow">
          <span className="title">{title}</span>
          {sub && <span className="small">{sub}</span>}
        </span>
        <Icon name="chevron" size={18} />
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

/**
 * Updates from GitHub (0.7.3): check now, install a newer release (Android shows its own Install
 * screen), and an optional weekly check when Restock opens. Nothing is sent but the request itself.
 */
export function UpdateRows({ settings }: { settings: Settings }) {
  if (!SELF_UPDATE) return null;
  return <UpdateRowsOn settings={settings} />;
}

function UpdateRowsOn({ settings }: { settings: Settings }) {
  const nav = useNav();
  const [busy, setBusy] = useState<'check' | 'install'>();
  const [found, setFound] = useState<UpdateInfo>();
  const [error, setError] = useState<string>();
  const [notes, setNotes] = useState(false);
  const u = settings.updates;
  const check = async () => {
    setBusy('check');
    setError(undefined);
    try {
      const info = await checkForUpdate(version);
      setFound(info);
      // 0.9.5 (save): when it last looked isn't a setting: kept at once.
      const was = (await savedSettings()).updates;
      await saveNow({ updates: { notify: !!was?.notify, ...was, lastCheck: new Date().toISOString() } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const install = async () => {
    if (!found?.apkUrl) return;
    setBusy('install');
    setError(undefined);
    try {
      const r = await installUpdate(found.apkUrl);
      if (r === 'permission') nav.toast('Allow Restock to install apps, then come back and tap Update again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <span className="grow" style={{ minWidth: 180 }}>
          <span className="title">Check for updates</span>
          <span className="small">
            {found
              ? found.newer
                ? `Restock ${found.version} is ready. You have ${version}.`
                : `You have the latest version (${version}).`
              : `You have ${version}. New versions come from GitHub.`}
          </span>
        </span>
        {found?.newer && found.apkUrl ? (
          <button className="btn primary small" disabled={!!busy} onClick={() => void install()}>
            {busy === 'install' ? 'Downloading…' : 'Update'}
          </button>
        ) : (
          <button className="btn small" disabled={!!busy} onClick={() => void check()}>
            {busy === 'check' ? 'Checking…' : 'Check'}
          </button>
        )}
      </div>
      {found?.newer && (
        <div style={{ padding: '0 14px 12px', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {found.notes && (
            <button className="linkish small" style={{ padding: 0 }} onClick={() => setNotes(true)}>
              What's new in {found.version}
            </button>
          )}
          <a className="small" href={webLink(found.pageUrl) ?? RELEASES} target="_blank" rel="noreferrer">
            Open the release on GitHub
          </a>
        </div>
      )}
      {error && (
        <div className="banner amber" style={{ margin: '0 14px 12px', fontSize: 13 }}>
          {error} You can also download it from <a href={RELEASES}>GitHub Releases</a>.
        </div>
      )}
      <label className="check">
        <input type="checkbox" className="switch" checked={!!u?.notify} onChange={(e) => void updateSettings({ updates: { ...u, notify: e.target.checked } })} />
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title" style={{ fontSize: 15 }}>
            Tell me when there's an update
          </span>
          <span className="small">When you open Restock, it asks GitHub if there's a newer version, at most this often.</span>
        </span>
      </label>
      {u?.notify && (
        <label className="check">
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              How often
            </span>
          </span>
          <select
            className="input"
            style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 15 }}
            value={u.everyDays === 7 ? 7 : 1}
            aria-label="How often to check for updates"
            onChange={(e) => void updateSettings({ updates: { ...u, everyDays: e.target.value === '1' ? 1 : 7 } })}
          >
            <option value={1}>Every 24 hours (default)</option>
            <option value={7}>Every 7 days</option>
          </select>
        </label>
      )}
      {notes && found && (
        <Sheet title={`What's new in ${found.version}`} onClose={() => setNotes(false)}>
          <div className="small release-notes">{found.notes}</div>
        </Sheet>
      )}
    </>
  );
}
